import assert from "node:assert/strict";
import test from "node:test";

import { fromJsonSchema } from "@modelcontextprotocol/server";

import { KMCP_ERROR_CODES, KmcpError } from "../src/errors.ts";
import {
	abortable,
	cacheCalls,
	decorateHandlers,
	definePrompt,
	defineResource,
	defineResourceTemplate,
	defineServer,
	defineTool,
	filterCapabilities,
	logCalls,
	mapCapabilities,
	prefixNames,
	promptResult,
	rateLimit,
	sizeLimit,
	textContent,
	timeout,
	toolResult,
	userMessage,
	withJsonSchema,
	type McpCallLogEntry,
} from "../src/server.ts";
import { createTestClient, forEachEra } from "./helpers/in-process.ts";

const input = fromJsonSchema<{ value: string }>({
	type: "object",
	properties: { value: { type: "string" } },
	required: ["value"],
});

function base() {
	return defineServer(
		{ name: "transform-test", version: "1.0.0" },
		{
			capabilities: [
				defineTool("echo", { inputSchema: input, tags: ["v1"] }, async ({ value }) =>
					toolResult(textContent(value)),
				),
				defineTool("legacy-only", { tags: ["v0"] }, async () => toolResult(textContent("old"))),
				definePrompt("hello", { tags: ["v1"] }, async () => promptResult(userMessage("hello"))),
				defineResource("doc", "doc://readme", { tags: ["v1"] }, async (uri) => ({
					contents: [{ uri: uri.href, text: "readme" }],
				})),
				defineResourceTemplate("items", "items://{id}", {}, async (uri) => ({
					contents: [{ uri: uri.href, text: "item" }],
				})),
			],
		},
	);
}

forEachEra("prefixNames renames names but never URIs; filters drop by tag", async (era) => {
	const definition = base().transform(
		filterCapabilities(
			(capability) => capability.tags.includes("v1") || capability.kind === "resource-template",
		),
		prefixNames("v1"),
	);
	const { client, close } = await createTestClient(definition, { era });
	try {
		assert.deepEqual(
			(await client.listTools()).tools.map((tool) => tool.name),
			["v1.echo"],
		);
		assert.deepEqual(
			(await client.listPrompts()).prompts.map((p) => p.name),
			["v1.hello"],
		);
		const [resource] = (await client.listResources()).resources;
		assert.equal(resource?.name, "v1.doc");
		assert.equal(resource?.uri, "doc://readme");
		const [template] = (await client.listResourceTemplates()).resourceTemplates;
		assert.equal(template?.name, "v1.items");
		assert.equal(template?.uriTemplate, "items://{id}");
		const result = await client.callTool({ name: "v1.echo", arguments: { value: "hi" } });
		assert.deepEqual(result.content, [{ type: "text", text: "hi" }]);
		await assert.rejects(
			client.callTool({ name: "echo", arguments: { value: "hi" } }),
			/not found/,
		);
	} finally {
		await close();
	}
});

test("mapCapabilities rewrites metadata per kind and rejects kind changes", () => {
	const redescribed = base().transform(
		mapCapabilities({
			tool: (tool) => (tool.name === "echo" ? tool.withMetadata({ description: "Echoes" }) : tool),
		}),
	);
	const echo = redescribed.capabilities.find((capability) => capability.name === "echo");
	assert.equal(echo?.kind === "tool" ? echo.options.description : undefined, "Echoes");
	assert.throws(
		() =>
			base().transform(
				mapCapabilities({
					tool: () => definePrompt("nope", {}, async () => promptResult(userMessage("x"))) as never,
				}),
			),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
});

forEachEra("mount composes a child definition with prefixed names", async (era) => {
	const child = defineServer(
		{ name: "child", version: "1.0.0" },
		{ capabilities: [defineTool("ping", {}, async () => toolResult(textContent("pong")))] },
	);
	const parent = base().mount(child, { prefix: "child" });
	const { client, close } = await createTestClient(parent, { era });
	try {
		const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
		assert.deepEqual(names, ["child.ping", "echo", "legacy-only"]);
		const result = await client.callTool({ name: "child.ping", arguments: {} });
		assert.deepEqual(result.content, [{ type: "text", text: "pong" }]);
	} finally {
		await close();
	}
	const withSetup = defineServer({ name: "s", version: "1.0.0" }, { setup: () => undefined });
	assert.throws(
		() => base().mount(withSetup),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
	assert.ok(base().mount(withSetup, { allowSetup: true }));
});

forEachEra("timeout aborts the derived signal and terminates the request", async (era) => {
	let observedAbort = false;
	const definition = defineServer(
		{ name: "timeout", version: "1.0.0" },
		{
			capabilities: [
				defineTool("slow", {}, async (ctx) => {
					await new Promise<void>((resolve) => {
						ctx.mcpReq.signal.addEventListener("abort", () => {
							observedAbort = true;
							resolve();
						});
						setTimeout(resolve, 2_000);
					});
					return toolResult(textContent("done"));
				}),
				definePrompt("slow-prompt", {}, async () => {
					await new Promise((resolve) => setTimeout(resolve, 2_000));
					return promptResult(userMessage("late"));
				}),
			],
		},
	).transform(decorateHandlers(timeout(50)));
	const { client, close } = await createTestClient(definition, { era });
	try {
		const result = await client.callTool({ name: "slow", arguments: {} });
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result.content), /timed out after 50ms/);
		assert.equal(observedAbort, true);
		await assert.rejects(client.getPrompt({ name: "slow-prompt" }), /timed out/);
	} finally {
		await close();
	}
});

