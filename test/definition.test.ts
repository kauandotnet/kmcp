import assert from "node:assert/strict";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";

import { KMCP_ERROR_CODES, KmcpError } from "../src/errors.ts";
import { createNodeMcpHandler } from "../src/node.ts";
import {
	MCP_MODERN_PROTOCOL_VERSION,
	McpServerApp,
	McpTool,
	defineResource,
	defineResourceTemplate,
	defineServer,
	defineTool,
	serverFrom,
	serverSourceFactory,
	textContent,
	toolResult,
} from "../src/server.ts";
import { createTestClient, forEachEra } from "./helpers/in-process.ts";

forEachEra("resource size and annotations are advertised on the wire", async (era) => {
	const definition = defineServer(
		{ name: "resource-metadata", version: "1.0.0" },
		{
			instructions: "Use the status resource first.",
			capabilities: [
				defineResource(
					"status",
					"status://current",
					{
						size: 2,
						annotations: { audience: ["user"], priority: 0.5 },
						tags: ["v1", "v1"],
					},
					async (uri) => ({ contents: [{ uri: uri.href, text: "ok" }] }),
				),
				defineResourceTemplate(
					"items",
					"items://{id}",
					{ annotations: { audience: ["assistant"] } },
					async (uri) => ({ contents: [{ uri: uri.href, text: "item" }] }),
				),
			],
		},
	);
	assert.deepEqual(definition.capabilities[0]?.tags, ["v1"]);
	assert.ok(Object.isFrozen(definition.capabilities[0]?.tags));
	const { client, close } = await createTestClient(definition, { era });
	try {
		const [resource] = (await client.listResources()).resources;
		assert.equal(resource?.size, 2);
		assert.deepEqual(resource?.annotations, { audience: ["user"], priority: 0.5 });
		const [template] = (await client.listResourceTemplates()).resourceTemplates;
		assert.deepEqual(template?.annotations, { audience: ["assistant"] });
		assert.equal(client.getInstructions(), "Use the status resource first.");
		assert.equal(client.getServerCapabilities()?.resources?.subscribe, true);
	} finally {
		await close();
	}
});

test("definitions reject duplicate names and duplicate resource URIs", () => {
	const read = async (uri: URL) => ({ contents: [{ uri: uri.href, text: "x" }] });
	assert.throws(
		() =>
			defineServer(
				{ name: "dup", version: "1.0.0" },
				{
					capabilities: [
						defineResource("a", "memo://same", {}, read),
						defineResource("b", "memo://same", {}, read),
					],
				},
			),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.CAPABILITY_DUPLICATE,
	);
	assert.throws(
		() =>
			defineServer(
				{ name: "dup", version: "1.0.0" },
				{
					capabilities: [
						defineResourceTemplate("a", "memo://{id}", {}, read),
						defineResourceTemplate("b", "memo://{id}", {}, read),
					],
				},
			),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.CAPABILITY_DUPLICATE,
	);
	assert.throws(
		() => defineResource("neg", "memo://x", { size: -1 }, read),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
});

test("withName and withMetadata produce canonical copies with live handlers", async () => {
	const input = fromJsonSchema<{ value: string }>({
		type: "object",
		properties: { value: { type: "string" } },
		required: ["value"],
	});
	const handler = async ({ value }: { value: string }) => toolResult(textContent(value));
	const tool = defineTool(
		"echo",
		{ description: "Echo", inputSchema: input, tags: ["a"] },
		handler,
	);
	const renamed = tool.withName("ns.echo").withMetadata({ description: "Namespaced echo" });
	assert.equal(renamed.name, "ns.echo");
	assert.equal(renamed.options.description, "Namespaced echo");
	assert.strictEqual(renamed.options.inputSchema, input);
	assert.strictEqual(renamed.handler, handler);
	assert.deepEqual(renamed.tags, ["a"]);
	const definition = defineServer(
		{ name: "renamed", version: "1.0.0" },
		{ capabilities: [renamed] },
	);
	const runtime = await definition.instantiate({ era: "modern" });
	assert.equal(runtime.registrations[0]?.definition.name, "ns.echo");
	await runtime.close();
});

test("setup cleanup runs when the runtime closes", async () => {
	const events: string[] = [];
	const definition = defineServer(
		{ name: "cleanup", version: "1.0.0" },
		{
			setup: () => {
				events.push("setup");
				return () => {
					events.push("cleanup");
				};
			},
		},
	);
	const runtime = await definition.instantiate({ era: "modern" });
	assert.deepEqual(events, ["setup"]);
	await runtime.close();
	await runtime.close();
	assert.deepEqual(events, ["setup", "cleanup"]);
});

test("serverFrom follows the prototype chain of a decorated app", () => {
	@McpServerApp({ serverInfo: { name: "base", version: "1.0.0" } })
	class BaseApp {
		@McpTool({ name: "base-tool" })
		async baseTool() {
			return toolResult(textContent("base"));
		}
	}
	class DerivedApp extends BaseApp {}
	const definition = serverFrom(new DerivedApp());
	assert.equal(definition.serverInfo.name, "base");
	assert.equal(definition.capabilities[0]?.name, "base-tool");
});

test("a server source getter is read per request so definitions can be hot-swapped", async () => {
	let current = defineServer(
		{ name: "swap", version: "1.0.0" },
		{ capabilities: [defineTool("first", {}, async () => toolResult())] },
	);
	const handler = createMcpHandler(
		serverSourceFactory(() => current),
		{ legacy: "reject" },
	);
	const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
		fetch: (url, init) => handler.fetch(new Request(url, init)),
	});
	const client = new Client(
		{ name: "swap-client", version: "0.0.0" },
		{ versionNegotiation: { mode: { pin: MCP_MODERN_PROTOCOL_VERSION } } },
	);
	try {
		await client.connect(transport);
		assert.deepEqual(
			(await client.listTools()).tools.map((t) => t.name),
			["first"],
		);
		current = current.with(defineTool("second", {}, async () => toolResult()));
		handler.notify.toolsChanged();
		assert.deepEqual(
			(await client.listTools(undefined, { cacheMode: "refresh" })).tools.map((t) => t.name),
			["first", "second"],
		);
	} finally {
		await client.close();
		await handler.close();
	}
	const node = createNodeMcpHandler(() => current);
	assert.equal(typeof node.fetch, "function");
	await node.close();
});
