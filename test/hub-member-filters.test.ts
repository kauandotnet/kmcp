import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { ResourceTemplate, fromJsonSchema } from "@modelcontextprotocol/server";

import {
	KMCP_ERROR_CODES,
	KmcpError,
	McpConnectionManager,
	McpHubDefinition,
	McpHubManager,
	defineGateway,
	definePrompt,
	defineResource,
	defineResourceTemplate,
	defineServer,
	defineTool,
	inProcessConnection,
	promptResult,
	textContent,
	toolResult,
	userMessage,
	type KmcpErrorCode,
	type McpHubMember,
} from "../src/index.ts";
import type { McpProtocolEra } from "../src/internal/protocol.ts";
import { createTestClient, forEachEra } from "./helpers/in-process.ts";

const inputSchema = fromJsonSchema<{ value: string }>({
	type: "object",
	properties: { value: { type: "string" } },
	required: ["value"],
	additionalProperties: false,
});

const outputSchema = fromJsonSchema<{ echoed: string }>({
	type: "object",
	properties: { echoed: { type: "string" } },
	required: ["echoed"],
});

function upstreamDefinition() {
	return defineServer(
		{ name: "filters-upstream", version: "1.0.0" },
		{
			capabilities: [
				defineTool(
					"git_status",
					{ description: "git status", inputSchema, annotations: { readOnlyHint: true } },
					async ({ value }) => toolResult(textContent(`git_status:${value}`)),
				),
				defineTool("git_commit", { inputSchema }, async ({ value }) =>
					toolResult(textContent(`git_commit:${value}`)),
				),
				defineTool("deploy", { inputSchema }, async ({ value }) =>
					toolResult(textContent(`deploy:${value}`)),
				),
				defineTool("echo", { inputSchema, outputSchema }, async ({ value }) => ({
					content: [textContent(value)],
					structuredContent: { echoed: value },
				})),
				definePrompt(
					"review",
					{
						argsSchema: fromJsonSchema<{ language: string }>({
							type: "object",
							properties: { language: { type: "string" } },
							required: ["language"],
						}),
						complete: {
							language: (value: string) =>
								["typescript", "python"].filter((candidate) => candidate.startsWith(value)),
						},
					},
					async ({ language }) => promptResult(userMessage(`Review ${language}.`)),
				),
				definePrompt("draft", {}, async () => promptResult(userMessage("Draft."))),
				defineResource("status", "status://current", {}, async (uri) => ({
					contents: [{ uri: uri.href, text: "ok" }],
				})),
				defineResource("secret", "secret://token", {}, async (uri) => ({
					contents: [{ uri: uri.href, text: "shhh" }],
				})),
				defineResourceTemplate(
					"items",
					new ResourceTemplate("status://items/{id}", { list: undefined }),
					{},
					async (uri) => ({ contents: [{ uri: uri.href, text: "item" }] }),
				),
			],
		},
	);
}

interface Fixture {
	readonly manager: McpConnectionManager<"alpha">;
	readonly hubs: McpHubManager<"main", "alpha">;
}

/** One upstream, one hub member, whose filters/renames the caller supplies. */
async function fixture(
	t: TestContext,
	era: McpProtocolEra,
	member: Omit<McpHubMember<"alpha">, "connectionId" | "namespace"> = {},
): Promise<Fixture> {
	const manager = new McpConnectionManager<"alpha">();
	manager.register(inProcessConnection({ id: "alpha", definition: upstreamDefinition(), era }));
	await manager.connect("alpha");
	await manager.refreshCatalog("alpha");
	const hubs = new McpHubManager<"main", "alpha">(manager);
	hubs.register(
		new McpHubDefinition({
			id: "main",
			members: [{ connectionId: "alpha", namespace: "primary", ...member }],
		}),
	);
	t.after(async () => {
		hubs.close();
		await manager.close().catch(() => undefined);
	});
	return { manager, hubs };
}

function toolRoutes(hubs: McpHubManager<"main", "alpha">): string[] {
	return hubs
		.catalog("main")
		.tools.map((route) => route.route)
		.sort();
}

function hasCode(code: KmcpErrorCode): (error: unknown) => boolean {
	return (error) => error instanceof KmcpError && error.code === code;
}

