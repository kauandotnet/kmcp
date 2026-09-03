import assert from "node:assert/strict";
import test from "node:test";

import { fromJsonSchema } from "@modelcontextprotocol/server";

import {
	McpConnectionManager,
	McpHubDefinition,
	McpHubManager,
	connectionProvider,
	defineServer,
	defineTool,
	hubProvider,
	inProcessConnection,
	notifyOnCatalogChange,
	textContent,
	toolResult,
} from "../src/index.ts";
import { createTestClient, forEachEra } from "./helpers/in-process.ts";

const inputSchema = fromJsonSchema<{ value: string }>({
	type: "object",
	properties: { value: { type: "string" } },
	required: ["value"],
});

function upstreamDefinition() {
	return defineServer(
		{ name: "upstream", version: "1.0.0" },
		{
			capabilities: [
				defineTool("echo", { description: "echoes", inputSchema }, async ({ value }) =>
					toolResult(textContent(`up:${value}`)),
				),
			],
		},
	);
}

async function upstreamManager() {
	const manager = new McpConnectionManager<"up">();
	manager.register(
		inProcessConnection({ id: "up", definition: upstreamDefinition(), era: "legacy" }),
	);
	await manager.connect("up");
	await manager.refreshCatalog("up");
	return manager;
}

forEachEra("connectionProvider projects the upstream catalog with fenced calls", async (era) => {
	const manager = await upstreamManager();
	const parent = defineServer(
		{ name: "front", version: "1.0.0" },
		{
			capabilities: [defineTool("local", {}, async () => toolResult(textContent("local")))],
			providers: [connectionProvider(manager, "up")],
			declare: ["tool", "prompt", "resource", "resource-template"],
		},
	);
	const { client, close } = await createTestClient(parent, { era });
	try {
		const tools = await client.listTools();
		assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["echo", "local"]);
		const result = await client.callTool({ name: "echo", arguments: { value: "x" } });
		assert.equal((result.content[0] as { text: string }).text, "up:x");
	} finally {
		await close();
		await manager.close();
	}
});

test("a pinned instance's projected call is fenced on the resolved generation", async () => {
	const manager = await upstreamManager();
	const parent = defineServer(
		{ name: "front-fence", version: "1.0.0" },
		{
			providers: [connectionProvider(manager, "up")],
			declare: ["tool", "prompt", "resource", "resource-template"],
		},
	);
	// Legacy pins one instance at connect; its handlers close over that catalog's generation.
	const { client, close } = await createTestClient(parent, { era: "legacy" });
	try {
		assert.equal(
			(
				(await client.callTool({ name: "echo", arguments: { value: "a" } })).content[0] as {
					text: string;
				}
			).text,
			"up:a",
		);
		// Bump the upstream generation: the pinned projection is now stale and must fail closed.
		await manager.disconnect("up");
		await manager.connect("up");
		await manager.refreshCatalog("up");
		// A thrown fence error surfaces as an isError tool result at the serving seam.
		const stale = await client.callTool({ name: "echo", arguments: { value: "b" } });
		assert.equal(stale.isError, true);
		assert.match((stale.content[0] as { text: string }).text, /no longer active|stale|not online/i);
	} finally {
		await close();
		await manager.close();
	}
});

test("an undiscovered upstream contributes nothing (per-request resolution)", async () => {
	const manager = await upstreamManager();
	const parent = defineServer(
		{ name: "front-empty", version: "1.0.0" },
		{
			providers: [connectionProvider(manager, "up")],
			declare: ["tool", "prompt", "resource", "resource-template"],
		},
	);
	const { client, close } = await createTestClient(parent, { era: "modern" });
	try {
		assert.equal((await client.listTools({}, { cacheMode: "bypass" })).tools.length, 1);
		// A reconnect clears the catalog until the next refresh: the projection honestly empties.
		await manager.disconnect("up");
		await manager.connect("up");
		assert.equal((await client.listTools({}, { cacheMode: "bypass" })).tools.length, 0);
		await manager.refreshCatalog("up");
		assert.equal((await client.listTools({}, { cacheMode: "bypass" })).tools.length, 1);
	} finally {
		await close();
		await manager.close();
	}
});

forEachEra("hubProvider projects namespaced hub routes", async (era) => {
	const manager = await upstreamManager();
	const hubs = new McpHubManager<"main", "up">(manager);
	hubs.register(
		new McpHubDefinition({ id: "main", members: [{ connectionId: "up", namespace: "a" }] }),
	);
	await hubs.refreshCatalog("main");
	const parent = defineServer(
		{ name: "front-hub", version: "1.0.0" },
		{
			providers: [hubProvider(hubs, "main")],
			declare: ["tool", "prompt", "resource", "resource-template"],
		},
	);
	const { client, close } = await createTestClient(parent, { era });
	try {
		const tools = await client.listTools();
		assert.deepEqual(
			tools.tools.map((tool) => tool.name),
			["a.echo"],
		);
		const result = await client.callTool({ name: "a.echo", arguments: { value: "y" } });
		assert.equal((result.content[0] as { text: string }).text, "up:y");
	} finally {
		await close();
		hubs.close();
		await manager.close();
	}
});

test("notifyOnCatalogChange coalesces catalog events into one notification burst", async () => {
	const manager = await upstreamManager();
	const counts = { tools: 0, prompts: 0, resources: 0 };
	const unsubscribe = notifyOnCatalogChange(
		manager,
		{
			notify: {
				toolsChanged: async () => {
					counts.tools += 1;
				},
				promptsChanged: async () => {
					counts.prompts += 1;
				},
				resourcesChanged: async () => {
					counts.resources += 1;
				},
				resourceUpdated: async () => undefined,
			},
		},
		{ connectionId: "up", debounceMs: 40 },
	);
	try {
		await manager.refreshCatalog("up");
		await manager.refreshCatalog("up");
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.deepEqual(counts, { tools: 1, prompts: 1, resources: 1 });
	} finally {
		unsubscribe();
		await manager.close();
	}
});
