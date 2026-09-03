import assert from "node:assert/strict";
import test from "node:test";

import {
	type Client,
	type McpSubscription,
	SdkErrorCode,
	SdkHttpError,
	type SubscriptionFilter,
	type Transport,
} from "@modelcontextprotocol/client";

import {
	KMCP_ERROR_CODES,
	KmcpError,
	McpConnectionManager,
	defineConnection,
	defineResource,
	defineServer,
	inProcessConnection,
	type McpConnectionEvent,
} from "../src/index.ts";
import { IGNORE, createRawLegacyServer } from "./helpers/raw-server.ts";

/**
 * Records every manager event so a test can wait for one that may already have been published:
 * the manager publishes `state.changed`, the cause event and `reconnect.scheduled` synchronously
 * in one tick, so subscribing after the first of them would miss the rest.
 */
function recordEvents<Id extends string>(manager: McpConnectionManager<Id>) {
	const events: McpConnectionEvent<Id>[] = [];
	const waiters: {
		predicate: (event: McpConnectionEvent<Id>) => boolean;
		resolve: (event: McpConnectionEvent<Id>) => void;
	}[] = [];
	manager.subscribe((event) => {
		events.push(event);
		for (const waiter of [...waiters]) {
			if (!waiter.predicate(event)) continue;
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve(event);
		}
	});
	return {
		events,
		waitFor(
			predicate: (event: McpConnectionEvent<Id>) => boolean,
			timeoutMs = 5000,
		): Promise<McpConnectionEvent<Id>> {
			const seen = events.find(predicate);
			if (seen !== undefined) return Promise.resolve(seen);
			return new Promise((resolve, reject) => {
				const waiter = {
					predicate,
					resolve: (event: McpConnectionEvent<Id>) => {
						clearTimeout(timer);
						resolve(event);
					},
				};
				const timer = setTimeout(() => {
					const index = waiters.indexOf(waiter);
					if (index >= 0) waiters.splice(index, 1);
					reject(new Error("event did not arrive in time"));
				}, timeoutMs);
				waiters.push(waiter);
			});
		},
	};
}

async function currentClient<Id extends string>(
	manager: McpConnectionManager<Id>,
	id: Id,
): Promise<Client> {
	return manager.withClient(id, async (client) => client);
}

test("keepalive declares a silent upstream dead and hands over to the reconnect policy", async (t) => {
	let silent = false;
	const server = createRawLegacyServer({
		handlers: { ping: () => (silent ? IGNORE : {}) },
	});
	const manager = new McpConnectionManager<"ka">();
	t.after(() => manager.close());
	const recorded = recordEvents(manager);
	manager.register(
		defineConnection({
			id: "ka",
			transport: () => server.transport,
			protocolVersion: "2025-11-25",
			keepalive: { intervalMs: 15, timeoutMs: 40, failureThreshold: 2 },
			reconnect: { maxAttempts: 1, backoff: { initialMs: 20_000, maxMs: 60_000 } },
		}),
	);
	await manager.connect("ka");
	// A successful probe publishes nothing; it only refreshes lastSeenAt and the keepalive snapshot.
	for (
		let attempt = 0;
		attempt < 100 && manager.state("ka").keepalive?.lastProbeAt === undefined;
		attempt += 1
	) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(manager.state("ka").keepalive?.lastProbeAt, "a probe succeeded");
	assert.equal(manager.state("ka").keepalive?.failures, 0);
	silent = true;
	const firstFailure = await recorded.waitFor(
		(event) => event.type === "connection.keepalive.failed",
	);
	assert.equal(firstFailure.connection.keepalive?.failures, 1);
	const failed = await recorded.waitFor(
		(event) => event.type === "connection.state.changed" && event.connection.phase === "failed",
	);
	assert.equal(failed.connection.errorCode, KMCP_ERROR_CODES.CONNECTION_KEEPALIVE_FAILED);
	assert.equal(failed.connection.errorDetail?.kind, "sdk");
	const scheduled = await recorded.waitFor(
		(event) => event.type === "connection.reconnect.scheduled",
	);
	assert.equal(scheduled.connection.reconnect?.attempts, 1);
	assert.equal(
		recorded.events.filter((event) => event.type === "connection.keepalive.failed").length,
		2,
	);
	await assert.rejects(manager.callTool("ka", "x"), (error: unknown) => error instanceof KmcpError);
});