forEachEra("an allow list exposes only the matching tools", async (era, t) => {
	const { hubs } = await fixture(t, era, { tools: { allow: ["git_status", "echo"] } });
	assert.deepEqual(toolRoutes(hubs), ["primary.echo", "primary.git_status"]);

	const called = await hubs.callTool("main", "primary.git_status", { value: "x" });
	assert.equal(called.content[0]?.type === "text" ? called.content[0].text : "", "git_status:x");
	// A tool the allow list leaves out is exactly as unknown as one that never existed.
	assert.throws(
		() => void hubs.callTool("main", "primary.deploy", { value: "x" }),
		hasCode(KMCP_ERROR_CODES.HUB_ROUTE_UNKNOWN),
	);
	assert.throws(
		() => void hubs.callTool("main", "primary.never-existed", { value: "x" }),
		hasCode(KMCP_ERROR_CODES.HUB_ROUTE_UNKNOWN),
	);
	await assert.rejects(
		hubs.callToolParsed("main", "primary.deploy", { value: "x" }),
		hasCode(KMCP_ERROR_CODES.HUB_ROUTE_UNKNOWN),
	);
});

forEachEra("an empty allow list exposes nothing", async (era, t) => {
	const { hubs } = await fixture(t, era, { tools: { allow: [] } });
	assert.deepEqual(toolRoutes(hubs), []);
	assert.throws(
		() => void hubs.callTool("main", "primary.echo", { value: "x" }),
		hasCode(KMCP_ERROR_CODES.HUB_ROUTE_UNKNOWN),
	);
});

forEachEra("deny wins over allow, and wildcards match a trailing prefix", async (era, t) => {
	const { hubs } = await fixture(t, era, {
		tools: { allow: ["git_*", "echo"], deny: ["git_commit"] },
	});
	assert.deepEqual(toolRoutes(hubs), ["primary.echo", "primary.git_status"]);
	assert.throws(
		() => void hubs.callTool("main", "primary.git_commit", { value: "x" }),
		hasCode(KMCP_ERROR_CODES.HUB_ROUTE_UNKNOWN),
	);

	const denied = await fixture(t, era, { tools: { deny: ["git_*"] } });
	assert.deepEqual(toolRoutes(denied.hubs), ["primary.deploy", "primary.echo"]);

	const everything = await fixture(t, era, { tools: { allow: ["*"] } });
	assert.deepEqual(toolRoutes(everything.hubs), [
		"primary.deploy",
		"primary.echo",
		"primary.git_commit",
		"primary.git_status",
	]);
});

forEachEra("a rename exposes a new name that calls the upstream tool", async (era, t) => {
	const { hubs } = await fixture(t, era, {
		tools: { allow: ["git_*", "echo"] },
		rename: { git_status: "status", git_commit: "commit" },
	});
	assert.deepEqual(toolRoutes(hubs), ["primary.commit", "primary.echo", "primary.status"]);

	const route = hubs
		.catalog("main")
		.tools.find((candidate) => candidate.route === "primary.status");
	assert.ok(route);
	assert.equal(route.sourceName, "git_status");
	assert.equal(route.exposedName, "status");
	// A renamed tool keeps its upstream schema and annotations verbatim.
	assert.equal(route.tool.name, "git_status");
	assert.equal(route.tool.description, "git status");
	assert.deepEqual(route.tool.annotations, { readOnlyHint: true });

	const byName = await hubs.callTool("main", "primary.status", { value: "x" });
	assert.equal(byName.content[0]?.type === "text" ? byName.content[0].text : "", "git_status:x");
	const byRoute = await hubs.callTool("main", route, { value: "y" });
	assert.equal(byRoute.content[0]?.type === "text" ? byRoute.content[0].text : "", "git_status:y");
	// `toolDefinition` injection resolves through the rename, so output validation still applies.
	const parsed = await hubs.callToolParsed("main", "primary.echo", { value: "z" });
	assert.deepEqual(parsed.structuredContent, { echoed: "z" });

	// The upstream name is no longer routable once it has been renamed away.
	assert.throws(
		() => void hubs.callTool("main", "primary.git_status", { value: "x" }),
		hasCode(KMCP_ERROR_CODES.HUB_ROUTE_UNKNOWN),
	);
});

forEachEra("renaming onto a denied tool's name is allowed and unambiguous", async (era, t) => {
	// `deploy` is denied, so nothing shadows the renamed `git_status`.
	const { hubs } = await fixture(t, era, {
		tools: { deny: ["deploy"] },
		rename: { git_status: "deploy" },
	});
	assert.deepEqual(toolRoutes(hubs), ["primary.deploy", "primary.echo", "primary.git_commit"]);
	const called = await hubs.callTool("main", "primary.deploy", { value: "x" });
	assert.equal(called.content[0]?.type === "text" ? called.content[0].text : "", "git_status:x");
});

