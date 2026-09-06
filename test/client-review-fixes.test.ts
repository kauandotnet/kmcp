import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	InMemoryResponseCacheStore,
	KMCP_ERROR_CODES,
	KmcpError,
	MCP_MODERN_PROTOCOL_VERSION,
	McpConnectionManager,
	McpTaskClient,
	type McpTaskRequester,
	type Middleware,
	type RequestOptions,
	type StreamableHTTPClientTransport,
	type Task,
	createOfficialClient,
	defineConnection,
	defineServer,
	httpConnection,
	inProcessConnection,
	normalizeRoots,
	resolveSkillUri,
	sseConnection,
} from "../src/index.ts";
import { connectionsFromMcpConfig, discoverMcpConfigs, syncResourceToFile } from "../src/node.ts";
import { createFakeTaskServer, createRawLegacyServer } from "./helpers/raw-server.ts";

const URL_HTTP = "https://mcp.example.com/mcp";
const URL_SSE = "https://mcp.example.com/sse";

function invalidDefinition(error: unknown): boolean {
	return error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION;
}

/** The SDK's own view of a transport's static headers (what `_commonHeaders()` will send). */
async function commonHeaders(transport: unknown): Promise<Headers> {
	return await (transport as { _commonHeaders(): Promise<Headers> })._commonHeaders();
}

function neverOpens(): never {
	throw new Error("this definition never opens a transport");
}

async function eventually(check: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
	const startedAt = Date.now();
	while (!check()) {
		if (Date.now() - startedAt > timeoutMs) assert.fail(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

// ---------------------------------------------------------------------------
// 1. mcp config: the entry's own `timeout` beats the loader's defaults
// ---------------------------------------------------------------------------

test("a config entry's own timeout wins over the loader's default timeout", () => {
	const connections = connectionsFromMcpConfig(
		{
			mcpServers: {
				own: { command: "own-cmd", timeout: 5 },
				inherited: { command: "inherited-cmd" },
				remote: { url: URL_HTTP, timeout: 0.25 },
			},
		},
		{ defaults: { defaults: { timeoutMs: 111_000, toolTimeoutMs: 7 } } },
	);
	assert.equal(connections.own.defaults.timeoutMs, 5000);
	assert.equal(connections.remote.defaults.timeoutMs, 250);
	assert.equal(connections.inherited.defaults.timeoutMs, 111_000);
	// Unrelated loader defaults still merge in under the entry's timeout.
	assert.equal(connections.own.defaults.toolTimeoutMs, 7);
});

// ---------------------------------------------------------------------------
// 13. discovery: ENOTDIR / EISDIR mean "absent", not "unreadable"
// ---------------------------------------------------------------------------

test("config discovery treats ENOTDIR and EISDIR as absent, not as unreadable files", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "kmcp-cfg-"));
	const home = await mkdtemp(join(tmpdir(), "kmcp-home-"));
	// `.cursor` is a FILE, so `<cwd>/.cursor/mcp.json` fails with ENOTDIR.
	await writeFile(join(cwd, ".cursor"), "not a directory");
	// `.mcp.json` is a DIRECTORY, so reading it fails with EISDIR.
	await mkdir(join(cwd, ".mcp.json"));
	const clean = await discoverMcpConfigs({ cwd, homeDir: home, platform: "linux" });
	assert.deepEqual(clean.problems, []);
	assert.deepEqual(clean.configs, []);

	// A genuinely unreadable file is still reported.
	if (process.getuid?.() !== 0) {
		await writeFile(join(cwd, "mcp.json"), "{}", { mode: 0o000 });
		const denied = await discoverMcpConfigs({ cwd, homeDir: home, platform: "linux" });
		assert.deepEqual(
			denied.problems.map((problem) => problem.error),
			["unreadable"],
		);
	}
});

// ---------------------------------------------------------------------------
// 12. normalizeRoots: a Windows drive letter is a path, not a URI scheme
// ---------------------------------------------------------------------------

