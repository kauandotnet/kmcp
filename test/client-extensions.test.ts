import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryTransport, type Client } from "@modelcontextprotocol/client";
import type { CreateMcpHandlerOptions, McpHttpHandler } from "@modelcontextprotocol/server";
import { fromJsonSchema } from "@modelcontextprotocol/server";

import {
	McpConnectionManager,
	McpHubDefinition,
	McpHubManager,
	McpToolCallError,
	defineConnection,
	defineResource,
	defineServer,
	defineTool,
	inProcessConnection,
	textContent,
	toolResult,
	type McpConnectionEvent,
	type McpInProcessServer,
	type McpServerRuntime,
} from "../src/index.ts";
import { forEachEra } from "./helpers/in-process.ts";

const inputSchema = fromJsonSchema<{ value: string }>({
	type: "object",
	properties: { value: { type: "string" } },
	required: ["value"],
});

function buildDefinition() {
	return defineServer(
		{ name: "cx", version: "1.0.0" },
		{
			capabilities: [
				defineTool("echo", { inputSchema }, async ({ value }) => toolResult(textContent(value))),
				defineTool("fail", {}, async () => ({
					content: [{ type: "text", text: "boom" }],
					isError: true,
				})),
				defineResource("doc", "docs://readme", {}, async (uri) => ({
					contents: [{ uri: uri.href, text: "# hi" }],
				})),
			],
		},
	);
}

/** Wraps a definition so tests can push `resources/updated` from the live server side. */
function observable(definition: ReturnType<typeof buildDefinition>): {
	readonly server: McpInProcessServer;
	resourceUpdated(uri: string): Promise<void>;
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
		async resourceUpdated(uri: string) {
			if (handler !== undefined) await handler.notify.resourceUpdated(uri);
			else if (runtime !== undefined) {
				await runtime.server.server.sendResourceUpdated({ uri });
			}
		},
	};
}

