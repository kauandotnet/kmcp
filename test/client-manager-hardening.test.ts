import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
	InMemoryTransport,
	type CacheableRequestOptions,
	type CallToolRequestOptions,
	type Client,
	type JSONRPCMessage,
	type RequestOptions,
	type Tool,
	type Transport,
} from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import {
	KMCP_ERROR_CODES,
	McpConnectionDefinition,
	McpConnectionManager,
	KmcpError,
	type McpConnectionManagerOptions,
} from "../src/index.ts";

const listedTool: Tool = Object.freeze({
	name: "echo",
	description: "Echo a value.",
	inputSchema: { type: "object" as const },
});

test("catalog identity is generation-bound and public operations enforce stale-work fences", async (t) => {
	const harness = connectionHarness();
	const manager = new McpConnectionManager<"alpha">();
	manager.register(harness.connection);
	t.after(() => closeHarness(manager, harness.servers));

	await assert.rejects(
		manager.callTool("alpha", "echo"),
		hasCode(KMCP_ERROR_CODES.CONNECTION_NOT_ONLINE),
	);
	assert.equal(harness.openCount(), 0, "operations must not implicitly connect");

	await manager.connect("alpha");
	const firstClient = await currentClient(manager);
	mockToolCatalog(t, firstClient, async () => [listedTool]);
	const firstCatalog = await manager.refreshCatalog("alpha");
	assert.equal(firstCatalog.generation, 1);
	assert.equal(firstCatalog.tools.status, "fresh");
	assert.equal(
		Object.hasOwn(manager.state("alpha"), "activeOperations"),
		false,
		"unrevisioned operation counters must not leak into snapshots",
	);

	await manager.disconnect("alpha");
	assert.equal(manager.state("alpha").catalog, undefined);
	await manager.connect("alpha");
	assert.equal(manager.state("alpha").catalog, undefined);

	const secondClient = await currentClient(manager);
	let failDiscovery = true;
	mockToolCatalog(t, secondClient, async () => {
		if (failDiscovery) throw new Error("discovery unavailable");
		return [listedTool];
	});
	const failedSecondGeneration = await manager.refreshCatalog("alpha");
	assert.equal(failedSecondGeneration.generation, 2);
	assert.equal(failedSecondGeneration.tools.status, "failed");
	assert.deepEqual(failedSecondGeneration.tools.items, []);
	assert.notEqual(failedSecondGeneration.fingerprint, firstCatalog.fingerprint);

	failDiscovery = false;
	const secondCatalog = await manager.refreshCatalog("alpha");
	assert.equal(secondCatalog.tools.status, "fresh");
	assert.notEqual(secondCatalog.fingerprint, firstCatalog.fingerprint);

	await assert.rejects(
		manager.withClient("alpha", async () => undefined, undefined, {
			expectedGeneration: firstCatalog.generation,
		}),
		hasCode(KMCP_ERROR_CODES.CONNECTION_GENERATION_STALE),
	);
	await assert.rejects(
		manager.withClient("alpha", async () => undefined, undefined, {
			expectedGeneration: secondCatalog.generation,
			expectedCatalogFingerprint: firstCatalog.fingerprint,
		}),
		hasCode(KMCP_ERROR_CODES.CATALOG_STALE),
	);

	const operationSignal = new AbortController().signal;
	let callToolSignal: AbortSignal | undefined;
	let getPromptSignal: AbortSignal | undefined;
	let readResourceSignal: AbortSignal | undefined;
	t.mock.method(
		secondClient,
		"callTool",
		async (_params: Parameters<Client["callTool"]>[0], options?: CallToolRequestOptions) => {
			callToolSignal = options?.signal;
			return { content: [] };
		},
	);
	t.mock.method(
		secondClient,
		"getPrompt",
		async (_params: Parameters<Client["getPrompt"]>[0], options?: RequestOptions) => {
			getPromptSignal = options?.signal;
			return { messages: [] };
		},
	);
	t.mock.method(
		secondClient,
		"readResource",
		async (_params: Parameters<Client["readResource"]>[0], options?: CacheableRequestOptions) => {
			readResourceSignal = options?.signal;
			return { contents: [] };
		},
	);
	const control = {
		expectedGeneration: secondCatalog.generation,
		expectedCatalogFingerprint: secondCatalog.fingerprint,
	};
	await manager.callTool("alpha", "echo", {}, { signal: operationSignal }, control);
	await manager.getPrompt("alpha", "welcome", undefined, { signal: operationSignal }, control);
	await manager.readResource("alpha", "status://current", { signal: operationSignal }, control);
	assert.equal(callToolSignal, operationSignal);
	assert.equal(getPromptSignal, operationSignal);
	assert.equal(readResourceSignal, operationSignal);

	await harness.clientTransports.at(-1)?.close();
	assert.equal(manager.state("alpha").phase, "failed");
	assert.equal(manager.state("alpha").catalog, undefined);
});