test("normalizeRoots routes Windows drive-letter paths through file:// instead of treating C: as a scheme", () => {
	assert.deepEqual(normalizeRoots(["C:\\Users\\me\\proj"]), [{ uri: "file:///C:/Users/me/proj" }]);
	assert.deepEqual(normalizeRoots(["d:/data/store"]), [{ uri: "file:///d:/data/store" }]);
	// Real schemes and POSIX paths are unchanged.
	assert.deepEqual(normalizeRoots(["https://example.com/x"]), [{ uri: "https://example.com/x" }]);
	assert.deepEqual(normalizeRoots(["file:///already"]), [{ uri: "file:///already" }]);
	assert.deepEqual(normalizeRoots(["/srv/data"]), [{ uri: "file:///srv/data" }]);
	assert.deepEqual(normalizeRoots(["relative/dir"]), [{ uri: "file:///relative/dir" }]);
	assert.deepEqual(normalizeRoots([{ uri: "file:///kept", name: "kept" }]), [
		{ uri: "file:///kept", name: "kept" },
	]);
});

// ---------------------------------------------------------------------------
// 8. skills: the traversal guard covers `skill://` references too
// ---------------------------------------------------------------------------

test("resolveSkillUri rejects traversal segments in skill:// references, encoded or not", () => {
	for (const reference of [
		"skill://../../etc/passwd",
		"skill://acme/../../etc/passwd",
		"skill://acme/./billing",
		"skill://%2e%2e/%2e%2e/etc/passwd",
		"skill://acme/%2E%2E/secrets",
		"..%2f..%2fetc%2fpasswd",
		"../../etc/passwd",
	]) {
		assert.throws(() => resolveSkillUri(reference), invalidDefinition, reference);
	}
	assert.equal(resolveSkillUri("skill://acme/billing"), "skill://acme/billing/SKILL.md");
	assert.equal(resolveSkillUri("skill://acme/billing/"), "skill://acme/billing/SKILL.md");
	assert.equal(resolveSkillUri("skill://index.json"), "skill://index.json");
	assert.equal(resolveSkillUri("git-workflow"), "skill://git-workflow/SKILL.md");
	assert.equal(resolveSkillUri("acme/billing/refunds"), "skill://acme/billing/refunds/SKILL.md");
});

// ---------------------------------------------------------------------------
// 3 + 6. Authorization overrides and header merging
// ---------------------------------------------------------------------------

test("an Authorization header in requestInit is refused next to auth, in every HeadersInit form", () => {
	const forms: HeadersInit[] = [
		{ authorization: "Bearer sneaky" },
		{ Authorization: "Bearer sneaky" },
		[["Authorization", "Bearer sneaky"]],
		new Headers({ Authorization: "Bearer sneaky" }),
	];
	for (const headers of forms) {
		assert.throws(
			() =>
				httpConnection({
					id: "http",
					url: URL_HTTP,
					auth: "token",
					transportOptions: { requestInit: { headers } },
				}),
			invalidDefinition,
		);
		assert.throws(
			() =>
				sseConnection({
					id: "sse",
					url: URL_SSE,
					auth: "token",
					transportOptions: { requestInit: { headers } },
				}),
			invalidDefinition,
		);
	}
	// The top-level `headers` route is still refused, and both are fine without `auth`.
	assert.throws(
		() =>
			httpConnection({ id: "http", url: URL_HTTP, auth: "token", headers: { authorization: "x" } }),
		invalidDefinition,
	);
	assert.doesNotThrow(() =>
		httpConnection({
			id: "http",
			url: URL_HTTP,
			transportOptions: { requestInit: { headers: { Authorization: "Bearer mine" } } },
		}),
	);
});