forEachEra("a rename that shadows a live tool drops both ambiguous entries", async (era, t) => {
	const { hubs } = await fixture(t, era, { rename: { git_status: "deploy" } });
	assert.deepEqual(toolRoutes(hubs), ["primary.echo", "primary.git_commit"]);
	assert.throws(
		() => void hubs.callTool("main", "primary.deploy", { value: "x" }),
		hasCode(KMCP_ERROR_CODES.HUB_ROUTE_UNKNOWN),
	);
});

forEachEra("prompt filters hide prompts, calls and completions", async (era, t) => {
	const { hubs } = await fixture(t, era, { prompts: { deny: ["draft"] } });
	assert.deepEqual(
		hubs.catalog("main").prompts.map((route) => route.route),
		["primary.review"],
	);

	assert.equal(
		(await hubs.getPrompt("main", "primary.review", { language: "rust" })).messages.length,
		1,
	);
	assert.throws(
		() => void hubs.getPrompt("main", "primary.draft", undefined),
		hasCode(KMCP_ERROR_CODES.HUB_ROUTE_UNKNOWN),
	);
	const completion = await hubs.complete("main", "primary.review", {
		name: "language",
		value: "py",
	});
	assert.deepEqual(completion.completion.values, ["python"]);
	assert.throws(
		() => void hubs.complete("main", "primary.draft", { name: "language", value: "p" }),
		hasCode(KMCP_ERROR_CODES.HUB_ROUTE_UNKNOWN),
	);
});

forEachEra("resource filters match the URI and cover template expansions", async (era, t) => {
	const { hubs } = await fixture(t, era, { resources: { allow: ["status://*"] } });
	const catalog = hubs.catalog("main");
	assert.deepEqual(
		catalog.resources.map((route) => route.route),
		["primary:status://current"],
	);
	assert.deepEqual(
		catalog.resourceTemplates.map((route) => route.route),
		["primary:status://items/{id}"],
	);

	assert.equal(
		(await hubs.readResource("main", "primary", "status://current")).contents[0]?.uri,
		"status://current",
	);
	assert.equal(
		(await hubs.readResource("main", "primary", "status://items/7")).contents[0]?.uri,
		"status://items/7",
	);
	assert.throws(
		() => void hubs.readResource("main", "primary", "secret://token"),
		hasCode(KMCP_ERROR_CODES.HUB_ROUTE_UNKNOWN),
	);

	// A denied template is neither listed nor reachable through an expansion.
	const noTemplates = await fixture(t, era, { resources: { deny: ["status://items/*"] } });
	assert.deepEqual(
		noTemplates.hubs.catalog("main").resourceTemplates.map((route) => route.route),
		[],
	);
	assert.throws(
		() => void noTemplates.hubs.readResource("main", "primary", "status://items/7"),
		hasCode(KMCP_ERROR_CODES.HUB_ROUTE_UNKNOWN),
	);
	assert.throws(
		() =>
			void noTemplates.hubs.complete("main", "primary:status://items/{id}", {
				name: "id",
				value: "7",
			}),
		hasCode(KMCP_ERROR_CODES.HUB_ROUTE_UNKNOWN),
	);
});

forEachEra("a member without filters behaves exactly as before", async (era, t) => {
	const { hubs } = await fixture(t, era);
	const catalog = hubs.catalog("main");
	assert.deepEqual(toolRoutes(hubs), [
		"primary.deploy",
		"primary.echo",
		"primary.git_commit",
		"primary.git_status",
	]);
	assert.deepEqual(catalog.prompts.map((route) => route.route).sort(), [
		"primary.draft",
		"primary.review",
	]);
	assert.deepEqual(catalog.resources.map((route) => route.route).sort(), [
		"primary:secret://token",
		"primary:status://current",
	]);
	for (const route of catalog.tools) assert.equal(route.exposedName, route.sourceName);

	const snapshot = hubs.state("main");
	const member = snapshot.members[0];
	assert.ok(member);
	assert.equal(member.tools, undefined);
	assert.equal(member.prompts, undefined);
	assert.equal(member.resources, undefined);
	assert.equal(member.rename, undefined);
});

