import assert from "node:assert/strict";

import { fromJsonSchema } from "@modelcontextprotocol/server";

import {
	definePrompt,
	defineResourceTemplate,
	defineServer,
	promptResult,
	userMessage,
} from "../src/server.ts";
import { createTestClient, forEachEra } from "./helpers/in-process.ts";

const languages = ["typescript", "python", "rust"];

const definition = defineServer(
	{ name: "completion-test", version: "1.0.0" },
	{
		capabilities: [
			definePrompt(
				"review",
				{
					argsSchema: fromJsonSchema<{ language: string; style?: string }>({
						type: "object",
						properties: { language: { type: "string" }, style: { type: "string" } },
						required: ["language"],
					}),
					complete: {
						language: (value) => languages.filter((l) => l.startsWith(value)),
						style: (value, context) =>
							context?.arguments?.language === "rust" ? ["idiomatic"] : [`plain-${value}`],
					},
				},
				async ({ language }) => promptResult(userMessage(`Review this ${language} code.`)),
			),
			definePrompt("plain", {}, async () => promptResult(userMessage("no args"))),
			defineResourceTemplate(
				"users",
				"users://{id}/profile",
				{
					complete: { id: (value) => ["1", "10", "100"].filter((id) => id.startsWith(value)) },
				},
				async (uri) => ({ contents: [{ uri: uri.href, text: "profile" }] }),
			),
		],
	},
);

forEachEra(
	"prompt arguments complete from kmcp maps, templates from SDK callbacks",
	async (era) => {
		const { client, close } = await createTestClient(definition, { era });
		try {
			assert.ok(client.getServerCapabilities()?.completions);
			const language = await client.complete({
				ref: { type: "ref/prompt", name: "review" },
				argument: { name: "language", value: "ty" },
			});
			assert.deepEqual(language.completion.values, ["typescript"]);
			assert.equal(language.completion.total, 1);
			assert.equal(language.completion.hasMore, false);

			const style = await client.complete({
				ref: { type: "ref/prompt", name: "review" },
				argument: { name: "style", value: "x" },
				context: { arguments: { language: "rust" } },
			});
			assert.deepEqual(style.completion.values, ["idiomatic"]);

			const none = await client.complete({
				ref: { type: "ref/prompt", name: "plain" },
				argument: { name: "anything", value: "" },
			});
			assert.deepEqual(none.completion.values, []);

			const ids = await client.complete({
				ref: { type: "ref/resource", uri: "users://{id}/profile" },
				argument: { name: "id", value: "10" },
			});
			assert.deepEqual(ids.completion.values, ["10", "100"]);

			await assert.rejects(
				client.complete({
					ref: { type: "ref/prompt", name: "missing" },
					argument: { name: "x", value: "" },
				}),
			);
			const prompts = (await client.listPrompts()).prompts;
			const review = prompts.find((prompt) => prompt.name === "review");
			assert.deepEqual(
				review?.arguments?.map((argument) => [argument.name, argument.required]),
				[
					["language", true],
					["style", false],
				],
			);
		} finally {
			await close();
		}
	},
);
