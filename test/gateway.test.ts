import assert from "node:assert/strict";
import test from "node:test";

import { fromJsonSchema } from "@modelcontextprotocol/server";

import {
	McpConnectionManager,
	McpHubDefinition,
	McpHubManager,
	acceptedContent,
	defineGateway,
	definePrompt,
	defineResource,
	defineResourceTemplate,
	defineServer,
	defineTool,
	inProcessConnection,
	inputRequired,
	jsonResult,
	promptResult,
	textContent,
	toolResult,
	userMessage,
	type AnyMcpCapabilityDefinition,
	type ServerContext,
} from "../src/index.ts";
import { createTestClient, forEachEra } from "./helpers/in-process.ts";

const searchSchema = fromJsonSchema<{ q: string }>({
	type: "object",
	properties: { q: { type: "string" } },
	required: ["q"],
});

function upstream(label: string, extra: readonly AnyMcpCapabilityDefinition[] = []) {
	return defineServer(
		{ name: `up-${label}`, version: "1.0.0" },
		{
			capabilities: [
				defineTool("search", { inputSchema: searchSchema }, async ({ q }) =>
					toolResult(textContent(`${label}:${q}`)),
				),
				defineResource("memo", "memo://1", { mimeType: "text/plain" }, async (uri) => ({
					contents: [{ uri: uri.href, text: `${label} memo` }],
				})),
				...extra,
			],
		},
	);
}

const gh = upstream("gh", [
	defineTool(
		"confirm",
		{
			inputSchema: searchSchema,
			outputSchema: fromJsonSchema<{ ok: boolean; q: string }>({
				type: "object",
				properties: { ok: { type: "boolean" }, q: { type: "string" } },
				required: ["ok", "q"],
			}),
		},
		async ({ q }, ctx: ServerContext) => {
			const answer = acceptedContent<{ ok: boolean }>(ctx.mcpReq.inputResponses, "ok");
			if (answer === undefined) {
				return inputRequired({
					inputRequests: {
						ok: inputRequired.elicit({
							message: `Confirm ${q}?`,
							requestedSchema: {
								type: "object",
								properties: { ok: { type: "boolean" } },
								required: ["ok"],
							},
						}),
					},
					requestState: `round:${q}`,
				});
			}
			const state = ctx.mcpReq.requestState<string>();
			return jsonResult({ ok: answer.ok && state === `round:${q}`, q });
		},
	),
	definePrompt(
		"review",
		{
			argsSchema: fromJsonSchema<{ language: string }>({
				type: "object",
				properties: { language: { type: "string" } },
				required: ["language"],
			}),
			complete: {
				language: (value) => ["typescript", "python"].filter((c) => c.startsWith(value)),
			},
		},
		async ({ language }) => promptResult(userMessage(`Review ${language}.`)),
	),
	defineResourceTemplate("memos", "memo://{id}", {}, async (uri, variables) => ({
		contents: [{ uri: uri.href, text: `memo ${String(variables.id)}` }],
	})),
]);
const jira = upstream("jira");
const LONG_NAMESPACE = "n".repeat(125);

async function topology(
	options: { names?: "namespaced" | "passthrough"; resources?: "namespaced" | "passthrough" } = {},
) {
	const manager = new McpConnectionManager<"gh" | "jira" | "long">();
	manager.register(
		inProcessConnection({
			id: "gh",
			definition: gh,
			era: "modern",
			autoRefreshCatalog: { debounceMs: 0, minIntervalMs: 0 },
		}),
	);
	manager.register(inProcessConnection({ id: "jira", definition: jira, era: "modern" }));
	manager.register(
		inProcessConnection({ id: "long", definition: upstream("long"), era: "modern" }),
	);
	await manager.connectAll(["gh", "jira", "long"]);
	const hubs = new McpHubManager<"main", "gh" | "jira" | "long">(manager);
	hubs.register(
		new McpHubDefinition({
			id: "main",
			members: [
				{ connectionId: "gh", namespace: "gh" },
				{ connectionId: "jira", namespace: "jira" },
				{ connectionId: "long", namespace: LONG_NAMESPACE },
			],
		}),
	);
	await hubs.refreshCatalog("main");
	const gateway = defineGateway({
		hubs,
		hubId: "main",
		serverInfo: { name: "gateway", version: "1.0.0" },
		instructions: "Routes to gh and jira.",
		policy: {
			names: options.names ?? "namespaced",
			resources: options.resources ?? "namespaced",
		},
	});
	return {
		manager,
		hubs,
		gateway,
		async close() {
			hubs.close();
			await manager.close();
		},
	};
}

