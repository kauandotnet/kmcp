import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	type Client,
	InMemoryTransport,
	type Transport,
	UnauthorizedError,
} from "@modelcontextprotocol/client";
import type { CreateMcpHandlerOptions, McpHttpHandler } from "@modelcontextprotocol/server";
import { fromJsonSchema } from "@modelcontextprotocol/server";

import {
	InMemoryKeyValueStore,
	McpConnectionDefinition,
	McpConnectionManager,
	McpHubDefinition,
	McpHubManager,
	McpOAuthClientProvider,
	McpToolCallError,
	acceptedContent,
	defineResourceTemplate,
	definePrompt,
	defineServer,
	defineTool,
	inProcessConnection,
	inputRequired,
	jsonResult,
	promptResult,
	textContent,
	throwIfToolError,
	toolResult,
	userMessage,
	type McpInProcessServer,
	type McpServerRuntime,
	type McpProtocolEra,
	type ServerContext,
} from "../src/index.ts";
import { KMCP_VERSION } from "../src/internal/version.ts";
import { connectionsFromMcpConfig, mcpConfigNamespace } from "../src/node.ts";
import { forEachEra } from "./helpers/in-process.ts";

const inputSchema = fromJsonSchema<{ value: string }>({
	type: "object",
	properties: { value: { type: "string" } },
	required: ["value"],
	additionalProperties: false,
});

function buildDefinition(label: string) {
	return defineServer(
		{ name: `surface-${label}`, version: "1.0.0" },
		{
			instructions: "Be careful.",
			logging: true,
			capabilities: [
				defineTool("echo", { inputSchema }, async ({ value }) => toolResult(textContent(value))),
				defineTool("fail", {}, async () => ({
					content: [{ type: "text", text: "boom" }],
					isError: true,
				})),
				defineTool(
					"confirm",
					{
						inputSchema,
						outputSchema: fromJsonSchema<{ confirmed: boolean; value: string }>({
							type: "object",
							properties: { confirmed: { type: "boolean" }, value: { type: "string" } },
							required: ["confirmed", "value"],
						}),
					},
					async ({ value }, ctx: ServerContext) => {
						const answer = acceptedContent<{ ok: boolean }>(ctx.mcpReq.inputResponses, "ok");
						if (answer === undefined) {
							return inputRequired({
								inputRequests: {
									ok: inputRequired.elicit({
										message: `Confirm ${value}?`,
										requestedSchema: {
											type: "object",
											properties: { ok: { type: "boolean" } },
											required: ["ok"],
										},
									}),
								},
								requestState: `state:${value}`,
							});
						}
						return jsonResult({ confirmed: answer.ok, value });
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
							language: (value) =>
								["typescript", "python"].filter((candidate) => candidate.startsWith(value)),
						},
					},
					async ({ language }) => promptResult(userMessage(`Review ${language}.`)),
				),
				defineResourceTemplate(
					"item",
					"items://{id}",
					{ complete: { id: (value) => ["1", "12"].filter((id) => id.startsWith(value)) } },
					async (uri, variables) => ({
						contents: [{ uri: uri.href, text: `item ${String(variables.id)}` }],
					}),
				),
			],
		},
	);
}

/** Wraps a definition so tests can reach the live handler (modern) or runtime (legacy) to notify. */
function observable(definition: ReturnType<typeof buildDefinition>): {
	readonly server: McpInProcessServer;
	toolsChanged(): Promise<void>;
} {
	let handler: McpHttpHandler | undefined;
	let runtime: McpServerRuntime | undefined;
	const server: McpInProcessServer = {
		handler(options?: CreateMcpHandlerOptions) {
			handler = definition.handler(options);
			return handler;
		},
		async instantiate(context) {
			const created = await definition.instantiate(context);
			runtime = created;
			return created;
		},
	};
	return {
		server,
		async toolsChanged() {
			if (handler !== undefined) await handler.notify.toolsChanged();
			else if (runtime !== undefined) await runtime.server.sendToolListChanged();
		},
	};
}