forEachEra(
	"the hub snapshot echoes the effective filters without listing denials",
	async (era, t) => {
		const { hubs } = await fixture(t, era, {
			tools: { allow: ["git_*"], deny: ["git_commit"] },
			prompts: { deny: ["draft"] },
			resources: { allow: ["status://*"] },
			rename: { git_status: "status" },
		});
		const member = hubs.state("main").members[0];
		assert.ok(member);
		assert.deepEqual(member.tools, { allow: ["git_*"], deny: ["git_commit"] });
		assert.deepEqual(member.prompts, { deny: ["draft"] });
		assert.deepEqual(member.resources, { allow: ["status://*"] });
		assert.deepEqual({ ...member.rename }, { git_status: "status" });
		assert.equal(Object.isFrozen(member.tools), true);
		assert.equal(Object.isFrozen(member.tools?.allow), true);
		assert.equal(Object.isFrozen(member.rename), true);

		// Denied items appear nowhere in the projected catalog.
		const catalog = hubs.catalog("main");
		const routes = [
			...catalog.tools.map((route) => route.route),
			...catalog.prompts.map((route) => route.route),
			...catalog.resources.map((route) => route.route),
			...catalog.resourceTemplates.map((route) => route.route),
		];
		assert.deepEqual(
			routes.sort(),
			[
				"primary.status",
				"primary.review",
				"primary:status://current",
				"primary:status://items/{id}",
			].sort(),
		);
	},
);

test("filters and renames are part of the hub fingerprint", () => {
	const plain = new McpHubDefinition({
		id: "main",
		members: [{ connectionId: "alpha", namespace: "primary" }],
	});
	const filtered = new McpHubDefinition({
		id: "main",
		members: [{ connectionId: "alpha", namespace: "primary", tools: { deny: ["deploy"] } }],
	});
	const renamed = new McpHubDefinition({
		id: "main",
		members: [{ connectionId: "alpha", namespace: "primary", rename: { deploy: "ship" } }],
	});
	const same = new McpHubDefinition({
		id: "main",
		members: [{ connectionId: "alpha", namespace: "primary", tools: { deny: ["deploy"] } }],
	});
	assert.notEqual(plain.fingerprint, filtered.fingerprint);
	assert.notEqual(filtered.fingerprint, renamed.fingerprint);
	assert.equal(filtered.fingerprint, same.fingerprint);
	// `{}` is not a filter at all, so it does not move the fingerprint.
	assert.equal(
		new McpHubDefinition({
			id: "main",
			members: [{ connectionId: "alpha", namespace: "primary", tools: {}, rename: {} }],
		}).fingerprint,
		plain.fingerprint,
	);
});

test("definitions stay frozen and reject invalid filters and renames", () => {
	const definition = new McpHubDefinition({
		id: "main",
		members: [
			{
				connectionId: "alpha",
				namespace: "primary",
				tools: { allow: ["git_*"] },
				rename: { git_status: "status" },
			},
		],
	});
	const member = definition.members[0];
	assert.ok(member);
	assert.equal(Object.isFrozen(definition), true);
	assert.equal(Object.isFrozen(definition.members), true);
	assert.equal(Object.isFrozen(member), true);
	assert.equal(Object.isFrozen(member.tools), true);
	assert.equal(Object.isFrozen(member.tools?.allow), true);
	assert.equal(Object.isFrozen(member.rename), true);

	const invalid: readonly Omit<McpHubMember, "connectionId" | "namespace">[] = [
		{ tools: { allow: [""] } },
		{ tools: { deny: ["   "] } },
		{ prompts: { allow: ["a*b"] } },
		{ resources: { deny: ["*://x"] } },
		{ tools: { allow: ["a**"] } },
		{ rename: { git_status: "" } },
		{ rename: { "": "status" } },
		{ rename: { git_status: "same", git_commit: "same" } },
	];
	for (const member of invalid) {
		assert.throws(
			() =>
				new McpHubDefinition({
					id: "main",
					members: [{ connectionId: "alpha", namespace: "primary", ...member }],
				}),
			hasCode(KMCP_ERROR_CODES.INVALID_DEFINITION),
			`expected ${JSON.stringify(member)} to be refused`,
		);
	}

	// Renaming a tool the filter denies is pointless but never refused.
	assert.doesNotThrow(
		() =>
			new McpHubDefinition({
				id: "main",
				members: [
					{
						connectionId: "alpha",
						namespace: "primary",
						tools: { deny: ["git_status"] },
						rename: { git_status: "status" },
					},
				],
			}),
	);
});