test("a refresh cannot commit after draining begins", async (t) => {
	const harness = connectionHarness();
	const manager = new McpConnectionManager<"alpha">();
	manager.register(harness.connection);
	t.after(() => closeHarness(manager, harness.servers));
	await manager.connect("alpha");
	const client = await currentClient(manager);
	const started = deferred();
	const release = deferred();
	mockToolCatalog(t, client, async () => {
		started.resolve();
		await release.promise;
		return [listedTool];
	});

	const refresh = manager.refreshCatalog("alpha");
	await started.promise;
	const disconnect = manager.disconnect("alpha");
	assert.equal(manager.state("alpha").phase, "draining");
	release.resolve();
	await assert.rejects(refresh, hasCode(KMCP_ERROR_CODES.CONNECTION_NOT_ONLINE));
	assert.equal((await disconnect).phase, "offline");
	assert.equal(manager.state("alpha").catalog, undefined);
});

test("the first concurrent catalog commit fences a slower refresh", async (t) => {
	const harness = connectionHarness();
	const manager = new McpConnectionManager<"alpha">();
	manager.register(harness.connection);
	t.after(() => closeHarness(manager, harness.servers));
	await manager.connect("alpha");
	const client = await currentClient(manager);
	const firstStarted = deferred();
	const secondStarted = deferred();
	const firstResult = deferredValue<readonly Tool[]>();
	const secondResult = deferredValue<readonly Tool[]>();
	let calls = 0;
	t.mock.method(client, "getServerCapabilities", () => ({ tools: {} }));
	t.mock.method(client, "listTools", async () => {
		calls += 1;
		if (calls === 1) {
			firstStarted.resolve();
			return { tools: [...(await firstResult.promise)] };
		}
		secondStarted.resolve();
		return { tools: [...(await secondResult.promise)] };
	});

	const slower = manager.refreshCatalog("alpha");
	await firstStarted.promise;
	const faster = manager.refreshCatalog("alpha");
	await secondStarted.promise;
	secondResult.resolve([{ ...listedTool, description: "newer" }]);
	const committed = await faster;
	firstResult.resolve([{ ...listedTool, description: "older" }]);

	await assert.rejects(slower, hasCode(KMCP_ERROR_CODES.CATALOG_STALE));
	assert.equal(committed.tools.items[0]?.description, "newer");
	assert.equal(manager.state("alpha").catalog?.tools.items[0]?.description, "newer");
	assert.equal(manager.state("alpha").phase, "online");
});

test("connect and disconnect tasks are visible before lifecycle listeners can re-enter", async (t) => {
	const harness = connectionHarness();
	const manager = new McpConnectionManager<"alpha">();
	manager.register(harness.connection);
	t.after(() => closeHarness(manager, harness.servers));
	let nestedConnect: ReturnType<typeof manager.connect> | undefined;
	let nestedDisconnect: ReturnType<typeof manager.disconnect> | undefined;
	manager.subscribe((event) => {
		if (event.connection.phase === "connecting" && nestedConnect === undefined) {
			nestedConnect = manager.connect("alpha");
		}
		if (event.connection.phase === "draining" && nestedDisconnect === undefined) {
			nestedDisconnect = manager.disconnect("alpha");
		}
	});

	const connect = manager.connect("alpha");
	await connect;
	assert.strictEqual(nestedConnect, connect);
	assert.equal(harness.openCount(), 1);

	const disconnect = manager.disconnect("alpha");
	await disconnect;
	assert.strictEqual(nestedDisconnect, disconnect);
});

test("connect requested during a disconnect waits and creates a new generation", async (t) => {
	const harness = connectionHarness();
	const manager = new McpConnectionManager<"alpha">();
	manager.register(harness.connection);
	t.after(() => closeHarness(manager, harness.servers));
	const first = await manager.connect("alpha");

	const disconnect = manager.disconnect("alpha");
	const reconnect = manager.connect("alpha");
	assert.equal(manager.state("alpha").phase, "draining");

	assert.equal((await disconnect).phase, "offline");
	const second = await reconnect;
	assert.equal(second.phase, "online");
	assert.notEqual(second.generation, first.generation);
	assert.equal(harness.openCount(), 2);
});

