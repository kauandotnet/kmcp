import assert from "node:assert/strict";
import test from "node:test";

import type { Transport } from "@modelcontextprotocol/client";
import { fromJsonSchema } from "@modelcontextprotocol/server";

import {
	KMCP_ERROR_CODES,
	KeyringKeyValueStore,
	KmcpError,
	McpConnectionManager,
	McpOAuthClientProvider,
	McpPromptContractError,
	definePrompt,
	defineServer,
	inProcessConnection,
	promptResult,
	resumedSessionFrom,
	userMessage,
	type McpKeyringEntry,
} from "../src/index.ts";
import { forEachEra } from "./helpers/in-process.ts";

test("resumedSessionFrom extracts the resume record only for session-bearing connections", async (t) => {
	const manager = new McpConnectionManager<"s">();
	t.after(() => manager.close());
	manager.register(
		inProcessConnection({
			id: "s",
			definition: defineServer({ name: "snap", version: "2.0.0" }, { instructions: "hi" }),
			era: "legacy",
		}),
	);
	await manager.connect("s");
	assert.equal(resumedSessionFrom(manager.state("s")), undefined);
	const client = await manager.withClient("s", async (c) => c);
	(client.transport as Transport).sessionId = "sess-9";
	const record = resumedSessionFrom(manager.state("s"));
	assert.deepEqual(record, {
		sessionId: "sess-9",
		protocolVersion: "2025-11-25",
		capabilities: manager.state("s").capabilities,
		serverInfo: { name: "snap", version: "2.0.0" },
		instructions: "hi",
	});
	assert.equal(JSON.parse(JSON.stringify(record)).sessionId, "sess-9", "the record is plain JSON");
});

test("KeyringKeyValueStore maps keys to keyring entries and wraps backend failures", async () => {
	const backend = new Map<string, string>();
	const seen: string[] = [];
	const entry = (service: string, account: string): McpKeyringEntry => {
		seen.push(`${service}|${account}`);
		return {
			getPassword: () => backend.get(account) ?? null,
			setPassword: (value) => {
				backend.set(account, value);
			},
			deletePassword: () => backend.delete(account),
		};
	};
	const store = new KeyringKeyValueStore({ service: "kmcp-test", entry });
	assert.equal(await store.get("missing"), undefined);
	await store.set("https://as.example.com/tokens", "secret");
	assert.equal(await store.get("https://as.example.com/tokens"), "secret");
	await store.delete("https://as.example.com/tokens");
	assert.equal(await store.get("https://as.example.com/tokens"), undefined);
	assert.ok(seen.every((call) => call.startsWith("kmcp-test|")));

	const hashed = new KeyringKeyValueStore({
		service: "kmcp-test",
		entry,
		account: (key) => `k:${key.length}`,
	});
	await hashed.set("abc", "v");
	assert.equal(backend.get("k:3"), "v");

	const provider = new McpOAuthClientProvider({
		serverUrl: "https://mcp.example.com/mcp",
		redirectUrl: "http://127.0.0.1:1/callback",
		store,
		onRedirect: () => undefined,
	});
	await provider.saveTokens(
		{ access_token: "a", token_type: "Bearer" },
		{ issuer: "https://as.example.com" },
	);
	assert.equal((await provider.tokens())?.access_token, "a");
	const status = await provider.status();
	assert.ok(status.savedAt);

	const broken = new KeyringKeyValueStore({
		service: "kmcp-test",
		entry: () => ({
			getPassword: () => {
				throw new Error("locked");
			},
			setPassword: () => undefined,
			deletePassword: () => true,
		}),
	});
	await assert.rejects(
		broken.get("x"),
		(error: unknown) =>
			error instanceof KmcpError &&
			error.code === KMCP_ERROR_CODES.OPERATION_FAILED &&
			(error.cause as Error).message === "locked",
	);
	assert.throws(
		() => new KeyringKeyValueStore({ service: " ", entry }),
		(error: unknown) => error instanceof KmcpError,
	);
});

forEachEra("getPrompt enforces a prompt contract before the request goes out", async (era) => {
	const definition = defineServer(
		{ name: "prompts", version: "1.0.0" },
		{
			capabilities: [
				definePrompt(
					"review",
					{
						argsSchema: fromJsonSchema<{ language: string; tone: string }>({
							type: "object",
							properties: { language: { type: "string" }, tone: { type: "string" } },
							required: ["language", "tone"],
						}),
					},
					async ({ language, tone }) => promptResult(userMessage(`Review ${language} ${tone}.`)),
				),
			],
		},
	);
	const manager = new McpConnectionManager<"p">();
	manager.register(inProcessConnection({ id: "p", definition, era }));
	try {
		await manager.connect("p");
		const expected = { name: "review", arguments: [{ name: "language", required: true }] };
		await assert.rejects(
			manager.getPrompt("p", "review", { language: "ts" }, { contract: { expected } }),
			(error: unknown) =>
				error instanceof McpPromptContractError &&
				error.code === KMCP_ERROR_CODES.PROMPT_CONTRACT_MISMATCH &&
				error.result.errors.some((line) => line.includes("tone")),
		);
		const ok = await manager.getPrompt(
			"p",
			"review",
			{ language: "ts", tone: "kind" },
			{ contract: { expected } },
		);
		assert.equal(ok.messages.length, 1);
		const check = await manager.checkPromptContract("p", "review", expected, {
			arguments: { language: "ts" },
		});
		assert.equal(check.valid, false);
		const missing = await manager.checkPromptContract("p", "nope", expected);
		assert.equal(missing.valid, false);
		assert.ok(missing.errors[0]?.includes("not advertised"));
	} finally {
		await manager.close();
	}
});