forEachEra("a gateway serves the filtered, renamed view end to end", async (era, t) => {
	const manager = new McpConnectionManager<"alpha" | "beta">();
	manager.register(inProcessConnection({ id: "alpha", definition: upstreamDefinition(), era }));
	manager.register(inProcessConnection({ id: "beta", definition: upstreamDefinition(), era }));
	await manager.connectAll(["alpha", "beta"]);
	const hubs = new McpHubManager<"main", "alpha" | "beta">(manager);
	hubs.register(
		new McpHubDefinition({
			id: "main",
			members: [
				{
					connectionId: "alpha",
					namespace: "gh",
					tools: { allow: ["git_*"], deny: ["git_commit"] },
					prompts: { allow: ["review"] },
					resources: { allow: ["status://current"] },
					rename: { git_status: "status" },
				},
				{ connectionId: "beta", namespace: "jira", tools: { allow: ["deploy"] } },
			],
		}),
	);
	await hubs.refreshCatalog("main");
	const gateway = defineGateway({
		hubs,
		hubId: "main",
		serverInfo: { name: "filtered-gateway", version: "1.0.0" },
	});
	const runtime = gateway.start();
	const notified: string[] = [];
	const { client, close } = await createTestClient(gateway, {
		era,
		clientOptions: {
			listChanged: {
				tools: { autoRefresh: false, debounceMs: 0, onChanged: () => notified.push("tools") },
			},
		},
	});
	t.after(async () => {
		await close().catch(() => undefined);
		await runtime.close();
		hubs.close();
		await manager.close().catch(() => undefined);
	});

	assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
		"gh.status",
		"jira.deploy",
	]);
	// `jira` filters tools only, so its prompts and resources stay fully exposed.
	assert.deepEqual((await client.listPrompts()).prompts.map((prompt) => prompt.name).sort(), [
		"gh.review",
		"jira.draft",
		"jira.review",
	]);
	assert.deepEqual(
		(await client.listResources()).resources.map((resource) => resource.uri).sort(),
		["gh:status://current", "jira:secret://token", "jira:status://current"],
	);

	const renamedTool = (await client.listTools()).tools.find((tool) => tool.name === "gh.status");
	assert.equal(renamedTool?.description, "git status");
	const called = await client.callTool({ name: "gh.status", arguments: { value: "x" } });
	assert.equal(called.content[0]?.type === "text" ? called.content[0].text : "", "git_status:x");
	// A denied tool is not found downstream, exactly as an unknown name is.
	await assert.rejects(
		client.callTool({ name: "gh.git_commit", arguments: { value: "x" } }),
		/not found/i,
	);
	await assert.rejects(
		client.callTool({ name: "gh.git_status", arguments: { value: "x" } }),
		/not found/i,
	);

	// Loosening the filter is a `hub.updated` that must reach the downstream list.
	hubs.update(
		new McpHubDefinition({
			id: "main",
			members: [
				{
					connectionId: "alpha",
					namespace: "gh",
					tools: { allow: ["git_*"] },
					rename: { git_status: "status" },
				},
				{ connectionId: "beta", namespace: "jira", tools: { allow: ["deploy"] } },
			],
		}),
	);
	const deadline = Date.now() + 5_000;
	while (notified.length === 0) {
		if (Date.now() > deadline) assert.fail("no tools/list_changed after the filter changed");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
		"gh.git_commit",
		"gh.status",
		"jira.deploy",
	]);
	const commit = await client.callTool({ name: "gh.git_commit", arguments: { value: "y" } });
	assert.equal(commit.content[0]?.type === "text" ? commit.content[0].text : "", "git_commit:y");
});

forEachEra("passthrough gateway names project the renamed tool", async (era, t) => {
	const manager = new McpConnectionManager<"alpha">();
	manager.register(inProcessConnection({ id: "alpha", definition: upstreamDefinition(), era }));
	await manager.connect("alpha");
	const hubs = new McpHubManager<"main", "alpha">(manager);
	hubs.register(
		new McpHubDefinition({
			id: "main",
			members: [
				{
					connectionId: "alpha",
					namespace: "gh",
					tools: { allow: ["git_status"] },
					prompts: { allow: [] },
					resources: { allow: [] },
					rename: { git_status: "status" },
				},
			],
		}),
	);
	await hubs.refreshCatalog("main");
	const gateway = defineGateway({
		hubs,
		hubId: "main",
		serverInfo: { name: "passthrough-gateway", version: "1.0.0" },
		policy: { names: "passthrough" },
	});
	const { client, close } = await createTestClient(gateway, { era });
	t.after(async () => {
		await close().catch(() => undefined);
		hubs.close();
		await manager.close().catch(() => undefined);
	});

	assert.deepEqual(
		(await client.listTools()).tools.map((tool) => tool.name),
		["status"],
	);
	const called = await client.callTool({ name: "status", arguments: { value: "x" } });
	assert.equal(called.content[0]?.type === "text" ? called.content[0].text : "", "git_status:x");
});