test("a 404 on a session-bearing transport expires the generation and publishes session.expired", async (t) => {
	const definition = defineServer({ name: "sess", version: "1.0.0" });
	const manager = new McpConnectionManager<"http">();
	t.after(() => manager.close());
	const recorded = recordEvents(manager);
	manager.register(
		inProcessConnection({
			id: "http",
			definition,
			era: "legacy",
			reconnect: { maxAttempts: 1, backoff: { initialMs: 20_000, maxMs: 60_000 } },
		}),
	);
	await manager.connect("http");
	const client = await currentClient(manager, "http");
	// Pretend the server issued a session id (set AFTER connect so the handshake was not skipped).
	(client.transport as Transport).sessionId = "session-1";
	assert.equal(manager.state("http").sessionId, "session-1");
	assert.equal(manager.state("http").connectionMode, "stateful");
	t.mock.method(client, "listTools", async () => {
		throw new SdkHttpError(SdkErrorCode.ClientHttpUnexpectedContent, "Not found", { status: 404 });
	});
	await assert.rejects(
		manager.listTools("http"),
		(error: unknown) => error instanceof SdkHttpError,
	);
	const event = await recorded.waitFor((event) => event.type === "connection.session.expired");
	assert.equal(event.connection.phase, "failed");
	assert.equal(event.connection.errorCode, KMCP_ERROR_CODES.CONNECTION_SESSION_EXPIRED);
	assert.deepEqual(event.connection.errorDetail, { kind: "http", code: 404, httpStatus: 404 });
	assert.equal(event.connection.sessionId, undefined);
	await recorded.waitFor((event) => event.type === "connection.reconnect.scheduled");
	assert.ok(
		recorded.events.findIndex((e) => e.type === "connection.session.expired") <
			recorded.events.findIndex((e) => e.type === "connection.reconnect.scheduled"),
		"the cause is announced before the reconnect",
	);
});

test("a 404 without a session id is an ordinary failure, not an expiry", async (t) => {
	const manager = new McpConnectionManager<"plain">();
	t.after(() => manager.close());
	manager.register(
		inProcessConnection({
			id: "plain",
			definition: defineServer({ name: "p", version: "1" }),
			era: "modern",
		}),
	);
	await manager.connect("plain");
	const client = await currentClient(manager, "plain");
	t.mock.method(client, "listTools", async () => {
		throw new SdkHttpError(SdkErrorCode.ClientHttpUnexpectedContent, "Not found", { status: 404 });
	});
	await assert.rejects(manager.listTools("plain"));
	assert.equal(manager.state("plain").phase, "online");
});

test("disconnect sends the session-terminating DELETE once and can be opted out", async () => {
	for (const terminate of [true, false]) {
		const server = createRawLegacyServer();
		let deletes = 0;
		const transport = server.transport as Transport & { terminateSession?: () => Promise<void> };
		transport.terminateSession = async () => {
			deletes += 1;
		};
		const manager = new McpConnectionManager<"term">();
		manager.register(
			defineConnection({
				id: "term",
				transport: () => transport,
				protocolVersion: "2025-11-25",
				terminateSession: terminate,
			}),
		);
		await manager.connect("term");
		assert.equal(manager.state("term").transportKind, "streamable-http");
		transport.sessionId = "abc";
		await manager.disconnect("term");
		assert.equal(deletes, terminate ? 1 : 0);
		await manager.close();
	}
});

test("a hung close is bounded by disconnectTimeoutMs and quarantines the connection", async (t) => {
	const manager = new McpConnectionManager<"hang">();
	t.after(() => manager.close().catch(() => undefined));
	manager.register(
		inProcessConnection({
			id: "hang",
			definition: defineServer({ name: "h", version: "1" }),
			era: "modern",
			disconnectTimeoutMs: 30,
		}),
	);
	await manager.connect("hang");
	const client = await currentClient(manager, "hang");
	t.mock.method(client, "close", () => new Promise<void>(() => undefined));
	await assert.rejects(
		manager.disconnect("hang"),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.CONNECTION_CLOSE_FAILED,
	);
	assert.equal(manager.state("hang").phase, "quarantined");
	assert.equal(manager.state("hang").errorDetail?.code, KMCP_ERROR_CODES.HANDLER_TIMEOUT);
});

test("snapshots carry transport kind, connection mode, lastSeenAt and supported versions", async (t) => {
	const definition = defineServer({ name: "snap", version: "1.0.0" });
	const manager = new McpConnectionManager<"modern" | "legacy">();
	t.after(() => manager.close());
	manager.register(inProcessConnection({ id: "modern", definition, era: "modern" }));
	manager.register(inProcessConnection({ id: "legacy", definition, era: "legacy" }));
	await manager.connectAll(["modern", "legacy"]);
	const modern = manager.state("modern");
	assert.equal(modern.transportKind, "in-process");
	assert.equal(modern.connectionMode, "stateless");
	assert.ok(modern.lastSeenAt);
	assert.ok(modern.supportedVersions?.includes("2026-07-28"));
	const legacy = manager.state("legacy");
	assert.equal(legacy.connectionMode, "stateful");
	assert.equal(legacy.supportedVersions, undefined);
	const before = modern.lastSeenAt;
	await new Promise((resolve) => setTimeout(resolve, 5));
	await manager.ping("modern");
	assert.notEqual(manager.state("modern").lastSeenAt, before);
	const live = await manager.discover("modern");
	assert.ok(live.supportedVersions.includes("2026-07-28"));
	await assert.rejects(manager.discover("legacy"), (error: unknown) => error instanceof KmcpError);
});