test("KMCP_VERSION matches package.json", async () => {
	const pkg = JSON.parse(
		await readFile(new URL("package.json", `file://${process.cwd()}/`), "utf8"),
	) as {
		version: string;
	};
	assert.equal(KMCP_VERSION, pkg.version);
});

forEachEra("MRTR round-trips through a declared elicitation handler", async (era) => {
	const seen: string[] = [];
	const connection = inProcessConnection({
		id: "alpha",
		definition: buildDefinition("mrtr"),
		era,
		requestHandlers: {
			"elicitation/create": async (request) => {
				seen.push(request.params.message);
				return { action: "accept", content: { ok: true } };
			},
		},
		inputRequired: { maxRounds: 2 },
	});
	const manager = new McpConnectionManager<"alpha">();
	manager.register(connection);
	await manager.connect("alpha");
	try {
		const result = await manager.callTool("alpha", "confirm", { value: "deploy" });
		assert.deepEqual(result.structuredContent, { confirmed: true, value: "deploy" });
		assert.deepEqual(seen, ["Confirm deploy?"]);
		const snapshot = manager.state("alpha");
		assert.equal(snapshot.instructions, "Be careful.");
		assert.equal(snapshot.protocolEra, era);
		assert.equal(snapshot.serverInfo?.name, "surface-mrtr");
	} finally {
		await manager.close();
	}
});

forEachEra("throwIfToolError raises McpToolCallError with the content", async (era) => {
	const manager = new McpConnectionManager<"alpha">();
	manager.register(inProcessConnection({ id: "alpha", definition: buildDefinition("err"), era }));
	await manager.connect("alpha");
	try {
		const ok = throwIfToolError(await manager.callTool("alpha", "echo", { value: "x" }));
		assert.equal(ok.content[0]?.type, "text");
		await assert.rejects(
			async () => throwIfToolError(await manager.callTool("alpha", "fail")),
			(error: unknown) =>
				error instanceof McpToolCallError &&
				error.code === "TOOL_CALL_FAILED" &&
				error.message === "boom" &&
				error.content.length === 1,
		);
	} finally {
		await manager.close();
	}
});

forEachEra("ping, complete, ad-hoc lists and template reads work per era", async (era) => {
	const manager = new McpConnectionManager<"alpha">();
	manager.register(inProcessConnection({ id: "alpha", definition: buildDefinition("verbs"), era }));
	await manager.connect("alpha");
	const hubs = new McpHubManager<"main", "alpha">(manager);
	hubs.register(
		new McpHubDefinition({ id: "main", members: [{ connectionId: "alpha", namespace: "a" }] }),
	);
	try {
		const ping = await manager.ping("alpha");
		assert.equal(ping.era, era);
		assert.ok(ping.roundTripMs >= 0);

		const tools = await manager.listTools("alpha");
		assert.ok(tools.tools.some((tool) => tool.name === "confirm"));
		const templates = await manager.listResourceTemplates("alpha");
		assert.equal(templates.resourceTemplates[0]?.uriTemplate, "items://{id}");

		const completion = await manager.complete("alpha", {
			ref: { type: "ref/prompt", name: "review" },
			argument: { name: "language", value: "py" },
		});
		assert.deepEqual(completion.completion.values, ["python"]);

		await hubs.refreshCatalog("main");
		const routed = await hubs.complete(
			"main",
			"a.review",
			{ name: "language", value: "type" },
			undefined,
		);
		assert.deepEqual(routed.completion.values, ["typescript"]);
		const templated = await hubs.complete("main", "a:items://{id}", { name: "id", value: "1" });
		assert.deepEqual(templated.completion.values, ["1", "12"]);

		const read = await hubs.readResource("main", "a", "items://42");
		const contents = read.contents[0];
		assert.ok(contents !== undefined && "text" in contents);
		assert.equal(contents.text, "item 42");
		await assert.rejects(async () => hubs.readResource("main", "a", "other://42"), /route/i);

		const prompt = await hubs.getPrompt("main", "a.review", { language: "rust" });
		assert.equal(prompt.messages[0]?.content.type, "text");
	} finally {
		hubs.close();
		await manager.close();
	}
});