test("static headers merge over requestInit.headers instead of replacing them", async () => {
	const definition = httpConnection({
		id: "http",
		url: URL_HTTP,
		auth: "Bearer secret",
		headers: { "x-tenant": "acme", "x-shared": "from-headers" },
		transportOptions: {
			requestInit: {
				credentials: "include",
				headers: { "x-trace": "abc", "x-shared": "from-request-init" },
			},
		},
	});
	const transport = await definition.openTransport();
	const headers = await commonHeaders(transport);
	assert.equal(headers.get("x-trace"), "abc", "requestInit.headers survive");
	assert.equal(headers.get("x-tenant"), "acme", "definition headers survive");
	assert.equal(headers.get("x-shared"), "from-headers", "definition headers win on a clash");
	assert.equal(headers.get("authorization"), "Bearer secret", "the auth provider still wins");
	// The rest of `requestInit` is preserved, not dropped by the headers merge.
	const init = (transport as unknown as { _requestInit?: RequestInit })._requestInit;
	assert.equal(init?.credentials, "include");

	const sse = sseConnection({
		id: "sse",
		url: URL_SSE,
		headers: { "x-tenant": "acme" },
		transportOptions: { requestInit: { headers: [["x-trace", "abc"]] } },
	});
	const sseHeaders = await commonHeaders(await sse.openTransport());
	assert.equal(sseHeaders.get("x-trace"), "abc");
	assert.equal(sseHeaders.get("x-tenant"), "acme");
});

// ---------------------------------------------------------------------------
// 4. cache partitioning is never guessed from the credential
// ---------------------------------------------------------------------------

test("credentials with a shared response cache store demand an explicit cachePartition", () => {
	const store = new InMemoryResponseCacheStore();
	assert.throws(
		() => httpConnection({ id: "http", url: URL_HTTP, auth: "token", responseCacheStore: store }),
		invalidDefinition,
	);
	assert.throws(
		() => sseConnection({ id: "sse", url: URL_SSE, auth: "token", responseCacheStore: store }),
		invalidDefinition,
	);
	// A store reached through clientOptions counts as shared too.
	assert.throws(
		() =>
			httpConnection({
				id: "http",
				url: URL_HTTP,
				auth: "token",
				clientOptions: { responseCacheStore: store },
			}),
		invalidDefinition,
	);
	// An explicit partition is what makes it safe.
	assert.equal(
		httpConnection({
			id: "http",
			url: URL_HTTP,
			auth: "token",
			responseCacheStore: store,
			cachePartition: "subject-1",
		}).clientOptions.cachePartition,
		"subject-1",
	);
	// Without a shared store the SDK's per-client cache already isolates: nothing is derived, and
	// two identical tokens no longer collide into a hashed partition.
	const first = httpConnection({ id: "a", url: URL_HTTP, auth: "token" });
	const second = httpConnection({ id: "b", url: URL_HTTP, auth: "token" });
	assert.equal(first.clientOptions.cachePartition, undefined);
	assert.equal(second.clientOptions.cachePartition, undefined);
	// A store with no credentials is single-tenant and stays allowed.
	assert.doesNotThrow(() => httpConnection({ id: "c", url: URL_HTTP, responseCacheStore: store }));
});

// ---------------------------------------------------------------------------
// 9. middlewares run outermost-first, as documented
// ---------------------------------------------------------------------------

test("middlewares are composed outermost-first, matching the documented order", async () => {
	const order: string[] = [];
	const record =
		(label: string): Middleware =>
		(next) =>
		async (input, init) => {
			order.push(`${label}:in`);
			const response = await next(input, init);
			order.push(`${label}:out`);
			return response;
		};
	const definition = httpConnection({
		id: "http",
		url: URL_HTTP,
		middlewares: [record("first"), record("second")],
		transportOptions: {
			fetch: async () => {
				order.push("fetch");
				return new Response("{}", { status: 200 });
			},
		},
	});
	const transport = await definition.openTransport();
	const wrapped = (transport as unknown as { _fetch: typeof fetch })._fetch;
	await wrapped(URL_HTTP, {});
	assert.deepEqual(order, ["first:in", "second:in", "fetch", "second:out", "first:out"]);
});

// ---------------------------------------------------------------------------
// 7. the resume record is one-shot but survives a failed attempt
// ---------------------------------------------------------------------------

