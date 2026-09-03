import assert from "node:assert/strict";
import test from "node:test";

import {
	KMCP_ERROR_CODES,
	KmcpError,
	defineServer,
	defineTool,
	textContent,
	toolResult,
	type McpCapabilityProvider,
} from "../src/index.ts";
import { createTestClient, forEachEra } from "./helpers/in-process.ts";

const staticTool = defineTool("static", {}, async () => toolResult(textContent("static")));

test("providers require a declare list", () => {
	assert.throws(
		() => defineServer({ name: "p", version: "1.0.0" }, { providers: [async () => []] }),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
	assert.throws(
		() =>
			defineServer(
				{ name: "p", version: "1.0.0" },
				{ providers: [async () => []], declare: ["nope" as never] },
			),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
});

test("a provider-backed definition cannot be mounted", () => {
	const child = defineServer(
		{ name: "child", version: "1.0.0" },
		{ providers: [async () => []], declare: ["tool"] },
	);
	assert.throws(
		() => defineServer({ name: "parent", version: "1.0.0" }, {}).mount(child),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
});

forEachEra("providers resolve per materialization and merge with statics", async (era) => {
	let resolutions = 0;
	const provider: McpCapabilityProvider = () => {
		resolutions += 1;
		return [defineTool(`dynamic${resolutions}`, {}, async () => toolResult(textContent("dyn")))];
	};
	const definition = defineServer(
		{ name: "prov", version: "1.0.0" },
		{ capabilities: [staticTool], providers: [provider], declare: ["tool"] },
	);
	const { client, close } = await createTestClient(definition, { era });
	try {
		const first = await client.listTools({}, { cacheMode: "bypass" });
		assert.ok(first.tools.some((tool) => tool.name === "static"));
		assert.ok(first.tools.some((tool) => tool.name.startsWith("dynamic")));
		assert.ok(resolutions >= 1);
		if (era === "modern") {
			// Each modern request materializes a fresh instance, re-resolving the provider.
			const before = resolutions;
			await client.listTools({}, { cacheMode: "bypass" });
			assert.ok(resolutions > before);
		}
	} finally {
		await close();
	}
});

forEachEra("a throwing provider fails the materialization closed", async (era) => {
	const observed: unknown[] = [];
	const definition = defineServer(
		{ name: "prov-fail", version: "1.0.0" },
		{
			capabilities: [staticTool],
			providers: [
				() => {
					throw new Error("upstream exploded");
				},
			],
			declare: ["tool"],
			onProviderError: (error) => observed.push(error),
		},
	);
	// No partial catalog: the whole connection/request fails, not a shrunken list.
	await assert.rejects(async () => {
		const { client, close } = await createTestClient(definition, { era });
		try {
			await client.listTools();
		} finally {
			await close();
		}
	});
	assert.ok(observed.length >= 1);
	assert.equal((observed[0] as Error).message, "upstream exploded");
});

forEachEra("a provider contribution colliding with a static key is refused", async (era) => {
	const definition = defineServer(
		{ name: "prov-dup", version: "1.0.0" },
		{
			capabilities: [staticTool],
			providers: [
				async () => [defineTool("static", {}, async () => toolResult(textContent("dup")))],
			],
			declare: ["tool"],
		},
	);
	await assert.rejects(async () => {
		const { client, close } = await createTestClient(definition, { era });
		try {
			await client.listTools();
		} finally {
			await close();
		}
	});
});

forEachEra("a provider contribution outside declare is refused", async (era) => {
	const definition = defineServer(
		{ name: "prov-kind", version: "1.0.0" },
		{
			providers: [async () => [defineTool("t", {}, async () => toolResult(textContent("t")))]],
			declare: ["prompt"],
		},
	);
	await assert.rejects(async () => {
		const { client, close } = await createTestClient(definition, { era });
		try {
			await client.listPrompts();
		} finally {
			await close();
		}
	});
});

forEachEra("a provider-only definition lists empty instead of method-not-found", async (era) => {
	const definition = defineServer(
		{ name: "prov-empty", version: "1.0.0" },
		{ providers: [async () => []], declare: ["tool", "prompt"] },
	);
	const { client, close } = await createTestClient(definition, { era });
	try {
		const tools = await client.listTools();
		assert.deepEqual(tools.tools, []);
		const prompts = await client.listPrompts();
		assert.deepEqual(prompts.prompts, []);
	} finally {
		await close();
	}
});