test("manager-lifetime generations prevent same-ID remove and re-register ABA", async (t) => {
	const firstHarness = connectionHarness();
	const secondHarness = connectionHarness();
	const manager = new McpConnectionManager<"alpha">();
	t.after(async () => {
		await manager.close().catch(() => undefined);
		await Promise.allSettled(
			[...firstHarness.servers, ...secondHarness.servers].map((server) => server.close()),
		);
	});

	manager.register(firstHarness.connection);
	await manager.connect("alpha");
	const firstClient = await currentClient(manager);
	mockToolCatalog(t, firstClient, async () => [listedTool]);
	const firstCatalog = await manager.refreshCatalog("alpha");
	await manager.remove("alpha");

	manager.register(secondHarness.connection);
	await manager.connect("alpha");
	const secondClient = await currentClient(manager);
	mockToolCatalog(t, secondClient, async () => [listedTool]);
	const secondCatalog = await manager.refreshCatalog("alpha");

	assert.ok(secondCatalog.generation > firstCatalog.generation);
	assert.notEqual(secondCatalog.fingerprint, firstCatalog.fingerprint);
	await assert.rejects(
		manager.withClient("alpha", async () => undefined, undefined, {
			expectedGeneration: firstCatalog.generation,
			expectedCatalogFingerprint: firstCatalog.fingerprint,
		}),
		hasCode(KMCP_ERROR_CODES.CONNECTION_GENERATION_STALE),
	);
});

test("removal fences a reconnect that was queued on an earlier disconnect", async (t) => {
	const harness = connectionHarness();
	const manager = new McpConnectionManager<"alpha">();
	manager.register(harness.connection);
	t.after(() => closeHarness(manager, harness.servers));
	await manager.connect("alpha");
	const operationStarted = deferred();
	const releaseOperation = deferred();
	const activeOperation = manager.withClient("alpha", async () => {
		operationStarted.resolve();
		await releaseOperation.promise;
	});
	await operationStarted.promise;

	const disconnect = manager.disconnect("alpha");
	const queuedReconnect = manager.connect("alpha");
	const removal = manager.remove("alpha");
	assert.strictEqual(manager.remove("alpha"), removal);
	releaseOperation.resolve();
	await activeOperation;
	await disconnect;
	await removal;

	await assert.rejects(queuedReconnect, hasCode(KMCP_ERROR_CODES.CONNECTION_NOT_ONLINE));
	assert.equal(harness.openCount(), 1);
	assert.throws(() => manager.state("alpha"), hasCode(KMCP_ERROR_CODES.CONNECTION_UNKNOWN));
});

test("fatal catalog failure waits for sibling discovery before releasing the client", async (t) => {
	const harness = connectionHarness();
	const manager = new McpConnectionManager<"alpha">({ maxCatalogStringBytes: 16 });
	manager.register(harness.connection);
	t.after(() => closeHarness(manager, harness.servers));
	await manager.connect("alpha");
	const client = await currentClient(manager);
	const resourceStarted = deferred();
	const releaseResource = deferred();
	t.mock.method(client, "getServerCapabilities", () => ({ resources: {}, tools: {} }));
	t.mock.method(client, "listTools", async () => ({
		tools: [{ ...listedTool, description: "x".repeat(17) }],
	}));
	t.mock.method(client, "listResources", async () => {
		resourceStarted.resolve();
		await releaseResource.promise;
		return { resources: [] };
	});
	t.mock.method(client, "listResourceTemplates", async () => ({ resourceTemplates: [] }));

	let refreshSettled = false;
	const refresh = manager.refreshCatalog("alpha");
	void refresh.then(
		() => {
			refreshSettled = true;
		},
		() => {
			refreshSettled = true;
		},
	);
	await resourceStarted.promise;
	await nextTurn();
	assert.equal(refreshSettled, false);

	let disconnectSettled = false;
	const disconnect = manager.disconnect("alpha");
	void disconnect.then(() => {
		disconnectSettled = true;
	});
	await nextTurn();
	assert.equal(disconnectSettled, false);

	releaseResource.resolve();
	await assert.rejects(refresh, hasCode(KMCP_ERROR_CODES.CATALOG_LIMIT_EXCEEDED));
	assert.equal((await disconnect).phase, "offline");
});

