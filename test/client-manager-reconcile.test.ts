import assert from "node:assert/strict";
import test from "node:test";

import {
	KMCP_ERROR_CODES,
	KmcpError,
	McpConnectionDefinition,
	McpConnectionManager,
	defineConnection,
	defineServer,
	defineTool,
	inProcessConnection,
	textContent,
	toolResult,
	type McpConnectionDefinitionOptions,
	type McpConnectionEvent,
	type McpProtocolEra,
} from "../src/index.ts";
import { forEachEra } from "./helpers/in-process.ts";
import { createRawLegacyServer } from "./helpers/raw-server.ts";

/** A server that names itself through a tool, so a swap is observable from the client side. */
function namedServer(name: string) {
	return defineServer(
		{ name, version: "1.0.0" },
		{ capabilities: [defineTool("who", {}, async () => toolResult(textContent(name)))] },
	);
}

function connection<Id extends string>(
	id: Id,
	name: string,
	era: McpProtocolEra,
): McpConnectionDefinition<Id> {
	return inProcessConnection({ id, definition: namedServer(name), era });
}

/** See `test/client-resilience.test.ts`: the manager publishes several events in one tick. */
function recordEvents<Id extends string>(
	manager: McpConnectionManager<Id>,
): McpConnectionEvent<Id>[] {
	const events: McpConnectionEvent<Id>[] = [];
	manager.subscribe((event) => {
		events.push(event);
	});
	return events;
}

forEachEra("replace on an online connection reconnects to the new server", async (era, t) => {
	const manager = new McpConnectionManager<"a">();
	t.after(() => manager.close().catch(() => undefined));
	manager.register(connection("a", "alpha", era));
	const before = await manager.connect("a");
	assert.equal(before.phase, "online");
	assert.equal((await manager.callToolParsed("a", "who")).content[0]?.type, "text");

	const events = recordEvents(manager);
	const after = await manager.replace(connection("a", "beta", era));

	assert.equal(after.phase, "online");
	assert.ok(after.generation > before.generation, "the swap opened a new generation");
	assert.equal(after.serverInfo?.name, "beta");
	const answered = await manager.callToolParsed("a", "who");
	assert.deepEqual(answered.content, [{ type: "text", text: "beta" }]);
	assert.ok(
		events.some((event) => event.type === "connection.registered"),
		"the swap is announced like a registration",
	);
});

forEachEra("replace on an offline connection swaps in place and stays down", async (era, t) => {
	const manager = new McpConnectionManager<"a">();
	t.after(() => manager.close().catch(() => undefined));
	const registered = manager.register(connection("a", "alpha", era));
	assert.equal(registered.generation, 0);

	const swapped = await manager.replace(connection("a", "beta", era));
	assert.equal(swapped.phase, "offline");
	assert.equal(swapped.generation, 0, "nothing was connected, so no generation was spent");

	const connected = await manager.connect("a");
	assert.equal(connected.serverInfo?.name, "beta");
});

test("replace clears the failure the previous definition left behind", async (t) => {
	const manager = new McpConnectionManager<"a">();
	t.after(() => manager.close().catch(() => undefined));
	manager.register(
		defineConnection({
			id: "a",
			transport: () => {
				throw new Error("this endpoint does not exist");
			},
			protocolVersion: "2025-11-25",
		}),
	);
	await assert.rejects(manager.connect("a"), (error: unknown) => error instanceof KmcpError);
	const failed = manager.state("a");
	assert.equal(failed.phase, "failed");
	assert.equal(failed.errorCode, KMCP_ERROR_CODES.CONNECTION_CONNECT_FAILED);

	const swapped = await manager.replace(connection("a", "beta", "modern"));
	assert.equal(swapped.phase, "offline");
	assert.equal(swapped.errorCode, undefined);
	assert.equal(swapped.errorDetail, undefined);
	assert.equal(swapped.diagnostics, undefined, "the old server's diagnostics went with it");
	assert.equal((await manager.connect("a")).serverInfo?.name, "beta");
});