test("the resumed record is peeked by the transport factory and spent only by consumeResume", async () => {
	const definition = httpConnection({
		id: "resumed",
		url: URL_HTTP,
		resume: { sessionId: "session-1", protocolVersion: "2025-11-25" },
	});
	assert.equal(definition.resumePending, true);
	assert.equal(definition.enforceStrictCapabilities, false);
	assert.equal(definition.clientOptions.enforceStrictCapabilities, undefined);

	const first = (await definition.openTransport()) as StreamableHTTPClientTransport;
	assert.equal(first.sessionId, "session-1");
	// A connect attempt that dies after the transport was built (DNS, a 401 arming OAuth) must
	// leave the record intact, or the retry orphans the server-side session.
	assert.equal(definition.resumePending, true, "building a transport only peeks");
	const retry = (await definition.openTransport()) as StreamableHTTPClientTransport;
	assert.equal(retry.sessionId, "session-1");

	definition.consumeResume();
	assert.equal(definition.resumePending, false);
	const fresh = (await definition.openTransport()) as StreamableHTTPClientTransport;
	assert.equal(fresh.sessionId, undefined, "a later generation handshakes instead of resuming");
	// Strict enforcement comes back for every generation after the one-shot session.
	assert.equal(definition.enforceStrictCapabilities, true);
	assert.equal(
		(
			createOfficialClient(definition) as unknown as {
				_options?: { enforceStrictCapabilities?: boolean };
			}
		)._options?.enforceStrictCapabilities,
		true,
	);
	definition.consumeResume(); // idempotent
	assert.equal(definition.resumePending, false);

	// A definition with no resume record: nothing pending, consumeResume is a no-op, strict on.
	const plain = httpConnection({ id: "plain", url: URL_HTTP });
	assert.equal(plain.resumePending, false);
	plain.consumeResume();
	assert.equal(plain.enforceStrictCapabilities, true);
	assert.equal(plain.clientOptions.enforceStrictCapabilities, true);

	// An explicit pin still wins in both directions.
	const pinned = httpConnection({
		id: "pinned",
		url: URL_HTTP,
		resume: { sessionId: "session-2" },
		clientOptions: { enforceStrictCapabilities: true },
	});
	assert.equal(pinned.enforceStrictCapabilities, true);
	assert.equal(pinned.clientOptions.enforceStrictCapabilities, true);
	// And an override decides for one generation regardless of the definition.
	assert.equal(
		(
			createOfficialClient(plain, { enforceStrictCapabilities: false }) as unknown as {
				_options?: { enforceStrictCapabilities?: boolean };
			}
		)._options?.enforceStrictCapabilities,
		false,
	);
});

// ---------------------------------------------------------------------------
// minor: an explicit roots.listChanged is not driven back down to false
// ---------------------------------------------------------------------------

test("an explicit roots.listChanged survives the derived capabilities", () => {
	const declared = defineConnection({
		id: "declared",
		transport: neverOpens,
		requestHandlers: { "roots/list": async () => ({ roots: [] }) },
		inputRequired: { maxRounds: 1 },
		clientOptions: { capabilities: { roots: { listChanged: true } } },
	});
	assert.deepEqual(declared.clientOptions.capabilities?.roots, { listChanged: true });

	const staticRoots = defineConnection({
		id: "static",
		transport: neverOpens,
		roots: ["/srv/data"],
		inputRequired: { maxRounds: 1 },
	});
	assert.deepEqual(staticRoots.clientOptions.capabilities?.roots, { listChanged: false });

	const callbackRoots = defineConnection({
		id: "callback",
		transport: neverOpens,
		roots: () => ["/srv/data"],
		inputRequired: { maxRounds: 1 },
	});
	assert.deepEqual(callbackRoots.clientOptions.capabilities?.roots, { listChanged: true });

	// Nothing is advertised when no roots source exists at all.
	assert.equal(
		defineConnection({ id: "none", transport: neverOpens }).clientOptions.capabilities?.roots,
		undefined,
	);
});

// ---------------------------------------------------------------------------
// minor: in-process negotiation treats an omitted `mode` the same on both eras
// ---------------------------------------------------------------------------

