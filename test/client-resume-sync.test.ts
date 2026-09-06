import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	InMemoryKeyValueStore,
	KMCP_ERROR_CODES,
	KmcpError,
	McpConnectionManager,
	McpOAuthClientProvider,
	defineConnection,
	defineResource,
	defineServer,
	describeError,
	httpConnection,
	inProcessConnection,
} from "../src/index.ts";
import { syncResourceToFile } from "../src/node.ts";
import { forEachEra, observableServer } from "./helpers/in-process.ts";
import { createRawLegacyServer } from "./helpers/raw-server.ts";

async function eventually(check: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
	const startedAt = Date.now();
	while (!check()) {
		if (Date.now() - startedAt > timeoutMs) assert.fail(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("a resumed session skips the handshake and serves from the resumed record", async (t) => {
	const server = createRawLegacyServer({
		handlers: {
			"tools/list": () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }),
			"tools/call": () => ({ content: [{ type: "text", text: "ok" }] }),
		},
	});
	server.transport.sessionId = "resumed-1";
	const manager = new McpConnectionManager<"r">();
	t.after(() => manager.close());
	manager.register(
		defineConnection({
			id: "r",
			transport: () => server.transport,
			resumed: {
				sessionId: "resumed-1",
				protocolVersion: "2025-11-25",
				capabilities: { tools: {} },
				serverInfo: { name: "raw-legacy", version: "0.0.0" },
				instructions: "resumed",
			},
		}),
	);
	const snapshot = await manager.connect("r");
	assert.ok(
		!server.received.some((message) => message.method === "initialize"),
		"no handshake ran",
	);
	assert.equal(snapshot.sessionId, "resumed-1");
	assert.equal(snapshot.connectionMode, "stateful");
	assert.equal(snapshot.protocolVersion, "2025-11-25");
	assert.equal(snapshot.protocolEra, "legacy");
	assert.deepEqual(snapshot.capabilities, { tools: {} });
	assert.equal(snapshot.serverInfo?.name, "raw-legacy");
	assert.equal(snapshot.instructions, "resumed");
	const listed = await manager.listTools("r");
	assert.equal(listed.tools[0]?.name, "echo");
	const called = await manager.callTool("r", "echo", {});
	assert.equal((called.content[0] as { text: string }).text, "ok");
	const ping = await manager.ping("r");
	assert.equal(ping.era, "legacy");
	assert.ok(server.received.some((message) => message.method === "ping"));
	assert.equal(manager.supportsToolTasks("r"), false);
	const catalog = await manager.refreshCatalog("r");
	assert.equal(catalog.tools.status, "fresh");
	assert.equal(catalog.resources.status, "unsupported");
});

test("httpConnection({ resume }) resolves the era and relaxes strict enforcement", () => {
	const modern = httpConnection({
		id: "m",
		url: "https://mcp.example.com/mcp",
		resume: { sessionId: "s", protocolVersion: "2026-07-28" },
	});
	assert.equal(modern.resumed?.era, "modern");
	// Nothing is baked into clientOptions; the relaxation is per generation and one-shot.
	assert.equal(modern.clientOptions.enforceStrictCapabilities, undefined);
	assert.equal(modern.enforceStrictCapabilities, false);
	modern.consumeResume();
	assert.equal(modern.enforceStrictCapabilities, true);
	const explicit = httpConnection({
		id: "e",
		url: "https://mcp.example.com/mcp",
		resume: { sessionId: "s" },
		clientOptions: { enforceStrictCapabilities: true },
	});
	assert.equal(explicit.resumed?.era, undefined);
	assert.equal(explicit.clientOptions.enforceStrictCapabilities, true);
	assert.equal(
		httpConnection({ id: "f", url: "https://mcp.example.com/mcp" }).clientOptions
			.enforceStrictCapabilities,
		true,
	);
	assert.throws(
		() =>
			httpConnection({
				id: "bad",
				url: "https://mcp.example.com/mcp",
				resume: { sessionId: "s", protocolVersion: "2000-01-01" },
			}),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.PROTOCOL_VERSION_UNSUPPORTED,
	);
});

test("a connection refused is classified as a network failure", async (t) => {
	// The Fetch specification blocks well-known low ports outright, so pick a real closed port.
	const port = await new Promise<number>((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const chosen = typeof address === "object" && address !== null ? address.port : 0;
			probe.close(() => resolve(chosen));
		});
	});
	const manager = new McpConnectionManager<"dead">();
	t.after(() => manager.close());
	manager.register(
		httpConnection({
			id: "dead",
			url: `http://127.0.0.1:${port}/mcp`,
			defaults: { timeoutMs: 3000 },
		}),
	);
	await assert.rejects(manager.connect("dead"));
	const detail = manager.state("dead").errorDetail;
	assert.equal(detail?.kind, "network");
	assert.equal(detail?.code, "ECONNREFUSED");
	const wrapped = new KmcpError(KMCP_ERROR_CODES.OPERATION_FAILED, "x", {
		cause: new TypeError("fetch failed", {
			cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }),
		}),
	});
	assert.deepEqual(describeError(wrapped), { kind: "network", code: "ENOTFOUND" });
	assert.deepEqual(describeError(new DOMException("aborted", "AbortError")), {
		kind: "network",
		code: "AbortError",
	});
	assert.equal(describeError(Object.assign(new Error("x"), { code: "SOMETHING" })).kind, "unknown");
});