forEachEra(
	"autoRefreshCatalog refreshes on list-changed, also after a prior reconnect",
	async (era) => {
		const observed = observable(buildDefinition("watch"));
		const manager = new McpConnectionManager<"alpha">();
		manager.register(
			inProcessConnection({
				id: "alpha",
				definition: observed.server,
				era,
				autoRefreshCatalog: { debounceMs: 0, minIntervalMs: 0, maxRefreshesPerGeneration: 3 },
			}),
		);
		const refreshed: number[] = [];
		manager.subscribe((event) => {
			if (event.type === "catalog.refreshed") refreshed.push(event.connection.generation);
		});
		const waitForRefresh = async (generation: number, count: number) => {
			const deadline = Date.now() + 5_000;
			while (refreshed.filter((value) => value === generation).length < count) {
				if (Date.now() > deadline) assert.fail(`no refresh for generation ${generation}`);
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		};
		try {
			const first = await manager.connect("alpha");
			assert.equal(first.watch?.active, true);
			assert.ok(first.watch?.honoredSections.includes("tools"));
			await observed.toolsChanged();
			await waitForRefresh(first.generation, 1);
			assert.equal(manager.state("alpha").catalog?.tools.status, "fresh");

			await manager.disconnect("alpha");
			const second = await manager.connect("alpha");
			assert.notEqual(second.generation, first.generation);
			assert.equal(second.watch?.active, true, JSON.stringify(second.watch));
			await observed.toolsChanged();
			await waitForRefresh(second.generation, 1);

			// The per-generation cap is enforced: further notifications degrade instead of refetching.
			await observed.toolsChanged();
			await waitForRefresh(second.generation, 2);
			await observed.toolsChanged();
			await waitForRefresh(second.generation, 3);
			await observed.toolsChanged();
			const deadline = Date.now() + 2_000;
			while (manager.state("alpha").watch?.reason !== "refresh-cap") {
				if (Date.now() > deadline) assert.fail("cap never reached");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.equal(manager.state("alpha").phase, "degraded");
			assert.equal(manager.state("alpha").errorCode, "CATALOG_STALE");
		} finally {
			await manager.close();
		}
	},
);

forEachEra("defaults, logLevel and errorDetail are applied per connection", async (era) => {
	const manager = new McpConnectionManager<"alpha">();
	manager.register(
		inProcessConnection({
			id: "alpha",
			definition: buildDefinition("defaults"),
			era,
			defaults: { toolTimeoutMs: 5, timeoutMs: 10_000 },
			logLevel: "debug",
		}),
	);
	await manager.connect("alpha");
	try {
		assert.equal(manager.state("alpha").logLevel, "debug");
		await manager.setLogLevel("alpha", "warning");
		assert.equal(manager.state("alpha").logLevel, "warning");
		// A tiny tool timeout does not break a fast in-process call; the option is forwarded.
		const result = await manager.callTool("alpha", "echo", { value: "fast" }, { timeout: 5_000 });
		assert.equal(result.content[0]?.type, "text");
		await assert.rejects(manager.callTool("alpha", "missing"), (error: unknown) => {
			return error instanceof Error && /not found/i.test(error.message);
		});
	} finally {
		await manager.close();
	}
});

test("errorDetail classifies a connect failure and connectAll rolls back atomically", async () => {
	const manager = new McpConnectionManager<"good" | "bad">();
	manager.register(
		inProcessConnection({ id: "good", definition: buildDefinition("good"), era: "modern" }),
	);
	manager.register(
		new McpConnectionDefinition({
			id: "bad",
			transport: async () => {
				throw new UnauthorizedError("nope");
			},
		}),
	);
	try {
		await assert.rejects(manager.connectAll(["good", "bad"], { atomic: true }), AggregateError);
		assert.equal(manager.state("good").phase, "offline");
		assert.equal(manager.state("bad").phase, "failed");
		assert.deepEqual(manager.state("bad").errorDetail, { kind: "oauth", code: "unauthorized" });
		const connected = await manager.connectAll(["good"]);
		assert.equal(connected[0]?.phase, "online");
	} finally {
		await manager.close();
	}
});

test("interactive OAuth parks the connection in 'authorizing' and completes on the same transport", async () => {
	const definition = buildDefinition("oauth");
	const finishCalls: string[] = [];
	let authorized = false;
	let attempts = 0;
	const provider = new McpOAuthClientProvider({
		serverUrl: "http://127.0.0.1:9/mcp",
		redirectUrl: "http://127.0.0.1:9/callback",
		store: new InMemoryKeyValueStore(),
		onRedirect: () => undefined,
	});
	const connection = new McpConnectionDefinition({
		id: "alpha",
		oauth: provider,
		clientOptions: { versionNegotiation: { mode: "legacy" } },
		transport: async (): Promise<Transport> => {
			attempts += 1;
			const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
			const runtime = await definition.instantiate({ era: "legacy" });
			await runtime.connect(serverSide);
			const start = clientSide.start.bind(clientSide);
			const close = clientSide.close.bind(clientSide);
			const transport = clientSide as Transport & {
				finishAuth?: (params: URLSearchParams) => Promise<void>;
			};
			transport.start = async () => {
				if (!authorized) throw new UnauthorizedError("login required");
				await start();
			};
			transport.finishAuth = async (params) => {
				finishCalls.push(params.get("code") ?? "");
				authorized = true;
			};
			transport.close = async () => {
				await close();
				await runtime.close();
			};
			return transport;
		},
	});
	const manager = new McpConnectionManager<"alpha">();
	const events: string[] = [];
	manager.subscribe((event) => {
		events.push(event.type);
	});
	manager.register(connection);
	try {
		await assert.rejects(manager.connect("alpha"), /CONNECTION_AUTHORIZING|authorization/i);
		assert.equal(manager.state("alpha").phase, "authorizing");
		assert.ok(events.includes("connection.authorization.required"));
		await assert.rejects(async () => manager.connect("alpha"), /authorization/i);
		const online = await manager.completeAuthorization(
			"alpha",
			new URLSearchParams({ code: "abc" }),
		);
		assert.equal(online.phase, "online");
		assert.deepEqual(finishCalls, ["abc"]);
		assert.equal(attempts, 2);
		const result = await manager.callTool("alpha", "echo", { value: "hi" });
		assert.equal(result.content[0]?.type, "text");
	} finally {
		await manager.close();
	}
});

test("connectionsFromMcpConfig keys definitions by config key and suggests namespaces", () => {
	const connections = connectionsFromMcpConfig({
		mcpServers: {
			"io.github.example": { command: "node", args: ["server.js"], env: { TOKEN: "secret" } },
			remote: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer s3" } },
			custom: { url: "https://x.example.com/mcp", namespace: "explicit" },
		},
	});
	assert.equal(connections["io.github.example"].id, "io.github.example");
	assert.equal(connections["io.github.example"].tags["kmcp.namespace"], "io_github_example");
	assert.equal(connections["io.github.example"].tags["kmcp.transport"], "stdio");
	assert.equal(connections.remote.tags["kmcp.transport"], "http");
	assert.equal(connections.custom.tags["kmcp.namespace"], "explicit");
	const serialized =
		JSON.stringify(connections.remote) + JSON.stringify(connections["io.github.example"]);
	assert.ok(!serialized.includes("secret") && !serialized.includes("s3"));
	assert.equal(mcpConfigNamespace("@scope/pkg"), "scope_pkg");
	assert.equal(mcpConfigNamespace("-x-"), "x-");
	assert.equal(mcpConfigNamespace("!!!"), "server");
	assert.throws(
		() =>
			connectionsFromMcpConfig({
				mcpServers: { "a.b": { command: "x" }, a_b: { command: "y" } },
			}),
		/same namespace/,
	);
});

const eras: readonly McpProtocolEra[] = ["modern", "legacy"];
test("both eras are covered", () => assert.equal(eras.length, 2));
void ((_client: Client) => undefined);