forEachEra("gateway projects, forwards and relays MRTR rounds end to end", async (era) => {
	const t = await topology();
	const elicited: string[] = [];
	const { client, close } = await createTestClient(t.gateway, {
		era,
		clientOptions: {
			capabilities: { elicitation: { form: {} } },
			inputRequired: { maxRounds: 2 },
		},
	});
	client.setRequestHandler("elicitation/create", async (request) => {
		elicited.push(request.params.message);
		return { action: "accept", content: { ok: true } };
	});
	try {
		const tools = await client.listTools();
		const names = tools.tools.map((tool) => tool.name).sort();
		assert.deepEqual(names, ["gh.confirm", "gh.search", "jira.search"]);
		assert.deepEqual(
			t.gateway.snapshot().dropped.map((d) => [d.kind, d.reason]),
			[["tool", "invalid-name"]],
		);

		const gh = await client.callTool({ name: "gh.search", arguments: { q: "x" } });
		assert.equal(gh.content[0]?.type === "text" ? gh.content[0].text : "", "gh:x");
		const jira = await client.callTool({ name: "jira.search", arguments: { q: "y" } });
		assert.equal(jira.content[0]?.type === "text" ? jira.content[0].text : "", "jira:y");

		const confirmed = await client.callTool({ name: "gh.confirm", arguments: { q: "deploy" } });
		assert.deepEqual(confirmed.structuredContent, { ok: true, q: "deploy" });
		assert.deepEqual(elicited, ["Confirm deploy?"]);

		const prompts = await client.listPrompts();
		assert.deepEqual(
			prompts.prompts.map((p) => p.name),
			["gh.review"],
		);
		const prompt = await client.getPrompt({ name: "gh.review", arguments: { language: "rust" } });
		assert.equal(prompt.messages[0]?.content.type, "text");
		const completion = await client.complete({
			ref: { type: "ref/prompt", name: "gh.review" },
			argument: { name: "language", value: "py" },
		});
		assert.deepEqual(completion.completion.values, ["python"]);

		const resources = await client.listResources();
		assert.deepEqual(resources.resources.map((r) => r.uri).sort(), [
			"gh:memo://1",
			"jira:memo://1",
			`${LONG_NAMESPACE}:memo://1`,
		]);
		const read = await client.readResource({ uri: "gh:memo://1" });
		assert.equal(read.contents[0]?.uri, "gh:memo://1");
		const templated = await client.readResource({ uri: "gh:memo://7" });
		const content = templated.contents[0];
		assert.ok(content !== undefined && "text" in content);
		assert.equal(content.text, "memo 7");
		assert.equal(content.uri, "gh:memo://7");
	} finally {
		await close();
		await t.close();
	}
});

test("passthrough names and resources drop colliding entries from every member", async () => {
	const t = await topology({ names: "passthrough", resources: "passthrough" });
	try {
		const snapshot = t.gateway.snapshot();
		assert.equal(snapshot.projected.tools, 1);
		assert.deepEqual(
			snapshot.dropped
				.filter((d) => d.reason === "name-collision")
				.map((d) => `${d.connectionId}:${d.source}`)
				.sort(),
			["gh:search", "jira:search", "long:search"],
		);
		assert.equal(snapshot.projected.prompts, 1);
		assert.equal(snapshot.projected.resources, 0);
		assert.deepEqual(
			snapshot.dropped
				.filter((d) => d.reason === "uri-collision")
				.map((d) => d.connectionId)
				.sort(),
			["gh", "jira", "long"],
		);
		assert.equal(snapshot.projected.resourceTemplates, 1);
	} finally {
		await t.close();
	}
});

forEachEra("policy.authorize hides routes per principal and never yields -32601", async (era) => {
	const t = await topology();
	const gateway = defineGateway({
		hubs: t.hubs,
		hubId: "main",
		serverInfo: { name: "gateway", version: "1.0.0" },
		policy: {
			authorize: {
				anonymous: "deny",
				check: (authInfo, route) =>
					route.kind === "tool" && route.route.namespace === "gh" && authInfo.scopes.includes("gh"),
			},
		},
	});
	const anonymous = await createTestClient(gateway, { era });
	try {
		assert.deepEqual((await anonymous.client.listTools()).tools, []);
		assert.deepEqual((await anonymous.client.listResources()).resources, []);
		await assert.rejects(
			anonymous.client.callTool({ name: "gh.search", arguments: { q: "x" } }),
			/not found/i,
		);
	} finally {
		await anonymous.close();
	}
	const scoped = await createTestClient(gateway, {
		era,
		authInfo: { token: "t", clientId: "c", scopes: ["gh"], expiresAt: Date.now() / 1000 + 60 },
	});
	try {
		assert.deepEqual((await scoped.client.listTools()).tools.map((tool) => tool.name).sort(), [
			"gh.confirm",
			"gh.search",
		]);
	} finally {
		await scoped.close();
		await t.close();
	}
});

forEachEra("topology changes propagate downstream and stale routes fail closed", async (era) => {
	const t = await topology();
	const runtime = t.gateway.start();
	const events: string[] = [];
	t.gateway.subscribe((event) => {
		events.push(event.changed.join(","));
	});
	const { client, close } = await createTestClient(t.gateway, {
		era,
		clientOptions: {
			listChanged: {
				tools: { autoRefresh: false, debounceMs: 0, onChanged: () => notified.push("tools") },
			},
		},
	});
	const notified: string[] = [];
	try {
		const before = t.gateway.snapshot().generationByConnection;
		await t.manager.disconnect("jira");
		const deadline = Date.now() + 5_000;
		while (events.length === 0) {
			if (Date.now() > deadline) assert.fail("no topology event");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.ok(events[0]?.includes("tools"));
		const after = t.gateway.snapshot();
		assert.notDeepEqual(after.generationByConnection, before);
		assert.equal(after.projected.tools, 2);
		const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
		assert.deepEqual(names, ["gh.confirm", "gh.search"]);
		while (notified.length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.ok(notified.includes("tools"), "downstream received tools/list_changed");

		// While jira is offline its tool is gone from this instance and fails closed if called.
		await assert.rejects(
			client.callTool({ name: "jira.search", arguments: { q: "z" } }),
			/not found/i,
		);
		// After the upstream reconnects and the hub refreshes, the route is live again.
		await t.manager.connect("jira");
		await t.hubs.refreshCatalog("main");
		const back = await client.callTool({ name: "jira.search", arguments: { q: "z" } });
		assert.equal(back.content[0]?.type === "text" ? back.content[0].text : "", "jira:z");
	} finally {
		await close();
		await runtime.close();
		await t.close();
	}
});