test("a remotely dropped listen stream is re-opened and reported", async (t) => {
	const definition = defineServer(
		{ name: "listen", version: "1.0.0" },
		{
			capabilities: [
				defineResource("doc", "doc://one", {}, async (uri) => ({
					contents: [{ uri: uri.href, text: "one" }],
				})),
			],
		},
	);
	const manager = new McpConnectionManager<"m">();
	t.after(() => manager.close());
	const recorded = recordEvents(manager);
	manager.register(inProcessConnection({ id: "m", definition, era: "modern" }));
	await manager.connect("m");
	const client = await currentClient(manager, "m");
	const subscriptions: { filter: SubscriptionFilter; drop: () => void }[] = [];
	t.mock.method(client, "listen", async (filter: SubscriptionFilter): Promise<McpSubscription> => {
		let settle!: (reason: "local" | "graceful" | "remote") => void;
		const closed = new Promise<"local" | "graceful" | "remote">((resolve) => {
			settle = resolve;
		});
		subscriptions.push({ filter, drop: () => settle("remote") });
		return { honoredFilter: filter, close: async () => settle("local"), closed };
	});
	await manager.subscribeResource("m", "doc://one");
	assert.equal(subscriptions.length, 1);
	assert.deepEqual(subscriptions[0]?.filter.resourceSubscriptions, ["doc://one"]);
	subscriptions[0]?.drop();
	await recorded.waitFor((event) => event.type === "connection.listen.dropped");
	const reopened = await recorded.waitFor(
		(event) => event.type === "connection.listen.reopened",
		4000,
	);
	assert.equal(subscriptions.length, 2);
	assert.equal(reopened.connection.watch?.reopens, 1);
	assert.deepEqual(reopened.connection.subscribedResources, ["doc://one"]);
});

test("a draft-07 outputSchema from a 2025-era server validates with the SDK's default validator", async (t) => {
	const server = createRawLegacyServer({
		handlers: {
			"tools/list": () => ({
				tools: [
					{
						name: "legacy",
						inputSchema: { type: "object" },
						outputSchema: {
							$schema: "http://json-schema.org/draft-07/schema#",
							type: "object",
							properties: { ok: { type: "boolean" } },
							required: ["ok"],
						},
					},
				],
			}),
			"tools/call": () => ({
				content: [{ type: "text", text: '{"ok":true}' }],
				structuredContent: { ok: true },
			}),
		},
	});
	const manager = new McpConnectionManager<"v">();
	t.after(() => manager.close());
	manager.register(
		defineConnection({ id: "v", transport: () => server.transport, protocolVersion: "2025-11-25" }),
	);
	await manager.connect("v");
	await manager.listTools("v");
	const result = await manager.callTool("v", "legacy", {});
	assert.deepEqual(result.structuredContent, { ok: true });
});

test("callTool enforces a tool contract before the request goes out", async (t) => {
	const server = createRawLegacyServer({
		handlers: {
			"tools/list": () => ({
				tools: [
					{
						name: "echo",
						inputSchema: {
							type: "object",
							properties: { value: { type: "string" }, extra: { type: "number" } },
							required: ["value", "extra"],
						},
					},
				],
			}),
			"tools/call": () => ({ content: [{ type: "text", text: "ok" }] }),
		},
	});
	const manager = new McpConnectionManager<"c">();
	t.after(() => manager.close());
	manager.register(
		defineConnection({ id: "c", transport: () => server.transport, protocolVersion: "2025-11-25" }),
	);
	await manager.connect("c");
	const expected = {
		name: "echo",
		inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
	};
	await assert.rejects(
		manager.callTool("c", "echo", { value: "v" }, { contract: { expected } }),
		(error: unknown) =>
			error instanceof KmcpError &&
			error.code === KMCP_ERROR_CODES.TOOL_CONTRACT_MISMATCH &&
			error.message.includes("extra"),
	);
	// Passing the new required argument satisfies a compatible contract.
	const ok = await manager.callTool(
		"c",
		"echo",
		{ value: "v", extra: 1 },
		{ contract: { expected } },
	);
	assert.equal((ok.content[0] as { text: string }).text, "ok");
	const check = await manager.checkToolContract("c", "echo", expected, {
		arguments: { value: "v" },
	});
	assert.equal(check.valid, false);
	const missing = await manager.checkToolContract("c", "nope", expected);
	assert.equal(missing.valid, false);
});