test("credential profiles partition one store", async () => {
	const store = new InMemoryKeyValueStore();
	const make = (profile?: string) =>
		new McpOAuthClientProvider({
			serverUrl: "https://mcp.example.com/mcp",
			redirectUrl: "http://127.0.0.1:1/callback",
			store,
			onRedirect: () => undefined,
			...(profile === undefined ? {} : { profile }),
		});
	const work = make("work");
	const home = make("home");
	const unnamed = make();
	const issuer = { issuer: "https://as.example.com" };
	await work.saveTokens({ access_token: "w", token_type: "Bearer" }, issuer);
	await home.saveTokens({ access_token: "h", token_type: "Bearer" }, issuer);
	assert.equal((await work.tokens())?.access_token, "w");
	assert.equal((await home.tokens())?.access_token, "h");
	assert.equal(await unnamed.tokens(), undefined);
	assert.equal((await work.status()).profile, "work");
	assert.equal((await store.get("profile:work/https://as.example.com/tokens")) !== undefined, true);
	await work.invalidateCredentials("tokens");
	assert.equal(await work.tokens(), undefined);
	assert.equal((await home.tokens())?.access_token, "h");
	assert.throws(
		() => make("bad profile!"),
		(error: unknown) => error instanceof KmcpError,
	);
});

forEachEra(
	"syncResourceToFile follows updates and re-subscribes after a reconnect",
	async (era) => {
		let version = 1;
		const observed = observableServer(
			defineServer(
				{ name: "sync", version: "1.0.0" },
				{
					capabilities: [
						defineResource("doc", "docs://readme", {}, async (uri) => ({
							contents: [{ uri: uri.href, mimeType: "text/plain", text: `v${version}` }],
						})),
					],
				},
			),
		);
		const manager = new McpConnectionManager<"alpha">();
		manager.register(inProcessConnection({ id: "alpha", definition: observed.server, era }));
		await manager.connect("alpha");
		const directory = await mkdtemp(join(tmpdir(), "kmcp-sync-"));
		const path = join(directory, "readme.txt");
		try {
			const sync = await syncResourceToFile(manager, "alpha", "docs://readme", path);
			assert.equal(await readFile(path, "utf8"), "v1");
			assert.equal(sync.syncs, 1);
			assert.deepEqual(manager.state("alpha").subscribedResources, ["docs://readme"]);

			version = 2;
			await observed.resourceUpdated("docs://readme");
			await eventually(() => sync.syncs === 2, "second sync");
			assert.equal(await readFile(path, "utf8"), "v2");

			// Subscriptions are generation-scoped: a reconnect must re-subscribe and re-sync.
			await manager.disconnect("alpha");
			await manager.connect("alpha");
			await eventually(() => sync.syncs === 3, "post-reconnect sync");
			version = 3;
			await observed.resourceUpdated("docs://readme");
			await eventually(() => sync.syncs === 4, "update after reconnect");
			assert.equal(await readFile(path, "utf8"), "v3");
			assert.equal(sync.lastError, undefined);
			assert.ok(sync.lastSyncedAt);

			await sync.stop();
			assert.equal(manager.state("alpha").subscribedResources, undefined);
			version = 4;
			await observed.resourceUpdated("docs://readme");
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(sync.syncs, 4, "a stopped sync ignores updates");
		} finally {
			await manager.close();
		}
	},
);