async function eventually(check: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
	const startedAt = Date.now();
	while (!check()) {
		if (Date.now() - startedAt > timeoutMs) assert.fail(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

forEachEra("resource subscriptions surface resource.updated events", async (era) => {
	const observed = observable(buildDefinition());
	const manager = new McpConnectionManager<"alpha">();
	const events: McpConnectionEvent<"alpha">[] = [];
	manager.subscribe((event) => {
		events.push(event);
	});
	manager.register(inProcessConnection({ id: "alpha", definition: observed.server, era }));
	await manager.connect("alpha");
	try {
		await manager.subscribeResource("alpha", "docs://readme");
		assert.deepEqual(manager.state("alpha").subscribedResources, ["docs://readme"]);

		await observed.resourceUpdated("docs://readme");
		await eventually(
			() => events.some((event) => event.type === "resource.updated"),
			"resource.updated event",
		);
		const updated = events.find((event) => event.type === "resource.updated");
		assert.deepEqual(updated?.resource, { uri: "docs://readme" });

		await manager.unsubscribeResource("alpha", "docs://readme");
		assert.equal(manager.state("alpha").subscribedResources, undefined);
	} finally {
		await manager.close();
	}
});

test("a modern resource subscription is honored through the listen filter", async () => {
	const observed = observable(buildDefinition());
	const manager = new McpConnectionManager<"alpha">();
	const events: McpConnectionEvent<"alpha">[] = [];
	manager.subscribe((event) => {
		events.push(event);
	});
	manager.register(
		inProcessConnection({ id: "alpha", definition: observed.server, era: "modern" }),
	);
	await manager.connect("alpha");
	try {
		// Without a subscription, an update for the URI is not delivered.
		await observed.resourceUpdated("docs://readme");
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.ok(!events.some((event) => event.type === "resource.updated"));

		await manager.subscribeResource("alpha", "docs://readme");
		await observed.resourceUpdated("docs://readme");
		await eventually(
			() => events.some((event) => event.type === "resource.updated"),
			"resource.updated after subscribe",
		);
	} finally {
		await manager.close();
	}
});

function reconnectableConnection(options: {
	readonly maxAttempts: number;
	readonly resetAfterMs?: number;
}) {
	const definition = buildDefinition();
	let opens = 0;
	let failConnects = false;
	let runtime: McpServerRuntime | undefined;
	const connection = defineConnection({
		id: "r" as const,
		clientOptions: { versionNegotiation: { mode: "legacy" } },
		reconnect: {
			maxAttempts: options.maxAttempts,
			backoff: { initialMs: 25, factor: 1, jitter: false },
			...(options.resetAfterMs === undefined ? {} : { resetAfterMs: options.resetAfterMs }),
		},
		transport: async () => {
			if (failConnects) throw new Error("transport down");
			opens += 1;
			const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
			runtime = await definition.instantiate({ era: "legacy" });
			await runtime.connect(serverSide);
			return clientSide;
		},
	});
	return {
		connection,
		opens: () => opens,
		kill: async () => runtime?.close(),
		setFailConnects: (value: boolean) => {
			failConnects = value;
		},
	};
}

test("an unexpected close schedules a reconnect that re-enters connect()", async () => {
	const harness = reconnectableConnection({ maxAttempts: 3 });
	const manager = new McpConnectionManager<"r">();
	const events: McpConnectionEvent<"r">[] = [];
	manager.subscribe((event) => {
		events.push(event);
	});
	manager.register(harness.connection);
	const first = await manager.connect("r");
	assert.equal(first.generation, 1);
	try {
		await harness.kill();
		await eventually(() => manager.state("r").phase === "online", "automatic reconnect", 4000);
		assert.equal(manager.state("r").generation, 2);
		assert.equal(harness.opens(), 2);
		assert.ok(events.some((event) => event.type === "connection.reconnect.scheduled"));
	} finally {
		await manager.close();
	}
});

test("a deliberate disconnect cancels a pending reconnect", async () => {
	const harness = reconnectableConnection({ maxAttempts: 3 });
	const manager = new McpConnectionManager<"r">();
	manager.register(harness.connection);
	await manager.connect("r");
	try {
		await harness.kill();
		await eventually(() => manager.state("r").phase === "failed", "failure observed");
		await manager.disconnect("r");
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(manager.state("r").phase, "offline");
		assert.equal(harness.opens(), 1);
	} finally {
		await manager.close();
	}
});

test("reconnect attempts are capped and exhaustion is published", async () => {
	const harness = reconnectableConnection({ maxAttempts: 2 });
	const manager = new McpConnectionManager<"r">();
	const events: McpConnectionEvent<"r">[] = [];
	manager.subscribe((event) => {
		events.push(event);
	});
	manager.register(harness.connection);
	await manager.connect("r");
	try {
		harness.setFailConnects(true);
		await harness.kill();
		await eventually(
			() => events.some((event) => event.type === "connection.reconnect.exhausted"),
			"exhaustion event",
			4000,
		);
		assert.equal(harness.opens(), 1);
		assert.equal(
			events.filter((event) => event.type === "connection.reconnect.scheduled").length,
			2,
		);
		assert.equal(manager.state("r").phase, "failed");
	} finally {
		await manager.close();
	}
});

test("removal fences a scheduled reconnect", async () => {
	const harness = reconnectableConnection({ maxAttempts: 3 });
	const manager = new McpConnectionManager<"r">();
	manager.register(harness.connection);
	await manager.connect("r");
	try {
		await harness.kill();
		await eventually(() => manager.state("r").phase === "failed", "failure observed");
		await manager.remove("r");
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(harness.opens(), 1);
		assert.throws(() => manager.state("r"), /Unknown connection/);
	} finally {
		await manager.close();
	}
});

forEachEra("callToolParsed raises on isError by default", async (era) => {
	const manager = new McpConnectionManager<"alpha">();
	manager.register(inProcessConnection({ id: "alpha", definition: buildDefinition(), era }));
	await manager.connect("alpha");
	try {
		const parsed = await manager.callToolParsed("alpha", "echo", { value: "hi" });
		assert.equal(parsed.isError, false);
		assert.equal((parsed.content[0] as { text: string }).text, "hi");
		await assert.rejects(
			() => manager.callToolParsed("alpha", "fail"),
			(error: unknown) => error instanceof McpToolCallError && error.message === "boom",
		);
		const tolerant = await manager.callToolParsed("alpha", "fail", {}, { raiseOnError: false });
		assert.equal(tolerant.isError, true);
		await assert.rejects(
			() => manager.callToolParsed("alpha", "echo", {}, { allowInputRequired: true }),
			TypeError,
		);
	} finally {
		await manager.close();
	}
});

forEachEra("hub callToolParsed resolves the route and stays fenced", async (era) => {
	const manager = new McpConnectionManager<"alpha">();
	manager.register(inProcessConnection({ id: "alpha", definition: buildDefinition(), era }));
	await manager.connect("alpha");
	const hubs = new McpHubManager<"main", "alpha">(manager);
	hubs.register(
		new McpHubDefinition({ id: "main", members: [{ connectionId: "alpha", namespace: "a" }] }),
	);
	try {
		await hubs.refreshCatalog("main");
		const parsed = await hubs.callToolParsed("main", "a.echo", { value: "routed" });
		assert.equal((parsed.content[0] as { text: string }).text, "routed");
		await assert.rejects(
			() => hubs.callToolParsed("main", "a.fail"),
			(error: unknown) => error instanceof McpToolCallError,
		);
		await assert.rejects(() => hubs.callToolParsed("main", "a.unknown"), /route/i);
	} finally {
		hubs.close();
		await manager.close();
	}
});

forEachEra("configureClient runs before connect and notifyRootsChanged works", async (era) => {
	const configured: Client[] = [];
	const manager = new McpConnectionManager<"alpha">();
	manager.register(
		inProcessConnection({
			id: "alpha",
			definition: buildDefinition(),
			era,
			roots: () => ["/tmp/project"],
			inputRequired: { maxRounds: 1 },
			configureClient: (client) => {
				configured.push(client);
			},
		}),
	);
	await manager.connect("alpha");
	try {
		assert.equal(configured.length, 1);
		if (era === "legacy") {
			await manager.notifyRootsChanged("alpha");
		} else {
			// The 2026-07-28 wire removed the roots feature entirely.
			await assert.rejects(() => manager.notifyRootsChanged("alpha"), /legacy-era/);
		}
	} finally {
		await manager.close();
	}
});
