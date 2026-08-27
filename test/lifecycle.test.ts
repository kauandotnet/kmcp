import assert from "node:assert/strict";
import test from "node:test";

import { defineServer } from "../src/server.ts";
import { Kmcp } from "../src/kmcp.ts";
import { createNodeMcpHandler } from "../src/node.ts";

test("the Node adapter is callable and retains the official handler control plane", async () => {
	const handler = createNodeMcpHandler(
		defineServer({ name: "node-handler-test", version: "1.0.0" }),
	);
	const events: unknown[] = [];
	const unsubscribe = handler.bus.subscribe((event) => events.push(event));

	assert.equal(typeof handler, "function");
	assert.equal(typeof handler.fetch, "function");
	assert.equal(typeof handler.close, "function");
	assert.equal(typeof handler.notify.toolsChanged, "function");

	handler.notify.toolsChanged();
	assert.equal(events.length, 1);
	unsubscribe();
	await handler.close();
	await handler.close();
});

test("Kmcp memoizes both a pending close and its eventual failure", async (t) => {
	const kit = new Kmcp();
	const failure = new Error("close failed");
	t.mock.method(kit.connections, "close", async () => {
		throw failure;
	});

	const first = kit.close();
	const concurrent = kit.close();
	assert.strictEqual(concurrent, first);
	await assert.rejects(first, (error: unknown) => error === failure);
	assert.strictEqual(kit.close(), first);
	assert.equal(kit.closed, true);
	assert.equal(kit.hubs.closed, true);
});