test("catalog refresh propagates cancellation without degrading or committing", async (t) => {
	const harness = connectionHarness();
	const manager = new McpConnectionManager<"alpha">();
	manager.register(harness.connection);
	t.after(() => closeHarness(manager, harness.servers));
	await manager.connect("alpha");
	const client = await currentClient(manager);
	const started = deferred();
	const release = deferred();
	let receivedSignal: AbortSignal | undefined;
	t.mock.method(client, "getServerCapabilities", () => ({ tools: {} }));
	t.mock.method(
		client,
		"listTools",
		async (_params?: Parameters<Client["listTools"]>[0], options?: CacheableRequestOptions) => {
			receivedSignal = options?.signal;
			started.resolve();
			await release.promise;
			return { tools: [listedTool] };
		},
	);

	const controller = new AbortController();
	const reason = new Error("caller cancelled refresh");
	const refresh = manager.refreshCatalog("alpha", controller.signal);
	await started.promise;
	assert.equal(receivedSignal, controller.signal);
	controller.abort(reason);
	release.resolve();
	await assert.rejects(refresh, (error: unknown) => error === reason);
	assert.equal(manager.state("alpha").phase, "online");
	assert.equal(manager.state("alpha").catalog, undefined);
});

test("catalog discovery rejects oversized nested structures before publication", async (t) => {
	const harness = connectionHarness();
	const manager = new McpConnectionManager<"alpha">({ maxCatalogStringBytes: 16 });
	manager.register(harness.connection);
	t.after(() => closeHarness(manager, harness.servers));
	await manager.connect("alpha");
	const client = await currentClient(manager);
	let description = "x".repeat(17);
	mockToolCatalog(t, client, async () => [
		{
			...listedTool,
			description,
		},
	]);

	await assert.rejects(
		manager.refreshCatalog("alpha"),
		hasCode(KMCP_ERROR_CODES.CATALOG_LIMIT_EXCEEDED),
	);
	assert.equal(manager.state("alpha").phase, "degraded");
	assert.equal(manager.state("alpha").catalog, undefined);

	description = "recovered";
	await manager.refreshCatalog("alpha");
	assert.equal(manager.state("alpha").phase, "online");
	assert.equal(manager.state("alpha").errorCode, undefined);
});

test("catalog capture omits undefined object properties but rejects undefined array entries", async (t) => {
	const harness = connectionHarness();
	const manager = new McpConnectionManager<"alpha">();
	manager.register(harness.connection);
	t.after(() => closeHarness(manager, harness.servers));
	await manager.connect("alpha");
	const client = await currentClient(manager);
	const toolWithOptionalUndefined: Tool = {
		name: listedTool.name,
		description: listedTool.description,
		inputSchema: { type: "object" },
	};
	Object.defineProperty(toolWithOptionalUndefined, "title", {
		value: undefined,
		enumerable: true,
		configurable: true,
	});
	Object.defineProperty(toolWithOptionalUndefined.inputSchema, "properties", {
		value: undefined,
		enumerable: true,
		configurable: true,
	});
	let discovered: Tool = toolWithOptionalUndefined;
	mockToolCatalog(t, client, async () => [discovered]);

	const normalized = await manager.refreshCatalog("alpha");
	const normalizedTool = normalized.tools.items[0];
	assert.ok(normalizedTool !== undefined);
	assert.equal(Object.hasOwn(normalizedTool, "title"), false);
	assert.equal(Object.hasOwn(normalizedTool.inputSchema, "properties"), false);
	assert.ok(Object.isFrozen(normalizedTool));
	assert.ok(Object.isFrozen(normalizedTool.inputSchema));

	discovered = {
		name: listedTool.name,
		description: listedTool.description,
		inputSchema: { type: "object" },
	};
	const naturallyOmitted = await manager.refreshCatalog("alpha");
	assert.equal(naturallyOmitted.tools.fingerprint, normalized.tools.fingerprint);
	assert.equal(naturallyOmitted.tools.byteSize, normalized.tools.byteSize);

	discovered = {
		name: listedTool.name,
		inputSchema: {
			type: "object",
			xRuntimeMalformed: [undefined],
		} as unknown as Tool["inputSchema"],
	};
	await assert.rejects(
		manager.refreshCatalog("alpha"),
		hasCode(KMCP_ERROR_CODES.CATALOG_LIMIT_EXCEEDED),
	);
});

