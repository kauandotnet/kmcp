import assert from "node:assert/strict";
import test from "node:test";

import { serveWithLifespan } from "../src/index.ts";

test("serveWithLifespan starts before serving and stops after close", async () => {
	const order: string[] = [];
	const handle = await serveWithLifespan(
		{
			start: () => {
				order.push("start");
				return { pool: "db" };
			},
			stop: (state) => {
				order.push(`stop:${state.pool}`);
			},
		},
		(state) => {
			order.push(`serve:${state.pool}`);
			return {
				close: async () => {
					order.push("close");
				},
			};
		},
	);
	await handle.close();
	await handle.close(); // idempotent
	assert.deepEqual(order, ["start", "serve:db", "close", "stop:db"]);
});

test("stop still runs when close fails, aggregating both errors", async () => {
	let stopped = false;
	const handle = await serveWithLifespan(
		{
			start: () => undefined,
			stop: () => {
				stopped = true;
				throw new Error("stop failed");
			},
		},
		() => ({
			close: async () => {
				throw new Error("close failed");
			},
		}),
	);
	await assert.rejects(
		() => handle.close(),
		(error: unknown) => error instanceof AggregateError && error.errors.length === 2,
	);
	assert.equal(stopped, true);
});

test("a serve failure still stops the lifespan", async () => {
	let stopped = false;
	await assert.rejects(
		() =>
			serveWithLifespan(
				{
					start: () => undefined,
					stop: () => {
						stopped = true;
					},
				},
				() => {
					throw new Error("bind failed");
				},
			),
		/bind failed/,
	);
	assert.equal(stopped, true);
});