test("inProcessConnection accepts a versionNegotiation without a mode on either era", () => {
	const definition = defineServer({ name: "sym", version: "1.0.0" });
	const modern = inProcessConnection({
		id: "modern",
		definition,
		era: "modern",
		clientOptions: { versionNegotiation: { probe: { timeoutMs: 1234 } } },
	});
	assert.deepEqual(modern.clientOptions.versionNegotiation, {
		probe: { timeoutMs: 1234 },
		mode: { pin: MCP_MODERN_PROTOCOL_VERSION },
	});
	const legacy = inProcessConnection({
		id: "legacy",
		definition,
		era: "legacy",
		clientOptions: { versionNegotiation: { probe: { timeoutMs: 1234 } } },
	});
	assert.deepEqual(legacy.clientOptions.versionNegotiation, {
		probe: { timeoutMs: 1234 },
		mode: "legacy",
	});
	// A mode that really does contradict the era is still refused.
	assert.throws(
		() =>
			inProcessConnection({
				id: "bad",
				definition,
				era: "modern",
				clientOptions: { versionNegotiation: { mode: "legacy" } },
			}),
		invalidDefinition,
	);
});

// ---------------------------------------------------------------------------
// 5 + 10. task polling: signals reach the wire, cadence follows the server
// ---------------------------------------------------------------------------

interface FakeRequest {
	readonly method: string;
	readonly params: Record<string, unknown> | undefined;
	readonly options: RequestOptions | undefined;
	readonly at: number;
}

function fakeTaskRequester(
	respond: (method: string, params: Record<string, unknown> | undefined) => unknown,
): McpTaskRequester & { readonly calls: FakeRequest[] } {
	const calls: FakeRequest[] = [];
	return {
		calls,
		request(request, _resultSchema, options) {
			calls.push({
				method: request.method,
				params: request.params,
				options,
				at: Date.now(),
			});
			return Promise.resolve(respond(request.method, request.params));
		},
		getProtocolEra: () => "legacy",
		getNegotiatedProtocolVersion: () => "2025-11-25",
		getServerCapabilities: () => ({ tasks: { requests: { tools: { call: {} } } } }),
	};
}

function fakeTask(status: Task["status"], pollInterval?: number): Task {
	return {
		taskId: "task-1",
		status,
		ttl: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		lastUpdatedAt: "2026-01-01T00:00:00.000Z",
		...(pollInterval === undefined ? {} : { pollInterval }),
	};
}

test("waitForTask forwards the caller's signal into every task request", async () => {
	const controller = new AbortController();
	const requester = fakeTaskRequester((method) =>
		method === "tasks/get" ? fakeTask("completed") : { content: [{ type: "text", text: "ok" }] },
	);
	const client = new McpTaskClient(requester);
	await client.waitForTask("task-1", {
		signal: controller.signal,
		request: { timeout: 4321 },
	});
	assert.deepEqual(
		requester.calls.map((call) => call.method),
		["tasks/get", "tasks/result"],
	);
	for (const call of requester.calls) {
		assert.equal(call.options?.signal, controller.signal, `${call.method} carried the signal`);
		assert.equal(call.options?.timeout, 4321, "the caller's request options are preserved");
	}
});

test("an abort raised during an in-flight tasks/get does not wait out a poll interval", async () => {
	const controller = new AbortController();
	const reason = new Error("caller stopped");
	const requester = fakeTaskRequester((method) => {
		if (method !== "tasks/get") return { content: [] };
		// The abort lands while this request is in flight; the SDK is stubbed out here, so the
		// loop only notices it in `sleep` — which must not wait for an `abort` that already fired.
		controller.abort(reason);
		return fakeTask("working");
	});
	const client = new McpTaskClient(requester);
	const startedAt = Date.now();
	await assert.rejects(
		client.waitForTask("task-1", { signal: controller.signal, pollIntervalMs: 60_000 }),
		(error: unknown) => error === reason,
	);
	assert.ok(Date.now() - startedAt < 2000, "the abort was answered immediately");
});