forEachEra("rateLimit, sizeLimit, logCalls and cacheCalls compose", async (era) => {
	let calls = 0;
	const entries: McpCallLogEntry[] = [];
	const definition = defineServer(
		{ name: "decorated", version: "1.0.0" },
		{
			capabilities: [
				defineTool("counted", { inputSchema: input }, async ({ value }) => {
					calls += 1;
					return toolResult(textContent(`${value}:${calls}`));
				}),
				defineTool("huge", {}, async () => toolResult(textContent("x".repeat(100)))),
			],
		},
	).transform(
		decorateHandlers(logCalls((entry) => entries.push(entry))),
		decorateHandlers(cacheCalls({ ttlMs: 60_000 })),
		decorateHandlers(sizeLimit(80)),
		decorateHandlers(rateLimit({ limit: 5, windowMs: 60_000 })),
		decorateHandlers(abortable()),
	);
	const { client, close } = await createTestClient(definition, { era });
	try {
		const first = await client.callTool({ name: "counted", arguments: { value: "a" } });
		const second = await client.callTool({ name: "counted", arguments: { value: "a" } });
		assert.deepEqual(first.content, second.content);
		assert.equal(calls, 1);
		const other = await client.callTool({ name: "counted", arguments: { value: "b" } });
		assert.deepEqual(other.content, [{ type: "text", text: "b:2" }]);
		const huge = await client.callTool({ name: "huge", arguments: {} });
		assert.equal(huge.isError, true);
		assert.match(JSON.stringify(huge.content), /limit is 80/);
		await client.callTool({ name: "counted", arguments: { value: "c" } });
		const limited = await client.callTool({ name: "counted", arguments: { value: "d" } });
		assert.equal(limited.isError, true);
		assert.match(JSON.stringify(limited.content), /Rate limit/);
		assert.ok(entries.some((entry) => entry.name === "counted" && entry.ok));
		// logCalls is the innermost decorator: it observed the handler succeeding before sizeLimit rejected.
		assert.ok(entries.some((entry) => entry.name === "huge" && entry.ok));
		assert.equal(entries.filter((entry) => entry.name === "counted").length, 3);
	} finally {
		await close();
	}
});

forEachEra(
	"withJsonSchema advertises the authored JSON schema while validating with the validator",
	async (era) => {
		const schema = withJsonSchema<{ n: number }>(
			{
				"~standard": {
					version: 1,
					vendor: "kmcp-test",
					validate: (value) =>
						typeof value === "object" &&
						value !== null &&
						typeof (value as { n?: unknown }).n === "number"
							? { value: value as { n: number } }
							: { issues: [{ message: "n must be a number" }] },
				},
			},
			{
				type: "object",
				properties: { n: { type: "number", description: "authored" } },
				required: ["n"],
			},
		);
		const definition = defineServer(
			{ name: "schema", version: "1.0.0" },
			{
				capabilities: [
					defineTool("double", { inputSchema: schema }, async ({ n }) =>
						toolResult(textContent(String(n * 2))),
					),
				],
			},
		);
		const { client, close } = await createTestClient(definition, { era });
		try {
			const [tool] = (await client.listTools()).tools;
			assert.equal(
				(tool?.inputSchema as { properties?: { n?: { description?: string } } }).properties?.n
					?.description,
				"authored",
			);
			const ok = await client.callTool({ name: "double", arguments: { n: 21 } });
			assert.deepEqual(ok.content, [{ type: "text", text: "42" }]);
			const bad = await client.callTool({ name: "double", arguments: { n: "x" } });
			assert.equal(bad.isError, true);
		} finally {
			await close();
		}
	},
);