test("catalog discovery caps node count, property fanout, and proxy inputs", async (t) => {
	await t.test("node count", async (t) => {
		await assertCatalogLimit(t, { maxCatalogNodes: 5 }, listedTool);
	});
	await t.test("property fanout", async (t) => {
		await assertCatalogLimit(t, { maxCatalogPropertiesPerObject: 2 }, listedTool);
	});
	await t.test("proxy input", async (t) => {
		await assertCatalogLimit(t, {}, new Proxy(listedTool, {}));
	});
});

test("failed-connect cleanup is quarantined and can be retried by disconnect", async (t) => {
	const transport = new RetryCleanupTransport();
	const manager = new McpConnectionManager<"alpha">();
	t.after(() => manager.close().catch(() => undefined));
	manager.register(
		new McpConnectionDefinition({
			id: "alpha",
			clientOptions: { versionNegotiation: { mode: "legacy" } },
			transport: () => transport,
		}),
	);

	await assert.rejects(manager.connect("alpha"), hasCode(KMCP_ERROR_CODES.CONNECTION_CLOSE_FAILED));
	assert.equal(manager.state("alpha").phase, "quarantined");
	assert.equal(transport.closeAttempts, 1);
	assert.throws(() => manager.connect("alpha"), hasCode(KMCP_ERROR_CODES.CONNECTION_QUARANTINED));

	assert.equal((await manager.disconnect("alpha")).phase, "offline");
	assert.equal(transport.closeAttempts, 2);
	await manager.close();
});

function connectionHarness(): {
	readonly connection: McpConnectionDefinition<"alpha">;
	readonly clientTransports: InMemoryTransport[];
	readonly servers: McpServer[];
	readonly openCount: () => number;
} {
	const clientTransports: InMemoryTransport[] = [];
	const servers: McpServer[] = [];
	let opens = 0;
	return {
		clientTransports,
		servers,
		openCount: () => opens,
		connection: new McpConnectionDefinition({
			id: "alpha",
			clientOptions: { versionNegotiation: { mode: "legacy" } },
			transport: async () => {
				opens += 1;
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				const server = new McpServer({ name: "manager-test", version: "1.0.0" });
				clientTransports.push(clientTransport);
				servers.push(server);
				await server.connect(serverTransport);
				return clientTransport;
			},
		}),
	};
}

async function currentClient(manager: McpConnectionManager<"alpha">): Promise<Client> {
	return manager.withClient("alpha", async (client) => client);
}

function mockToolCatalog(
	t: TestContext,
	client: Client,
	load: () => Promise<readonly Tool[]>,
): void {
	t.mock.method(client, "getServerCapabilities", () => ({ tools: {} }));
	t.mock.method(client, "listTools", async () => ({ tools: [...(await load())] }));
}

async function assertCatalogLimit(
	t: TestContext,
	options: McpConnectionManagerOptions,
	tool: Tool,
): Promise<void> {
	const harness = connectionHarness();
	const manager = new McpConnectionManager<"alpha">(options);
	manager.register(harness.connection);
	t.after(() => closeHarness(manager, harness.servers));
	await manager.connect("alpha");
	const client = await currentClient(manager);
	mockToolCatalog(t, client, async () => [tool]);
	await assert.rejects(
		manager.refreshCatalog("alpha"),
		hasCode(KMCP_ERROR_CODES.CATALOG_LIMIT_EXCEEDED),
	);
	assert.equal(manager.state("alpha").catalog, undefined);
}

async function closeHarness(
	manager: McpConnectionManager<"alpha">,
	servers: readonly McpServer[],
): Promise<void> {
	await manager.close().catch(() => undefined);
	await Promise.allSettled(servers.map((server) => server.close()));
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

function deferredValue<Value>(): {
	readonly promise: Promise<Value>;
	readonly resolve: (value: Value) => void;
} {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function hasCode(code: string): (error: unknown) => boolean {
	return (error: unknown): boolean => error instanceof KmcpError && error.code === code;
}

class RetryCleanupTransport implements Transport {
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: JSONRPCMessage) => void;
	closeAttempts = 0;

	async start(): Promise<void> {
		throw new Error("connect failed");
	}

	async send(_message: JSONRPCMessage): Promise<void> {}

	async close(): Promise<void> {
		this.closeAttempts += 1;
		if (this.closeAttempts === 1) throw new Error("cleanup failed");
		this.onclose?.();
	}
}