test("waitForTask follows the server's pollInterval and re-reads it on every poll", async () => {
	const intervals = [5, 150];
	let poll = 0;
	const requester = fakeTaskRequester((method) => {
		if (method !== "tasks/get") return { content: [{ type: "text", text: "done" }] };
		poll += 1;
		if (poll > intervals.length) return fakeTask("completed");
		return fakeTask("working", intervals[poll - 1]);
	});
	const client = new McpTaskClient(requester);
	await client.waitForTask("task-1");
	const polls = requester.calls.filter((call) => call.method === "tasks/get");
	assert.equal(polls.length, 3);
	const firstGap = (polls[1] as FakeRequest).at - (polls[0] as FakeRequest).at;
	const secondGap = (polls[2] as FakeRequest).at - (polls[1] as FakeRequest).at;
	// The 2000 ms default was never used, and the second snapshot's slower cadence was picked up.
	assert.ok(firstGap < 100, `first gap followed pollInterval 5 (was ${firstGap}ms)`);
	assert.ok(secondGap >= 100, `second gap followed pollInterval 150 (was ${secondGap}ms)`);
	assert.ok(secondGap < 1500, `second gap was not the 2000 ms default (was ${secondGap}ms)`);
});

test("an explicit pollIntervalMs still overrides whatever the server asks for", async () => {
	let poll = 0;
	const requester = fakeTaskRequester((method) => {
		if (method !== "tasks/get") return { content: [] };
		poll += 1;
		return poll === 1 ? fakeTask("working", 60_000) : fakeTask("completed");
	});
	const startedAt = Date.now();
	await new McpTaskClient(requester).waitForTask("task-1", { pollIntervalMs: 1 });
	assert.ok(Date.now() - startedAt < 2000);
});

test("createToolTask sends the requested pollInterval as task.pollInterval", async () => {
	const requester = fakeTaskRequester(() => ({ task: fakeTask("working") }));
	await new McpTaskClient(requester).createToolTask(
		"slow",
		{ value: 1 },
		{ ttlMs: 60_000, pollIntervalMs: 250 },
	);
	assert.deepEqual((requester.calls[0] as FakeRequest).params?.task, {
		ttl: 60_000,
		pollInterval: 250,
	});
	// Neither hint is invented when the caller supplies none.
	const bare = fakeTaskRequester(() => ({ task: fakeTask("working") }));
	await new McpTaskClient(bare).createToolTask("slow");
	assert.deepEqual((bare.calls[0] as FakeRequest).params?.task, {});
});

test("the requested pollInterval reaches the wire through the manager", async (t) => {
	const server = createFakeTaskServer({ completeAfterMs: 10 });
	const manager = new McpConnectionManager<"tasks">();
	t.after(() => manager.close());
	manager.register(
		defineConnection({
			id: "tasks",
			transport: () => server.transport,
			protocolVersion: "2025-11-25",
		}),
	);
	await manager.connect("tasks");
	await manager.callToolViaTask("tasks", "slow", {}, { pollIntervalMs: 5 });
	const created = server.received.find(
		(message) =>
			message.method === "tools/call" && (message.params as { task?: unknown }).task !== undefined,
	);
	assert.deepEqual((created?.params as { task: unknown }).task, { pollInterval: 5 });
});

// ---------------------------------------------------------------------------
// 2 + 11. syncResourceToFile: coalescing and stop() discipline
// ---------------------------------------------------------------------------

interface SyncFixture {
	readonly manager: McpConnectionManager<"sync">;
	readonly uri: string;
	setValue(value: string): void;
	gateReads(): { release(): void };
	gateSubscribes(): { release(): void };
	readonly counts: { subscribes: number; unsubscribes: number; reads: number };
	close(): Promise<void>;
}

