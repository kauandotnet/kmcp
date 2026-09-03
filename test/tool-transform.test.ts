import assert from "node:assert/strict";
import test from "node:test";

import {
	fromJsonSchema,
	type StandardSchemaV1,
	type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";

import {
	KMCP_ERROR_CODES,
	KmcpError,
	McpToolDefinition,
	defineServer,
	defineTool,
	textContent,
	toolResult,
	transformTool,
	transformTools,
	withJsonSchema,
} from "../src/index.ts";
import { assertCanonicalCapability } from "../src/authoring/capability.ts";
import { createTestClient, forEachEra } from "./helpers/in-process.ts";

const inputSchema = fromJsonSchema<{ value: string; mode: string; secret?: string }>({
	type: "object",
	properties: {
		value: { type: "string", description: "the payload" },
		mode: { type: "string" },
		secret: { type: "string" },
	},
	required: ["value", "mode"],
});

function baseTool() {
	return defineTool("convert", { description: "converts", inputSchema }, async (args) =>
		toolResult(textContent(JSON.stringify(args))),
	);
}

test("transformTool yields a canonical definition with the patched metadata", () => {
	const derived = transformTool(baseTool(), {
		name: "convert_v2",
		description: "converts, better",
		tags: ["v2"],
	});
	assert.ok(derived instanceof McpToolDefinition);
	assert.doesNotThrow(() => assertCanonicalCapability(derived));
	assert.equal(derived.name, "convert_v2");
	assert.equal(derived.options.description, "converts, better");
	assert.deepEqual([...derived.tags], ["v2"]);
});

forEachEra("renamed and hidden arguments rewrite the advertised schema only", async (era) => {
	const derived = transformTool(baseTool(), {
		args: {
			value: { name: "text", description: "renamed payload" },
			secret: { hide: true, default: "injected" },
		},
	});
	const definition = defineServer({ name: "tt", version: "1.0.0" }, { capabilities: [derived] });
	const { client, close } = await createTestClient(definition, { era });
	try {
		const tools = await client.listTools();
		const advertised = tools.tools[0]?.inputSchema as {
			properties: Record<string, { description?: string }>;
			required?: string[];
		};
		assert.deepEqual(Object.keys(advertised.properties).sort(), ["mode", "text"]);
		assert.equal(advertised.properties["text"]?.description, "renamed payload");
		assert.deepEqual([...(advertised.required ?? [])].sort(), ["mode", "text"]);

		const result = await client.callTool({
			name: "convert",
			arguments: { text: "hello", mode: "fast" },
		});
		assert.equal(result.isError, undefined);
		const seen = JSON.parse((result.content[0] as { text: string }).text) as Record<
			string,
			unknown
		>;
		// The handler received the UNDERLYING shape, with the hidden default injected.
		assert.deepEqual(seen, { value: "hello", mode: "fast", secret: "injected" });
	} finally {
		await close();
	}
});

test("validation issues are remapped to the public argument names", async () => {
	// `fromJsonSchema` (AJV) aggregates issues into one path-less message, so path remapping is
	// exercised with a path-producing Standard Schema validator (the Zod/Valibot shape).
	const validator: StandardSchemaV1<Record<string, unknown>> = {
		"~standard": {
			version: 1,
			vendor: "test",
			validate: (input) => {
				const record = input as Record<string, unknown>;
				if (typeof record["value"] !== "string") {
					return { issues: [{ message: "value must be a string", path: ["value"] }] };
				}
				return { value: record };
			},
		},
	};
	const pathy = defineTool(
		"pathy",
		{
			inputSchema: withJsonSchema(validator, {
				type: "object",
				properties: { value: { type: "string" } },
				required: ["value"],
			}),
		},
		async (args) => toolResult(textContent(JSON.stringify(args))),
	);
	const derived = transformTool(pathy, { args: { value: { name: "text" } } });
	const schema = (derived.options as { inputSchema?: StandardSchemaWithJSON }).inputSchema;
	assert.ok(schema !== undefined);
	const result = await schema["~standard"].validate({ text: 42 });
	assert.ok(result.issues !== undefined);
	assert.deepEqual(result.issues[0]?.path, ["text"]);
});

test("a client cannot smuggle a hidden or underlying argument name", async () => {
	const derived = transformTool(baseTool(), {
		args: { value: { name: "text" }, secret: { hide: true, default: "safe" } },
	});
	const schema = (derived.options as { inputSchema?: StandardSchemaWithJSON }).inputSchema;
	assert.ok(schema !== undefined);
	const result = await schema["~standard"].validate({
		text: "a",
		mode: "b",
		value: "smuggled",
		secret: "evil",
	});
	assert.equal(result.issues, undefined);
	assert.deepEqual(result.issues === undefined ? result.value : undefined, {
		value: "a",
		mode: "b",
		secret: "safe",
	});
});

test("invalid transforms are rejected at authoring time", () => {
	const invalid = (options: Parameters<typeof transformTool>[1]) => () =>
		transformTool(baseTool(), options);
	const isInvalidDefinition = (error: unknown) =>
		error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION;
	assert.throws(invalid({ args: { missing: { name: "other" } } }), isInvalidDefinition);
	assert.throws(invalid({ args: { value: { hide: true } } }), isInvalidDefinition);
	assert.throws(invalid({ args: { value: { name: "mode" } } }), isInvalidDefinition);
	assert.throws(invalid({ args: { value: { hide: true, name: "x" } } }), isInvalidDefinition);
	const schemaless = defineTool("bare", {}, async () => toolResult(textContent("x")));
	assert.throws(
		() => transformTool(schemaless, { args: { value: { name: "text" } } }),
		isInvalidDefinition,
	);
});

test("transformTools refuses unknown tool names", () => {
	const definition = defineServer(
		{ name: "tt-map", version: "1.0.0" },
		{ capabilities: [baseTool()] },
	);
	assert.throws(
		() => definition.transform(transformTools({ nope: { description: "x" } })),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
	const renamed = definition.transform(transformTools({ convert: { name: "convert2" } }));
	assert.deepEqual(
		renamed.capabilities.map((capability) => capability.name),
		["convert2"],
	);
});
