import assert from "node:assert/strict";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { fromJsonSchema } from "@modelcontextprotocol/server";

import { MCP_MODERN_PROTOCOL_VERSION, defineServer, defineTool } from "../src/server.ts";
import { inProcessConnection } from "../src/client.ts";
import { KMCP_ERROR_CODES, KmcpError } from "../src/errors.ts";
import { createTestClient, forEachEra } from "./helpers/in-process.ts";

const definition = defineServer(
	{ name: "era-test", version: "1.0.0" },
	{
		capabilities: [
			defineTool(
				"echo",
				{
					inputSchema: fromJsonSchema<{ value: string }>({
						type: "object",
						properties: { value: { type: "string" } },
						required: ["value"],
					}),
				},
				async ({ value }) => ({ content: [{ type: "text", text: value }] }),
			),
		],
	},
);

forEachEra("an in-process connection negotiates the requested era", async (era) => {
	const { client, close } = await createTestClient(definition, { era });
	try {
		assert.equal(client.getProtocolEra(), era);
		if (era === "modern") {
			assert.equal(client.getNegotiatedProtocolVersion(), MCP_MODERN_PROTOCOL_VERSION);
		}
		const result = await client.callTool({ name: "echo", arguments: { value: "hi" } });
		assert.deepEqual(result.content, [{ type: "text", text: "hi" }]);
	} finally {
		await close();
	}
});

test("the modern in-process handler rejects a legacy-pinned client", async () => {
	const handler = definition.handler({ legacy: "reject" });
	const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
		fetch: (url, init) => handler.fetch(new Request(url, init)),
	});
	const client = new Client(
		{ name: "legacy-client", version: "0.0.0" },
		{ versionNegotiation: { mode: "legacy" } },
	);
	try {
		await assert.rejects(client.connect(transport));
	} finally {
		await client.close().catch(() => undefined);
		await handler.close();
	}
});

test("an in-process connection rejects a contradicting version negotiation", () => {
	assert.throws(
		() =>
			inProcessConnection({
				id: "bad",
				definition,
				era: "modern",
				clientOptions: { versionNegotiation: { mode: "legacy" } },
			}),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
	assert.throws(
		() =>
			inProcessConnection({
				id: "bad",
				definition,
				era: "legacy",
				clientOptions: { versionNegotiation: { mode: { pin: MCP_MODERN_PROTOCOL_VERSION } } },
			}),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
});