function syncFixture(): SyncFixture {
	const uri = "mem://doc.txt";
	let value = "A";
	let readGate: PromiseWithResolvers<void> | undefined;
	let subscribeGate: PromiseWithResolvers<void> | undefined;
	const counts = { subscribes: 0, unsubscribes: 0, reads: 0 };
	const handlers = {
		"resources/list": () => ({ resources: [{ uri, name: "doc" }] }),
		"resources/read": async () => {
			counts.reads += 1;
			// Snapshot at arrival: a gated read must answer with what was current when it was issued.
			const snapshot = value;
			if (readGate !== undefined) await readGate.promise;
			return { contents: [{ uri, mimeType: "text/plain", text: snapshot }] };
		},
		"resources/subscribe": async () => {
			counts.subscribes += 1;
			if (subscribeGate !== undefined) await subscribeGate.promise;
			return {};
		},
		"resources/unsubscribe": () => {
			counts.unsubscribes += 1;
			return {};
		},
	};
	const manager = new McpConnectionManager<"sync">();
	manager.register(
		defineConnection({
			id: "sync",
			protocolVersion: "2025-11-25",
			transport: () =>
				createRawLegacyServer({
					capabilities: { resources: { subscribe: true } },
					handlers,
				}).transport,
		}),
	);
	return {
		manager,
		uri,
		counts,
		setValue: (next) => {
			value = next;
		},
		gateReads: () => {
			readGate = Promise.withResolvers<void>();
			const gate = readGate;
			return {
				release: () => {
					readGate = undefined;
					gate.resolve();
				},
			};
		},
		gateSubscribes: () => {
			subscribeGate = Promise.withResolvers<void>();
			const gate = subscribeGate;
			return {
				release: () => {
					subscribeGate = undefined;
					gate.resolve();
				},
			};
		},
		close: () => manager.close(),
	};
}

test("sync() resolves on a read taken after the call, not on one already in flight", async (t) => {
	const fixture = syncFixture();
	t.after(() => fixture.close());
	const directory = await mkdtemp(join(tmpdir(), "kmcp-sync-"));
	const path = join(directory, "doc.txt");
	await fixture.manager.connect("sync");
	const sync = await syncResourceToFile(fixture.manager, "sync", fixture.uri, path);
	t.after(() => sync.stop());
	assert.equal(await readFile(path, "utf8"), "A");

	const gate = fixture.gateReads();
	const inFlight = sync.sync();
	// The value only changes once that read has genuinely reached the server, so the in-flight
	// read is provably answering with the OLD content.
	await eventually(() => fixture.counts.reads === 2, "the coalesced read to reach the server");
	fixture.setValue("B");
	const afterChange = sync.sync();
	gate.release();

	await inFlight;
	assert.equal(await readFile(path, "utf8"), "A", "the in-flight read answered with the old value");
	await afterChange;
	assert.equal(await readFile(path, "utf8"), "B", "the caller's own sync saw the new value");
	assert.equal(sync.syncs, 3);

	// Two callers arriving during one run share a SINGLE follow-up, not one run each.
	const gate2 = fixture.gateReads();
	const running = sync.sync();
	const a = sync.sync();
	const b = sync.sync();
	gate2.release();
	await Promise.all([running, a, b]);
	assert.equal(sync.syncs, 5);
});

test("stop() awaits the re-subscribe chain and never rewrites the file afterwards", async (t) => {
	const fixture = syncFixture();
	t.after(() => fixture.close());
	const directory = await mkdtemp(join(tmpdir(), "kmcp-sync-stop-"));
	const path = join(directory, "doc.txt");
	await fixture.manager.connect("sync");
	const sync = await syncResourceToFile(fixture.manager, "sync", fixture.uri, path);
	assert.equal(await readFile(path, "utf8"), "A");
	assert.equal(fixture.counts.subscribes, 1);

	// A new generation makes the sync re-subscribe; hold that call open.
	const gate = fixture.gateSubscribes();
	fixture.setValue("B");
	await fixture.manager.disconnect("sync");
	await fixture.manager.connect("sync");
	await eventually(() => fixture.counts.subscribes >= 2, "the sync to re-subscribe");

	const stopping = sync.stop();
	gate.release();
	await stopping;
	// The chain the re-subscribe started must not outlive stop(): no write, no orphan subscription.
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(await readFile(path, "utf8"), "A", "no write happened after stop()");
	assert.equal(sync.syncs, 1);
	assert.ok(fixture.counts.unsubscribes >= 1, "stop() dropped the server-side subscription");
	// sync() is inert once stopped.
	await sync.sync();
	assert.equal(sync.syncs, 1);
});
