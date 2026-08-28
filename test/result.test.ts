import assert from "node:assert/strict";
import test from "node:test";

import { fromJsonSchema } from "@modelcontextprotocol/server";

import {
	assistantMessage,
	audioContent,
	defineTool,
	embeddedBlobResource,
	embeddedTextResource,
	encodeBase64,
	errorResult,
	imageContent,
	jsonResult,
	promptResult,
	resourceLink,
	resourceResult,
	textContent,
	toolResult,
	userMessage,
} from "../src/server.ts";

test("base64 encoding is runtime-neutral and chunk-safe", () => {
	assert.equal(encodeBase64(new Uint8Array([104, 105])), "aGk=");
	assert.equal(encodeBase64(new Uint8Array(0)), "");
	const large = new Uint8Array(200_000).fill(0x41);
	assert.equal(encodeBase64(large), Buffer.from(large).toString("base64"));
});

test("content constructors produce spec-shaped blocks", () => {
	assert.deepEqual(textContent("hi"), { type: "text", text: "hi" });
	assert.deepEqual(imageContent(new Uint8Array([1, 2, 3]), "image/png"), {
		type: "image",
		data: "AQID",
		mimeType: "image/png",
	});
	assert.deepEqual(audioContent("AQID", "audio/wav", { annotations: { priority: 1 } }), {
		type: "audio",
		data: "AQID",
		mimeType: "audio/wav",
		annotations: { priority: 1 },
	});
	assert.deepEqual(resourceLink("memo://1", "memo", { mimeType: "text/plain", size: 3 }), {
		type: "resource_link",
		uri: "memo://1",
		name: "memo",
		mimeType: "text/plain",
		size: 3,
	});
	assert.deepEqual(embeddedTextResource("memo://1", "body", { mimeType: "text/plain" }), {
		type: "resource",
		resource: { uri: "memo://1", text: "body", mimeType: "text/plain" },
	});
	assert.deepEqual(embeddedBlobResource("memo://2", new Uint8Array([0])), {
		type: "resource",
		resource: { uri: "memo://2", blob: "AA==" },
	});
});

test("tool, prompt and resource result constructors", () => {
	assert.deepEqual(toolResult(textContent("a"), textContent("b")), {
		content: [
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
		],
	});
	assert.deepEqual(jsonResult({ answer: 42 }), {
		content: [{ type: "text", text: '{"answer":42}' }],
		structuredContent: { answer: 42 },
	});
	assert.deepEqual(jsonResult({ answer: 42 }, textContent("forty-two")).content, [
		{ type: "text", text: "forty-two" },
	]);
	assert.deepEqual(errorResult("boom"), {
		content: [{ type: "text", text: "boom" }],
		isError: true,
	});
	assert.deepEqual(promptResult(userMessage("hi"), "greeting"), {
		messages: [{ role: "user", content: { type: "text", text: "hi" } }],
		description: "greeting",
	});
	assert.deepEqual(promptResult([userMessage("q"), assistantMessage("a")]).messages.length, 2);
	assert.deepEqual(resourceResult("memo://1", { text: "x", mimeType: "text/plain" }), {
		contents: [{ uri: "memo://1", text: "x", mimeType: "text/plain" }],
	});
	assert.deepEqual(resourceResult("memo://2", { blob: new Uint8Array([255]) }), {
		contents: [{ uri: "memo://2", blob: "/w==" }],
	});
});

test("jsonResult stays assignable to a schema-typed tool handler", () => {
	const outputSchema = fromJsonSchema<{ answer: number }>({
		type: "object",
		properties: { answer: { type: "number" } },
		required: ["answer"],
	});
	const tool = defineTool("typed", { outputSchema }, async () => jsonResult({ answer: 42 }));
	assert.equal(tool.name, "typed");
	// @ts-expect-error structuredContent must match the output schema.
	defineTool("mistyped", { outputSchema }, async () => jsonResult({ answer: "no" }));
});
