import assert from "node:assert/strict";

import { fromJsonSchema } from "@modelcontextprotocol/server";

import {
	KMCP_ERROR_CODES,
	KmcpError,
	defineServer,
	defineTool,
	logMiddleware,
	maskErrorDetails,
	responseLimit,
	textContent,
	tokenBucketMiddleware,
	toolResult,
	type McpMiddleware,
	type McpMiddlewareLogEntry,
} from "../src/index.ts";
import { createTestClient, forEachEra } from "./helpers/in-process.ts";

const inputSchema = fromJsonSchema<{ value: string }>({
	type: "object",
	properties: { value: { type: "string" } },
	required: ["value"],
});

const echo = defineTool("echo", { inputSchema }, async ({ value }) =>
	toolResult(textContent(value)),
);

forEachEra("middleware composes outermost-first and can rewrite arguments", async (era) => {
	const order: string[] = [];
	const outer: McpMiddleware = async (context, next) => {
		order.push("outer");
		const [args] = context.args as [{ value: string }];
		return next({ ...context, args: [{ value: `${args.value}!` }] });
	};
	const inner: McpMiddleware = async (context, next) => {
		order.push("inner");
		return next(context);
	};
	const definition = defineServer(
		{ name: "mw", version: "1.0.0" },
		{ capabilities: [echo], middleware: [outer, inner] },
	);
	assert.deepEqual(order, []); // middleware runs per call, never at definition/instantiate time
	const { client, close } = await createTestClient(definition, { era });
	try {
		const result = await client.callTool({ name: "echo", arguments: { value: "hi" } });
		assert.equal((result.content[0] as { text: string }).text, "hi!");
		assert.deepEqual(order, ["outer", "inner"]);
	} finally {
		await close();
	}
});

forEachEra("middleware sees the request era and authInfo", async (era) => {
	const seen: { era?: string; clientId?: string }[] = [];
	const observe: McpMiddleware = async (context, next) => {
		seen.push({
			era: context.request.era,
			...(context.request.authInfo === undefined
				? {}
				: { clientId: context.request.authInfo.clientId }),
		});
		return next(context);
	};
	const definition = defineServer(
		{ name: "mw-auth", version: "1.0.0" },
		{ capabilities: [echo], middleware: [observe] },
	);
	const { client, close } = await createTestClient(definition, {
		era,
		authInfo: { token: "secret-token", clientId: "cli-1", scopes: ["a"] },
	});
	try {
		await client.callTool({ name: "echo", arguments: { value: "x" } });
		assert.deepEqual(seen, [{ era, clientId: "cli-1" }]);
	} finally {
		await close();
	}
});

forEachEra("maskErrorDetails hides the original message but reports it to onerror", async (era) => {
	const observed: unknown[] = [];
	const definition = defineServer(
		{ name: "mw-mask", version: "1.0.0" },
		{
			capabilities: [
				defineTool("boom", {}, async () => {
					throw new Error("db password is hunter2");
				}),
			],
			middleware: [maskErrorDetails({ onerror: (error) => observed.push(error) })],
		},
	);
	const { client, close } = await createTestClient(definition, { era });
	try {
		const result = await client.callTool({ name: "boom" });
		assert.equal(result.isError, true);
		const text = (result.content[0] as { text: string }).text;
		assert.ok(!text.includes("hunter2"), text);
		assert.ok(text.includes("Internal error."), text);
		assert.equal((observed[0] as Error).message, "db password is hunter2");
	} finally {
		await close();
	}
});

forEachEra("tokenBucketMiddleware refills over an injected clock", async (era) => {
	let at = 0;
	const definition = defineServer(
		{ name: "mw-bucket", version: "1.0.0" },
		{
			capabilities: [echo],
			middleware: [
				tokenBucketMiddleware({ capacity: 2, refillPerSecond: 1, now: () => at, key: () => "k" }),
			],
		},
	);
	const { client, close } = await createTestClient(definition, { era });
	try {
		const call = () => client.callTool({ name: "echo", arguments: { value: "x" } });
		assert.equal((await call()).isError, undefined);
		assert.equal((await call()).isError, undefined);
		const limited = await call();
		assert.equal(limited.isError, true);
		assert.match((limited.content[0] as { text: string }).text, /rate limit/i);
		at += 1000;
		assert.equal((await call()).isError, undefined);
	} finally {
		await close();
	}
});

forEachEra("responseLimit rejects oversized results", async (era) => {
	const definition = defineServer(
		{ name: "mw-limit", version: "1.0.0" },
		{
			capabilities: [defineTool("big", {}, async () => toolResult(textContent("y".repeat(2048))))],
			middleware: [responseLimit(256)],
		},
	);
	const { client, close } = await createTestClient(definition, { era });
	try {
		const result = await client.callTool({ name: "big" });
		assert.equal(result.isError, true);
		assert.match((result.content[0] as { text: string }).text, /bytes/);
	} finally {
		await close();
	}
});

forEachEra("logMiddleware reports outcomes and durations", async (era) => {
	const entries: McpMiddlewareLogEntry[] = [];
	const definition = defineServer(
		{ name: "mw-log", version: "1.0.0" },
		{
			capabilities: [
				echo,
				defineTool("bad", {}, async () => {
					throw new KmcpError(KMCP_ERROR_CODES.OPERATION_FAILED, "nope");
				}),
			],
			middleware: [logMiddleware((entry) => entries.push(entry))],
		},
	);
	const { client, close } = await createTestClient(definition, { era });
	try {
		await client.callTool({ name: "echo", arguments: { value: "x" } });
		await client.callTool({ name: "bad" });
		assert.equal(entries.length, 2);
		assert.deepEqual(
			entries.map((entry) => [entry.name, entry.ok, entry.era]),
			[
				["echo", true, era],
				["bad", false, era],
			],
		);
		assert.ok(entries.every((entry) => entry.durationMs >= 0));
	} finally {
		await close();
	}
});
