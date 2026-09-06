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
	defineTool,
	inProcessConnection,
	textContent,
	toolResult,
	type McpConnectionEvent,
} from "../src/index.ts";
import { IGNORE, createRawLegacyServer } from "./helpers/raw-server.ts";

/** See `test/client-resilience.test.ts`: the manager publishes several events in one tick. */
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

async function eventually(check: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
	const startedAt = Date.now();
	while (!check()) {
		if (Date.now() - startedAt > timeoutMs) assert.fail(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function currentClient<Id extends string>(
	manager: McpConnectionManager<Id>,
	id: Id,
): Promise<Client> {
	return manager.withClient(id, async (client) => client);
}

/** A controllable stand-in for a `subscriptions/listen` stream. */
interface FakeStream {
	readonly filter: SubscriptionFilter;
	closes: number;
	drop(): void;
	readonly subscription: McpSubscription;
}

function fakeStream(filter: SubscriptionFilter, dropped = false): FakeStream {
	let settle!: (reason: "graceful" | "local" | "remote") => void;
	const closed = new Promise<"graceful" | "local" | "remote">((resolve) => {
		settle = resolve;
	});
	const record: FakeStream = {
		filter,
		closes: 0,
		drop: () => settle("remote"),
		subscription: {
			honoredFilter: filter,
			closed,
			close: async () => {
				record.closes += 1;
				settle("local");
			},
		},
	};
	if (dropped) settle("remote");
	return record;
}

function watchedServer(label: string) {
	return defineServer(
		{ name: label, version: "1.0.0" },
		{
			capabilities: [
				defineTool("echo", {}, async () => toolResult(textContent("ok"))),
				defineResource("doc", "doc://one", {}, async (uri) => ({
					contents: [{ uri: uri.href, text: "one" }],
				})),
			],
		},
	);
}

test("concurrent subscribeResource calls leave exactly one listen stream open", async (t) => {
	const manager = new McpConnectionManager<"m">();
	t.after(() => manager.close());
	manager.register(
		inProcessConnection({ id: "m", definition: watchedServer("relisten"), era: "modern" }),
	);
	await manager.connect("m");
	const client = await currentClient(manager, "m");
	const streams: FakeStream[] = [];
	t.mock.method(client, "listen", async (filter: SubscriptionFilter): Promise<McpSubscription> => {
		// Yield so a second opener can enter before this one resolves.
		await new Promise((resolve) => setTimeout(resolve, 5));
		const stream = fakeStream(filter);
		streams.push(stream);
		return stream.subscription;
	});
	await Promise.all([
		manager.subscribeResource("m", "doc://one"),
		manager.subscribeResource("m", "doc://two"),
	]);
	const open = streams.filter((stream) => stream.closes === 0);
	assert.equal(streams.length, 2, "each call opened a stream");
	assert.equal(open.length, 1, "the superseded stream was closed, not orphaned");
	assert.deepEqual(open[0]?.filter.resourceSubscriptions, ["doc://one", "doc://two"]);
	assert.deepEqual(manager.state("m").subscribedResources, ["doc://one", "doc://two"]);
});

test("a listen open that fails at connect time is retried with the drop backoff", async (t) => {
	let refuse = 2;
	const manager = new McpConnectionManager<"r">();
	t.after(() => manager.close());
	const recorded = recordEvents(manager);
	manager.register(
		inProcessConnection({
			id: "r",
			definition: watchedServer("repair"),
			era: "modern",
			autoRefreshCatalog: { debounceMs: 0, minIntervalMs: 0, maxRefreshesPerGeneration: 3 },
			configureClient: (client) => {
				const open = client.listen.bind(client);
				// The SDK's own auto-open is the first refusal, `#repairListen`'s attempt the second.
				client.listen = async (filter, options) => {
					if (refuse > 0) {
						refuse -= 1;
						throw new Error("listen refused");
					}
					return open(filter, options);
				};
			},
		}),
	);
	const connected = await manager.connect("r");
	assert.equal(connected.phase, "online");
	assert.equal(connected.watch?.active, false, "nothing is listening yet");
	const reopened = await recorded.waitFor((event) => event.type === "connection.listen.reopened");
	assert.equal(reopened.connection.watch?.active, true);
	assert.ok(reopened.connection.watch?.honoredSections.includes("tools"));
});

test("an unexpected close drops the dead generation's listen handle", async (t) => {
	const streams: FakeStream[] = [];
	const manager = new McpConnectionManager<"d">();
	t.after(() => manager.close());
	const recorded = recordEvents(manager);
	manager.register(
		inProcessConnection({
			id: "d",
			definition: watchedServer("stale"),
			era: "modern",
			reconnect: { maxAttempts: 2, backoff: { initialMs: 10, maxMs: 20 } },
			configureClient: (client) => {
				client.listen = async (filter) => {
					const stream = fakeStream(filter);
					streams.push(stream);
					return stream.subscription;
				};
			},
		}),
	);
	const first = await manager.connect("d");
	await manager.subscribeResource("d", "doc://one");
	assert.equal(streams.length, 1);
	// An unexpected close (not a disconnect): the generation dies with its stream.
	await manager.withClient("d", async (client) => client.close());
	const back = await recorded.waitFor(
		(event) =>
			event.type === "connection.state.changed" &&
			event.connection.phase === "online" &&
			event.connection.generation !== first.generation,
	);
	assert.equal(
		back.connection.subscribedResources,
		undefined,
		"subscriptions are generation-scoped",
	);
	await manager.subscribeResource("d", "doc://two");
	assert.equal(streams.length, 2);
	assert.equal(streams[0]?.closes, 0, "the dead generation's stream is never touched again");
	assert.deepEqual(streams[1]?.filter.resourceSubscriptions, ["doc://two"]);
});

test("a session the SDK adopted without a handshake takes the resumed code paths", async (t) => {
	const server = createRawLegacyServer({
		handlers: {
			"tools/list": () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }),
		},
	});
	// The factory hands back a transport carrying a DIFFERENT session id than the record names;
	// the SDK still skips the handshake, so the connection knows no era and no capabilities.
	server.transport.sessionId = "rotated-2";
	const manager = new McpConnectionManager<"a">();
	t.after(() => manager.close());
	manager.register(
		defineConnection({
			id: "a",
			transport: () => server.transport,
			resumed: {
				sessionId: "expected-1",
				protocolVersion: "2025-11-25",
				capabilities: { tools: {} },
			},
		}),
	);
	const snapshot = await manager.connect("a");
	assert.ok(
		!server.received.some((message) => message.method === "initialize"),
		"no handshake ran",
	);
	assert.equal(snapshot.sessionId, "rotated-2");
	assert.equal(snapshot.protocolEra, "legacy", "the era falls back to the resumed record");
	const listed = await manager.listTools("a");
	assert.deepEqual(
		listed.tools.map((tool) => tool.name),
		["echo"],
		"the list verb walks the pages itself instead of answering an empty list",
	);
	assert.ok(server.received.some((message) => message.method === "tools/list"));
});

test("setLogLevel records the level only once the upstream accepted it", async (t) => {
	let refuse = true;
	const server = createRawLegacyServer({
		capabilities: { tools: {}, logging: {} },
		handlers: {
			"logging/setLevel": () => {
				if (refuse) throw new Error("refused");
				return {};
			},
		},
	});
	const manager = new McpConnectionManager<"l">();
	t.after(() => manager.close());
	manager.register(
		defineConnection({
			id: "l",
			transport: () => server.transport,
			protocolVersion: "2025-11-25",
			logLevel: "debug",
		}),
	);
	await manager.connect("l");
	await assert.rejects(manager.setLogLevel("l", "warning"));
	assert.equal(manager.state("l").logLevel, "debug", "a refused level is not recorded");
	refuse = false;
	await manager.setLogLevel("l", "warning");
	assert.equal(manager.state("l").logLevel, "warning");
});

test("a cleanup failure after a failed connect reports the CLEANUP error", async (t) => {
	const transport: Transport = {
		start: async () => {
			throw new SdkHttpError(SdkErrorCode.ClientHttpUnexpectedContent, "unavailable", {
				status: 503,
			});
		},
		send: async () => undefined,
		close: async () => undefined,
	};
	const manager = new McpConnectionManager<"q">();
	t.after(() => manager.close().catch(() => undefined));
	manager.register(
		defineConnection({
			id: "q",
			transport: () => transport,
			protocolVersion: "2025-11-25",
			configureClient: (client) => {
				client.close = async () => {
					throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
				};
			},
		}),
	);
	await assert.rejects(
		manager.connect("q"),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.CONNECTION_CLOSE_FAILED,
	);
	assert.equal(manager.state("q").phase, "quarantined");
	// The reported code is the cleanup's, so the detail must be the cleanup's too (not the 503).
	assert.deepEqual(manager.state("q").errorDetail, { kind: "network", code: "ECONNRESET" });
});

test("the watch snapshot follows the stream the manager tracks, not the SDK's closed handle", async (t) => {
	const manager = new McpConnectionManager<"w">();
	t.after(() => manager.close());
	const recorded = recordEvents(manager);
	manager.register(
		inProcessConnection({
			id: "w",
			definition: watchedServer("watch"),
			era: "modern",
			autoRefreshCatalog: { debounceMs: 0, minIntervalMs: 0, maxRefreshesPerGeneration: 3 },
		}),
	);
	const connected = await manager.connect("w");
	assert.equal(connected.watch?.active, true, "the SDK's auto-opened stream is watched");
	const client = await currentClient(manager, "w");
	const streams: FakeStream[] = [];
	t.mock.method(client, "listen", async (filter: SubscriptionFilter): Promise<McpSubscription> => {
		const stream = fakeStream(filter);
		streams.push(stream);
		return stream.subscription;
	});
	// Subscribing replaces the SDK's auto-opened stream (and closes it); dropping the replacement
	// must leave nothing reported as honored, even though `autoOpenedSubscription` still answers.
	await manager.subscribeResource("w", "doc://one");
	assert.ok(client.autoOpenedSubscription?.honoredFilter.toolsListChanged);
	streams[0]?.drop();
	const dropped = await recorded.waitFor((event) => event.type === "connection.listen.dropped");
	assert.equal(dropped.connection.watch?.active, false);
	assert.deepEqual(dropped.connection.watch?.honoredSections, []);
	assert.equal(manager.state("w").watch?.active, false);
});

test("a listen stream dropped before the connect reaches online is re-opened", async (t) => {
	let call = 0;
	const manager = new McpConnectionManager<"c">();
	t.after(() => manager.close());
	const recorded = recordEvents(manager);
	manager.register(
		inProcessConnection({
			id: "c",
			definition: watchedServer("connecting"),
			era: "modern",
			autoRefreshCatalog: { debounceMs: 0, minIntervalMs: 0, maxRefreshesPerGeneration: 3 },
			configureClient: (client) => {
				const open = client.listen.bind(client);
				client.listen = async (filter, options) => {
					call += 1;
					// 1: the SDK's auto-open fails, so `#repairListen` owns the stream.
					if (call === 1) throw new Error("listen refused");
					// 2: `#repairListen` gets a stream that is already gone remotely — the manager is
					// still in its `connecting` phase when the drop lands.
					if (call === 2) return fakeStream(filter, true).subscription;
					return open(filter, options);
				};
			},
		}),
	);
	await manager.connect("c");
	const dropped = await recorded.waitFor((event) => event.type === "connection.listen.dropped");
	assert.equal(
		dropped.connection.phase,
		"connecting",
		"the drop landed before the online transition",
	);
	const reopened = await recorded.waitFor((event) => event.type === "connection.listen.reopened");
	assert.equal(reopened.connection.watch?.active, true);
	assert.equal(reopened.connection.watch?.reopens, 1);
});

test("subscribeResource fails when the session is replaced mid-subscribe", async (t) => {
	const manager = new McpConnectionManager<"s">();
	t.after(() => manager.close());
	manager.register(
		inProcessConnection({ id: "s", definition: watchedServer("fence"), era: "modern" }),
	);
	await manager.connect("s");
	const client = await currentClient(manager, "s");
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const streams: FakeStream[] = [];
	t.mock.method(client, "listen", async (filter: SubscriptionFilter): Promise<McpSubscription> => {
		await gate;
		const stream = fakeStream(filter);
		streams.push(stream);
		return stream.subscription;
	});
	const pending = manager.subscribeResource("s", "doc://one");
	await new Promise((resolve) => setTimeout(resolve, 10));
	// The session dies while the listen stream is still opening.
	await client.close();
	release();
	await assert.rejects(
		pending,
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.CONNECTION_NOT_ONLINE,
	);
	assert.equal(manager.state("s").subscribedResources, undefined, "the URI was rolled back");
	assert.equal(streams[0]?.closes, 1, "the orphaned stream was closed");
});

test("a refresh that never ran does not spend the generation's refresh budget", async (t) => {
	let toolsChanged: (() => Promise<void>) | undefined;
	const definition = defineServer(
		{ name: "budget", version: "1.0.0" },
		{ capabilities: [defineTool("echo", {}, async () => toolResult(textContent("ok")))] },
	);
	const manager = new McpConnectionManager<"b">();
	t.after(() => manager.close());
	manager.register(
		inProcessConnection({
			id: "b",
			definition: {
				handler: (options) => {
					const handler = definition.handler(options);
					toolsChanged = async () => {
						await handler.notify.toolsChanged();
					};
					return handler;
				},
				instantiate: (context) => definition.instantiate(context),
			},
			era: "modern",
			autoRefreshCatalog: { debounceMs: 0, minIntervalMs: 0, maxRefreshesPerGeneration: 2 },
		}),
	);
	await manager.connect("b");
	assert.ok(toolsChanged !== undefined);
	const real = manager.refreshCatalog.bind(manager);
	let flaps = 1;
	const refresh = t.mock.method(manager, "refreshCatalog", (id: "b") => {
		if (flaps > 0) {
			flaps -= 1;
			// What a flap looks like from `#scheduleAutoRefresh`: the refresh never reached the wire.
			return Promise.reject(
				new KmcpError(KMCP_ERROR_CODES.CONNECTION_NOT_ONLINE, "connection flapped"),
			);
		}
		return real(id);
	});
	for (const attempt of [1, 2, 3]) {
		await toolsChanged();
		await eventually(() => refresh.mock.callCount() >= attempt, `refresh attempt ${attempt}`);
	}
	await eventually(() => manager.state("b").watch?.refreshes === 2, "two committed refreshes");
	assert.equal(manager.state("b").phase, "online", "the cap was not tripped by the flap");
	assert.equal(manager.state("b").errorCode, undefined);
	assert.equal(manager.state("b").watch?.reason, undefined);
});

test("the keepalive verdict snapshot still carries the failure counters", async (t) => {
	let silent = false;
	const server = createRawLegacyServer({ handlers: { ping: () => (silent ? IGNORE : {}) } });
	const manager = new McpConnectionManager<"k">();
	t.after(() => manager.close());
	const recorded = recordEvents(manager);
	manager.register(
		defineConnection({
			id: "k",
			transport: () => server.transport,
			protocolVersion: "2025-11-25",
			keepalive: { intervalMs: 10, timeoutMs: 30, failureThreshold: 2 },
		}),
	);
	await manager.connect("k");
	silent = true;
	const failed = await recorded.waitFor(
		(event) => event.type === "connection.state.changed" && event.connection.phase === "failed",
	);
	assert.equal(failed.connection.errorCode, KMCP_ERROR_CODES.CONNECTION_KEEPALIVE_FAILED);
	assert.equal(failed.connection.keepalive?.failures, 2, "the snapshot explains the verdict");
	assert.ok(failed.connection.keepalive?.lastFailureAt);
	assert.equal(manager.state("k").keepalive?.failures, 2);
	await manager.disconnect("k");
	assert.equal(manager.state("k").keepalive, undefined, "a deliberate disconnect clears them");
});

test("the one-shot resume survives a failed connect and is burned on a session expiry", async (t) => {
	const server = createRawLegacyServer();
	server.transport.sessionId = "live-1";
	let pendingAtOpen: boolean | undefined;
	const live = defineConnection({
		id: "live",
		transport: () => {
			pendingAtOpen = live.resumePending;
			return server.transport;
		},
		resumed: { sessionId: "live-1", protocolVersion: "2025-11-25", capabilities: { tools: {} } },
	});
	const failing = (id: "expired" | "flaky", status: number) =>
		defineConnection({
			id,
			transport: () => ({
				start: async () => {
					throw new SdkHttpError(SdkErrorCode.ClientHttpUnexpectedContent, "gone", { status });
				},
				send: async () => undefined,
				close: async () => undefined,
			}),
			resumed: { sessionId: `${id}-1`, protocolVersion: "2025-11-25" },
		});
	const expired = failing("expired", 404);
	const flaky = failing("flaky", 503);
	const manager = new McpConnectionManager<"expired" | "flaky" | "live">();
	t.after(() => manager.close());
	for (const definition of [live, expired, flaky]) manager.register(definition);

	assert.equal(live.resumePending, true);
	await manager.connect("live");
	assert.equal(pendingAtOpen, true, "the transport factory only peeks at the record");
	assert.equal(live.resumePending, false, "a successful connect spends it");

	await assert.rejects(manager.connect("flaky"));
	assert.equal(flaky.resumePending, true, "a plain failure keeps the record for the retry");
	await assert.rejects(manager.connect("expired"));
	assert.equal(expired.resumePending, false, "a 404 burns it so the retry handshakes fresh");
});

test("every generation that adopts a session relaxes strict capability enforcement", async (t) => {
	// A transport that keeps handing back the same server-side session id: the SDK skips the
	// handshake on EVERY generation, long after the definition's one-shot record is spent.
	const transport = () => {
		const server = createRawLegacyServer({
			handlers: {
				"tools/list": () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }),
			},
		});
		server.transport.sessionId = "sticky-1";
		return server.transport;
	};
	const definition = defineConnection({
		id: "sticky",
		transport,
		resumed: { sessionId: "sticky-1", protocolVersion: "2025-11-25", capabilities: { tools: {} } },
	});
	const manager = new McpConnectionManager<"sticky">();
	t.after(() => manager.close());
	manager.register(definition);
	await manager.connect("sticky");
	assert.equal(definition.resumePending, false);
	assert.equal(definition.enforceStrictCapabilities, true, "the definition would now enforce");
	await manager.disconnect("sticky");
	await manager.connect("sticky");
	const listed = await manager.listTools("sticky");
	assert.deepEqual(
		listed.tools.map((tool) => tool.name),
		["echo"],
		"the second adopted generation can still reach the wire",
	);
});