test("replacing with an equivalent definition is a no-op", async (t) => {
	const manager = new McpConnectionManager<"a">();
	t.after(() => manager.close().catch(() => undefined));
	const definition = connection("a", "alpha", "modern");
	manager.register(definition);
	const before = await manager.connect("a");
	const events = recordEvents(manager);

	const after = await manager.replace(definition);
	assert.equal(after.generation, before.generation);
	assert.equal(after.phase, "online");
	assert.deepEqual(events, [], "an identical definition changes nothing and announces nothing");
});

test("concurrent replaces on one id serialize and the last one wins", async (t) => {
	const manager = new McpConnectionManager<"a">();
	t.after(() => manager.close().catch(() => undefined));
	manager.register(connection("a", "alpha", "modern"));
	const before = await manager.connect("a");

	const [first, second] = await Promise.all([
		manager.replace(connection("a", "beta", "modern")),
		manager.replace(connection("a", "gamma", "modern")),
	]);

	assert.equal(first.serverInfo?.name, "beta");
	assert.equal(second.serverInfo?.name, "gamma");
	assert.ok(second.generation > first.generation, "each swap took its own generation");
	assert.ok(first.generation > before.generation);
	assert.equal(manager.state("a").serverInfo?.name, "gamma");
});

test("replace refuses a quarantined connection until its cleanup is retried", async (t) => {
	const manager = new McpConnectionManager<"a">();
	t.after(() => manager.close().catch(() => undefined));
	manager.register(
		inProcessConnection({
			id: "a",
			definition: namedServer("alpha"),
			era: "modern",
			disconnectTimeoutMs: 30,
		}),
	);
	await manager.connect("a");
	const client = await manager.withClient("a", async (live) => live);
	const close = t.mock.method(client, "close", () => new Promise<void>(() => undefined));
	await assert.rejects(manager.disconnect("a"));
	assert.equal(manager.state("a").phase, "quarantined");

	await assert.rejects(
		manager.replace(connection("a", "beta", "modern")),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.CONNECTION_QUARANTINED,
	);
	// The registry still holds the definition it could not clean up after.
	assert.equal(manager.state("a").phase, "quarantined");
	close.mock.restore();
});

test("replace and reconcile refuse to run on a closed manager", async () => {
	const manager = new McpConnectionManager<"a">();
	manager.register(connection("a", "alpha", "modern"));
	await manager.close();
	assert.throws(
		() => manager.replace(connection("a", "beta", "modern")),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.MANAGER_CLOSED,
	);
	await assert.rejects(
		manager.reconcile([]),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.MANAGER_CLOSED,
	);
});

forEachEra("reconcile adds, replaces and removes without disturbing the rest", async (era, t) => {
	const manager = new McpConnectionManager<"keep" | "swap" | "drop" | "new">();
	t.after(() => manager.close().catch(() => undefined));
	const keep = connection("keep", "keep", era);
	manager.register(keep);
	manager.register(connection("swap", "before", era));
	manager.register(connection("drop", "drop", era));
	await manager.connectAll(["keep", "swap", "drop"]);
	const keepGeneration = manager.state("keep").generation;
	const swapGeneration = manager.state("swap").generation;

	const result = await manager.reconcile([
		keep,
		connection("swap", "after", era),
		connection("new", "new", era),
	]);

	assert.deepEqual(
		{ ...result, added: [...result.added], replaced: [...result.replaced] },
		{
			added: ["new"],
			replaced: ["swap"],
			unchanged: ["keep"],
			removed: ["drop"],
		},
	);
	// Untouched means untouched: same generation, same session, still online.
	assert.equal(manager.state("keep").generation, keepGeneration);
	assert.equal(manager.state("keep").phase, "online");
	// The replaced one kept its connect state but is talking to the new server.
	const swapped = manager.state("swap");
	assert.equal(swapped.phase, "online");
	assert.ok(swapped.generation > swapGeneration);
	assert.equal(swapped.serverInfo?.name, "after");
	// A newly added connection is registered, never connected.
	assert.equal(manager.state("new").phase, "offline");
	assert.equal(manager.state("new").generation, 0);
	assert.throws(
		() => manager.state("drop"),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.CONNECTION_UNKNOWN,
	);
});

