import assert from "node:assert/strict";
import test from "node:test";

import { fromJsonSchema } from "@modelcontextprotocol/server";

import {
	definePrompt,
	defineResource,
	defineServer,
	defineTool,
	promptResult,
	promptsAsTools,
	resourcesAsTools,
	searchTools,
	textContent,
	toolResult,
	userMessage,
} from "../src/index.ts";
import { Bm25Index } from "../src/discovery/bm25.ts";
import { createTestClient, forEachEra } from "./helpers/in-process.ts";

const inputSchema = fromJsonSchema<{ city: string }>({
	type: "object",
	properties: { city: { type: "string", description: "the city to forecast" } },
	required: ["city"],
});

function catalogDefinition() {
	return defineServer(
		{ name: "disco", version: "1.0.0" },
		{
			capabilities: [
				defineTool(
					"weather",
					{ description: "Fetches the weather forecast for a city.", inputSchema },
					async ({ city }) => toolResult(textContent(`sunny in ${city}`)),
				),
				defineTool("mailer", { description: "Sends email messages." }, async () =>
					toolResult(textContent("sent")),
				),
				defineTool(
					"admin_wipe",
					{
						description: "Wipes everything.",
						auth: { anonymous: "deny", check: () => true },
					},
					async () => toolResult(textContent("wiped")),
				),
				definePrompt("greet", { description: "Greets someone." }, () =>
					promptResult(userMessage("hello")),
				),
			],
		},
	);
}

test("Bm25Index ranks relevant documents above irrelevant ones", () => {
	const index = new Bm25Index([
		{ id: "weather", text: "weather forecast city sunny rain" },
		{ id: "mailer", text: "email messages smtp send" },
	]);
	assert.deepEqual(index.search("weather forecast", 5), ["weather"]);
	assert.deepEqual(index.search("email", 5), ["mailer"]);
	assert.deepEqual(index.search("zzzz", 5), []);
});

forEachEra("searchTools replaces the tool catalog with the meta-tools", async (era) => {
	const definition = searchTools(catalogDefinition(), { maxResults: 3 });
	const { client, close } = await createTestClient(definition, { era });
	try {
		const tools = await client.listTools();
		assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["call_tool", "search_tools"]);
		// Prompts pass through unchanged.
		const prompts = await client.listPrompts();
		assert.deepEqual(
			prompts.prompts.map((prompt) => prompt.name),
			["greet"],
		);

		const found = await client.callTool({
			name: "search_tools",
			arguments: { query: "weather forecast" },
		});
		const results = JSON.parse((found.content[0] as { text: string }).text) as {
			tools: { name: string }[];
		};
		assert.deepEqual(
			results.tools.map((tool) => tool.name),
			["weather"],
		);

		const called = await client.callTool({
			name: "call_tool",
			arguments: { name: "weather", arguments: { city: "Oslo" } },
		});
		assert.equal((called.content[0] as { text: string }).text, "sunny in Oslo");

		const invalid = await client.callTool({
			name: "call_tool",
			arguments: { name: "weather", arguments: {} },
		});
		assert.equal(invalid.isError, true);

		const recursive = await client.callTool({
			name: "call_tool",
			arguments: { name: "call_tool", arguments: {} },
		});
		assert.equal(recursive.isError, true);
	} finally {
		await close();
	}
});

forEachEra("the call_tool proxy respects per-request admission", async (era) => {
	const definition = searchTools(catalogDefinition());
	const anonymous = await createTestClient(definition, { era });
	try {
		// `admin_wipe` is auth-denied for anonymous requests: not searchable, not callable.
		const found = await anonymous.client.callTool({
			name: "search_tools",
			arguments: { query: "wipes everything" },
		});
		const results = JSON.parse((found.content[0] as { text: string }).text) as {
			tools: { name: string }[];
		};
		assert.deepEqual(results.tools, []);
		const called = await anonymous.client.callTool({
			name: "call_tool",
			arguments: { name: "admin_wipe" },
		});
		assert.equal(called.isError, true);
		assert.match((called.content[0] as { text: string }).text, /unknown tool/i);
	} finally {
		await anonymous.close();
	}
	const authed = await createTestClient(definition, {
		era,
		authInfo: { token: "t", clientId: "c", scopes: [] },
	});
	try {
		const called = await authed.client.callTool({
			name: "call_tool",
			arguments: { name: "admin_wipe" },
		});
		assert.equal(called.isError, undefined);
	} finally {
		await authed.close();
	}
});

forEachEra("alwaysVisible tools stay directly listed", async (era) => {
	const definition = searchTools(catalogDefinition(), { alwaysVisible: ["mailer"] });
	const { client, close } = await createTestClient(definition, { era });
	try {
		const tools = await client.listTools();
		assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
			"call_tool",
			"mailer",
			"search_tools",
		]);
		const direct = await client.callTool({ name: "mailer" });
		assert.equal((direct.content[0] as { text: string }).text, "sent");
	} finally {
		await close();
	}
});

forEachEra("resourcesAsTools lists and reads through synthesized tools", async (era) => {
	const definition = resourcesAsTools(
		defineServer(
			{ name: "disco-res", version: "1.0.0" },
			{
				capabilities: [
					defineResource(
						"readme",
						"docs://readme",
						{ description: "the readme", mimeType: "text/markdown" },
						async (uri) => ({ contents: [{ uri: uri.href, text: "# hi" }] }),
					),
				],
			},
		),
	);
	const { client, close } = await createTestClient(definition, { era });
	try {
		const tools = await client.listTools();
		const names = tools.tools.map((tool) => tool.name).sort();
		assert.deepEqual(names, ["list_resources", "read_resource"]);
		const listing = await client.callTool({ name: "list_resources" });
		const parsed = JSON.parse((listing.content[0] as { text: string }).text) as {
			resources: { uri: string }[];
		};
		assert.deepEqual(
			parsed.resources.map((resource) => resource.uri),
			["docs://readme"],
		);
		const read = await client.callTool({
			name: "read_resource",
			arguments: { uri: "docs://readme" },
		});
		const block = read.content[0] as { type: string; resource: { text: string } };
		assert.equal(block.type, "resource");
		assert.equal(block.resource.text, "# hi");
		const missing = await client.callTool({
			name: "read_resource",
			arguments: { uri: "docs://other" },
		});
		assert.equal(missing.isError, true);
		// keep defaults to true: the original resource stays listed.
		const resources = await client.listResources();
		assert.deepEqual(
			resources.resources.map((resource) => resource.uri),
			["docs://readme"],
		);
	} finally {
		await close();
	}
});

forEachEra("promptsAsTools renders prompts through synthesized tools", async (era) => {
	const definition = promptsAsTools(catalogDefinition(), { keep: false });
	const { client, close } = await createTestClient(definition, { era });
	try {
		const prompts = await client.listPrompts();
		assert.deepEqual(prompts.prompts, []);
		const listing = await client.callTool({ name: "list_prompts" });
		const parsed = JSON.parse((listing.content[0] as { text: string }).text) as {
			prompts: { name: string }[];
		};
		assert.deepEqual(
			parsed.prompts.map((prompt) => prompt.name),
			["greet"],
		);
		const rendered = await client.callTool({
			name: "get_prompt",
			arguments: { name: "greet" },
		});
		const body = JSON.parse((rendered.content[0] as { text: string }).text) as {
			messages: { content: { text: string } }[];
		};
		assert.equal(body.messages[0]?.content.text, "hello");
		const unknown = await client.callTool({
			name: "get_prompt",
			arguments: { name: "nope" },
		});
		assert.equal(unknown.isError, true);
	} finally {
		await close();
	}
});
