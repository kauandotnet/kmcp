import assert from "node:assert/strict";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { fromJsonSchema } from "@modelcontextprotocol/server";

import {
	MCP_MODERN_PROTOCOL_VERSION,
	defineResource,
	defineServer,
	defineTool,
} from "../src/server.ts";
import { serveMcpStdio } from "../src/node.ts";
import { forEachEra } from "./helpers/in-process.ts";

const definition = defineServer(
	{ name: "stdio-test", version: "1.0.0" },
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
			defineResource("status", "status://current", {}, async (uri) => ({
				contents: [{ uri: uri.href, text: "ok" }],
			})),
		],
	},
);

forEachEra("serveMcpStdio pins a runtime and can publish list-changed signals", async (era) => {
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const handle = serveMcpStdio(definition, { transport: serverSide });
	assert.equal(handle.runtime === undefined, true);
	await handle.notify.toolsChanged();

	let changes = 0;
	let resolveChange!: () => void;
	const changed = new Promise<void>((resolve) => {
		resolveChange = resolve;
	});
	const client = new Client(
		{ name: "stdio-client", version: "0.0.0" },
		{
			versionNegotiation:
				era === "modern" ? { mode: { pin: MCP_MODERN_PROTOCOL_VERSION } } : { mode: "legacy" },
			listChanged: {
				tools: {
					autoRefresh: false,
					debounceMs: 0,
					onChanged: () => {
						changes += 1;
						resolveChange();
					},
				},
			},
		},
	);
	try {
		await client.connect(clientSide);
		assert.equal(client.getProtocolEra(), era);
		const runtime = handle.runtime;
		assert.ok(runtime);
		assert.equal(runtime.registrations.length, 2);
		const result = await client.callTool({ name: "echo", arguments: { value: "hi" } });
		assert.deepEqual(result.content, [{ type: "text", text: "hi" }]);

		await handle.notify.toolsChanged();
		await changed;
		assert.equal(changes, 1);
		await handle.notify.resourceUpdated("status://never-subscribed");
	} finally {
		await client.close().catch(() => undefined);
		await handle.close();
	}
});