test("reconcile preserves a replaced connection that was offline", async (t) => {
	const manager = new McpConnectionManager<"a">();
	t.after(() => manager.close().catch(() => undefined));
	manager.register(connection("a", "before", "modern"));

	const result = await manager.reconcile([connection("a", "after", "modern")]);
	assert.deepEqual([...result.replaced], ["a"]);
	assert.equal(manager.state("a").phase, "offline", "an offline connection is not brought up");
	assert.equal(manager.state("a").generation, 0);
});

test("reconcile with remove: false leaves connections the set no longer names", async (t) => {
	const manager = new McpConnectionManager<"a" | "b">();
	t.after(() => manager.close().catch(() => undefined));
	const a = connection("a", "alpha", "modern");
	manager.register(a);
	manager.register(connection("b", "beta", "modern"));
	await manager.connect("b");

	const result = await manager.reconcile([a], { remove: false });
	assert.deepEqual(
		{ ...result, unchanged: [...result.unchanged] },
		{
			added: [],
			replaced: [],
			unchanged: ["a"],
			removed: [],
		},
	);
	assert.equal(manager.state("b").phase, "online");
});

test("reconcile refuses a set that names one id twice", async (t) => {
	const manager = new McpConnectionManager<"a">();
	t.after(() => manager.close().catch(() => undefined));
	await assert.rejects(
		manager.reconcile([connection("a", "one", "modern"), connection("a", "two", "modern")]),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.CONNECTION_DUPLICATE,
	);
	assert.equal(manager.snapshot().connections.length, 0, "nothing was applied");
});

test("a replaced connection whose new server is unreachable stays counted and carries the reason", async (t) => {
	const manager = new McpConnectionManager<"a">();
	t.after(() => manager.close().catch(() => undefined));
	manager.register(connection("a", "alpha", "modern"));
	await manager.connect("a");

	const result = await manager.reconcile([
		defineConnection({
			id: "a",
			transport: () => {
				throw new Error("the new endpoint is down");
			},
			protocolVersion: "2025-11-25",
		}),
	]);

	assert.deepEqual([...result.replaced], ["a"]);
	const state = manager.state("a");
	assert.equal(state.phase, "failed");
	assert.equal(state.errorCode, KMCP_ERROR_CODES.CONNECTION_CONNECT_FAILED);
});

/**
 * A definition subclass that exposes a stable `fingerprint`, as a host rebuilding its definitions
 * on every config read would. Private fields may be added to the frozen instance the base
 * constructor produces, so the stamp survives the freeze.
 */
class StampedConnection<const Id extends string> extends McpConnectionDefinition<Id> {
	readonly #fingerprint: string;

	constructor(options: McpConnectionDefinitionOptions<Id>, fingerprint: string) {
		super(options);
		this.#fingerprint = fingerprint;
	}

	get fingerprint(): string {
		return this.#fingerprint;
	}
}

test("a definition exposing a fingerprint compares by it rather than by identity", async (t) => {
	const manager = new McpConnectionManager<"a">();
	t.after(() => manager.close().catch(() => undefined));
	const stamped = (label: string, fingerprint: string) =>
		new StampedConnection(
			{
				id: "a" as const,
				label,
				transport: () => createRawLegacyServer().transport,
				protocolVersion: "2025-11-25",
			},
			fingerprint,
		);

	manager.register(stamped("alpha", "v1"));
	const before = await manager.connect("a");
	const same = await manager.replace(stamped("alpha", "v1"));
	assert.equal(same.generation, before.generation, "the same fingerprint is a no-op");
	assert.equal(same.label, "alpha");

	const changed = await manager.replace(stamped("beta", "v2"));
	assert.ok(changed.generation > before.generation);
	assert.equal(changed.label, "beta");
});
