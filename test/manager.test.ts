import assert from "node:assert/strict";

import { fromJsonSchema } from "@modelcontextprotocol/server";

import {
	McpConnectionManager,
	McpHubDefinition,
	McpHubManager,
	defineServer,
	defineTool,
	inProcessConnection,
} from "../src/index.ts";
import { forEachEra } from "./helpers/in-process.ts";

const inputSchema = fromJsonSchema<{ value: string }>({
	type: "object",
	properties: { value: { type: "string" } },
	required: ["value"],
	additionalProperties: false,
});

forEachEra(
	"connection manager exposes revisioned, secret-free snapshots and partial catalog state",
	async (era) => {
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
		const connection = inProcessConnection({ id: "alpha", label: "Alpha", definition, era });
		const manager = new McpConnectionManager<"alpha">();
		const events: string[] = [];
		manager.subscribe((event) => {
			events.push(event.type);
		});
		manager.register(connection);
		const connected = await manager.connect("alpha");
		assert.equal(connected.phase, "online");
		assert.equal(connected.protocolEra, era);
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
	},
);
