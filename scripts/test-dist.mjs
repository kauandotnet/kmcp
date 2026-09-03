// Smoke-test the built package under plain Node through its own exports map.
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/client";
import { fromJsonSchema } from "@modelcontextprotocol/server";

const entries = ["kmcp", "kmcp/server", "kmcp/client", "kmcp/hub", "kmcp/node"];
const modules = Object.fromEntries(
	await Promise.all(entries.map(async (entry) => [entry, await import(entry)])),
);
for (const entry of entries) {
	assert.ok(Object.keys(modules[entry]).length > 0, `${entry} exports nothing`);
}

const { defineServer, defineTool, MCP_MODERN_PROTOCOL_VERSION } = modules["kmcp/server"];
const { inProcessConnection, McpTaskClient, clientCredentialsAuth, oauthGrantOf } =
	modules["kmcp/client"];
const { createNodeMcpHandler, discoverMcpConfigs, browserOpenCommand } = modules["kmcp/node"];
assert.equal(typeof McpTaskClient, "function");
assert.equal(
	oauthGrantOf(clientCredentialsAuth({ clientId: "a", clientSecret: "b" })),
	"client_credentials",
);
assert.equal(typeof discoverMcpConfigs, "function");
assert.equal(browserOpenCommand(new URL("https://x.example/a"), "linux").command, "xdg-open");

const definition = defineServer(
	{ name: "dist-smoke", version: "0.0.0" },
	{
		capabilities: [
			defineTool(
				"echo",
				{ inputSchema: fromJsonSchema({ type: "object", properties: { v: { type: "string" } } }) },
				async ({ v }) => ({ content: [{ type: "text", text: String(v) }] }),
			),
		],
	},
);

for (const era of ["modern", "legacy"]) {
	const connection = inProcessConnection({ id: "smoke", definition, era });
	const transport = await connection.openTransport();
	const client = new Client(connection.clientInfo, connection.clientOptions);
	await client.connect(transport, connection.connectOptions);
	assert.equal(client.getProtocolEra(), era);
	if (era === "modern")
		assert.equal(client.getNegotiatedProtocolVersion(), MCP_MODERN_PROTOCOL_VERSION);
	const result = await client.callTool({ name: "echo", arguments: { v: "ok" } });
	assert.equal(result.content[0].text, "ok");
	await client.close();
}

const node = createNodeMcpHandler(definition);
assert.equal(typeof node.fetch, "function");
await node.close();
console.log("dist smoke: ok");
