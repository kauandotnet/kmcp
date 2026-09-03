import assert from "node:assert/strict";

import {
	definePrompt,
	defineServer,
	defineTool,
	disable,
	enable,
	promptResult,
	textContent,
	toolResult,
	userMessage,
} from "../src/index.ts";
import { createTestClient, forEachEra } from "./helpers/in-process.ts";

function capabilities() {
	return [
		defineTool("pub", { tags: ["public"] }, async () => toolResult(textContent("pub"))),
		defineTool("internal", { tags: ["ops"] }, async () => toolResult(textContent("internal"))),
		definePrompt("greet", {}, () => promptResult(userMessage("hi"))),
	];
}

forEachEra("an allowlist hides everything but the enabled selection", async (era) => {
	const definition = defineServer(
		{ name: "vis", version: "1.0.0" },
		{
			capabilities: capabilities(),
			visibility: [disable({}), enable({ tags: ["public"] })],
		},
	);
	const { client, close } = await createTestClient(definition, { era });
	try {
		const tools = await client.listTools();
		assert.deepEqual(
			tools.tools.map((tool) => tool.name),
			["pub"],
		);
		const prompts = await client.listPrompts();
		assert.deepEqual(prompts.prompts, []);
		const hidden = await client.callTool({ name: "internal" }).then(
			() => "resolved",
			() => "rejected",
		);
		assert.equal(hidden, "rejected");
	} finally {
		await close();
	}
});

forEachEra("the last matching visibility rule wins", async (era) => {
	const definition = defineServer(
		{ name: "vis-order", version: "1.0.0" },
		{
			capabilities: capabilities(),
			visibility: [disable({ names: ["pub"] }), enable({ names: ["pub"] })],
		},
	);
	const { client, close } = await createTestClient(definition, { era });
	try {
		const tools = await client.listTools();
		assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["internal", "pub"]);
	} finally {
		await close();
	}
});

forEachEra("visibility and per-capability auth both filter", async (era) => {
	const secret = defineTool(
		"secret",
		{ tags: ["public"], auth: { anonymous: "deny", check: () => true } },
		async () => toolResult(textContent("secret")),
	);
	const definition = defineServer(
		{ name: "vis-auth", version: "1.0.0" },
		{
			capabilities: [...capabilities(), secret],
			visibility: [disable({}), enable({ tags: ["public"] })],
		},
	);
	const anonymous = await createTestClient(definition, { era });
	try {
		const tools = await anonymous.client.listTools();
		// `secret` passes visibility but is auth-denied for an anonymous request.
		assert.deepEqual(
			tools.tools.map((tool) => tool.name),
			["pub"],
		);
	} finally {
		await anonymous.close();
	}
	const authed = await createTestClient(definition, {
		era,
		authInfo: { token: "token", clientId: "c", scopes: [] },
	});
	try {
		const tools = await authed.client.listTools();
		assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["pub", "secret"]);
	} finally {
		await authed.close();
	}
});
