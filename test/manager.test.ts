import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryTransport } from "@modelcontextprotocol/client";
import { fromJsonSchema, type McpServer } from "@modelcontextprotocol/server";

import {
	McpConnectionDefinition,
	McpConnectionManager,
	McpHubDefinition,
	McpHubManager,
	defineServer,
	defineTool,
} from "../src/index.ts";

const inputSchema = fromJsonSchema<{ value: string }>({
	type: "object",
	properties: { value: { type: "string" } },
	required: ["value"],
	additionalProperties: false,
});

test("connection manager exposes revisioned, secret-free snapshots and partial catalog state", async () => {
	const servers: McpServer[] = [];
	const definition = defineServer(
		{ name: "managed-server", version: "1.0.0" },
		{
			capabilities: [
				defineTool("echo", { inputSchema }, async ({ value }) => ({
					content: [{ type: "text", text: value }],
				})),
			],
		},
	);
	const connection = new McpConnectionDefinition({
		id: "alpha",
		label: "Alpha",
		clientOptions: { versionNegotiation: { mode: "legacy" } },
		transport: async () => {
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			const server = await definition.create({ era: "legacy" });
			servers.push(server);
			await server.connect(serverTransport);
			return clientTransport;
		},
	});
	const manager = new McpConnectionManager<"alpha">();
	const events: string[] = [];
	manager.subscribe((event) => {
		events.push(event.type);
	});
	manager.register(connection);
	assert.equal((await manager.connect("alpha")).phase, "online");
	const catalog = await manager.refreshCatalog("alpha");
	assert.equal(catalog.tools.status, "fresh");
	assert.equal(catalog.resources.status, "unsupported");
	assert.equal(catalog.tools.items[0]?.name, "echo");
	const result = await manager.callTool("alpha", "echo", { value: "hello" });
	assert.equal(result.content[0]?.type, "text");
	assert.equal(manager.snapshot().connections[0]?.generation, 1);
	assert.ok(events.includes("catalog.refreshed"));

	const hubs = new McpHubManager<"main", "alpha">(manager);
	hubs.register(
		new McpHubDefinition({
			id: "main",
			members: [{ connectionId: "alpha", namespace: "primary" }],
		}),
	);
	const hubCatalog = hubs.catalog("main");
	assert.equal(hubCatalog.tools[0]?.route, "primary.echo");
	const routed = await hubs.callTool("main", "primary.echo", { value: "routed" });
	assert.equal(routed.content[0]?.type, "text");
	await manager.remove("alpha");
	assert.equal(hubs.state("main").members.length, 0);

	hubs.close();
	await manager.close();
	await Promise.allSettled(servers.map((server) => server.close()));
});
