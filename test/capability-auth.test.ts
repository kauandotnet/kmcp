import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryTransport } from "@modelcontextprotocol/client";
import type { AuthInfo } from "@modelcontextprotocol/server";

import { KMCP_ERROR_CODES, KmcpError } from "../src/errors.ts";
import { serveMcpStdio } from "../src/node.ts";
import {
	defineResource,
	defineServer,
	defineTool,
	requireScopes,
	textContent,
	toolResult,
	type McpCapabilityDenial,
} from "../src/server.ts";
import { createTestClient, forEachEra } from "./helpers/in-process.ts";

const admin: AuthInfo = {
	token: "t-admin",
	clientId: "admin-client",
	scopes: ["admin", "read"],
	expiresAt: Math.floor(Date.now() / 1000) + 3600,
};
const reader: AuthInfo = {
	...admin,
	token: "t-reader",
	clientId: "reader-client",
	scopes: ["read"],
};

function build(denials: McpCapabilityDenial[]) {
	return defineServer(
		{ name: "auth-test", version: "1.0.0" },
		{
			onCapabilityDenied: (denial) => denials.push(denial),
			capabilities: [
				defineTool(
					"admin-only",
					{ auth: { check: requireScopes("admin"), anonymous: "deny" } },
					async () => toolResult(textContent("secret")),
				),
				defineTool(
					"readers",
					{ auth: { check: requireScopes("read"), anonymous: "allow" } },
					async () => toolResult(textContent("public-ish")),
				),
				defineResource(
					"guarded",
					"guarded://doc",
					{ auth: { check: () => true, anonymous: "deny" } },
					async (uri) => ({ contents: [{ uri: uri.href, text: "doc" }] }),
				),
			],
		},
	);
}

forEachEra("capabilities are admitted per principal at materialization", async (era) => {
	const denials: McpCapabilityDenial[] = [];
	const definition = build(denials);

	const asAdmin = await createTestClient(definition, { era, authInfo: admin });
	try {
		const tools = (await asAdmin.client.listTools()).tools.map((tool) => tool.name).sort();
		assert.deepEqual(tools, ["admin-only", "readers"]);
		const result = await asAdmin.client.callTool({ name: "admin-only", arguments: {} });
		assert.deepEqual(result.content, [{ type: "text", text: "secret" }]);
		assert.equal((await asAdmin.client.listResources()).resources.length, 1);
	} finally {
		await asAdmin.close();
	}

	const asReader = await createTestClient(definition, { era, authInfo: reader });
	try {
		const tools = (await asReader.client.listTools()).tools.map((tool) => tool.name);
		assert.deepEqual(tools, ["readers"]);
		await assert.rejects(
			asReader.client.callTool({ name: "admin-only", arguments: {} }),
			/not found/,
		);
	} finally {
		await asReader.close();
	}
	assert.ok(
		denials.some((d) => d.definition.name === "admin-only" && /missing scope/.test(d.reason)),
	);
});

forEachEra("an anonymous principal sees empty lists, never a missing capability", async (era) => {
	const definition = build([]);
	const anonymous = await createTestClient(definition, { era });
	try {
		const tools = (await anonymous.client.listTools()).tools.map((tool) => tool.name);
		assert.deepEqual(tools, ["readers"]);
		assert.deepEqual((await anonymous.client.listResources()).resources, []);
		assert.ok(anonymous.client.getServerCapabilities()?.resources);
	} finally {
		await anonymous.close();
	}
});

forEachEra(
	"a definition authorized to nothing still answers tools/list with an empty list",
	async (era) => {
		const definition = defineServer(
			{ name: "empty", version: "1.0.0" },
			{
				capabilities: [
					defineTool("gated", { auth: { check: () => false, anonymous: "deny" } }, async () =>
						toolResult(),
					),
				],
			},
		);
		const anonymous = await createTestClient(definition, { era });
		try {
			assert.deepEqual((await anonymous.client.listTools()).tools, []);
			assert.ok(anonymous.client.getServerCapabilities()?.tools);
		} finally {
			await anonymous.close();
		}
	},
);

test("a throwing auth check fails closed and is reported", async () => {
	const denials: McpCapabilityDenial[] = [];
	const definition = defineServer(
		{ name: "throwing", version: "1.0.0" },
		{
			onCapabilityDenied: (denial) => denials.push(denial),
			capabilities: [
				defineTool(
					"flaky",
					{
						auth: {
							check: () => {
								throw new Error("policy service down");
							},
							anonymous: "allow",
						},
					},
					async () => toolResult(),
				),
			],
		},
	);
	const runtime = await definition.instantiate({ era: "modern", authInfo: admin });
	try {
		assert.equal(runtime.registrations.length, 0);
		assert.match(denials[0]?.reason ?? "", /policy service down/);
	} finally {
		await runtime.close();
	}
});

test("serveMcpStdio refuses a definition that requires an authenticated principal", () => {
	const definition = build([]);
	assert.equal(definition.requiresAuthenticatedPrincipal, true);
	const [, serverSide] = InMemoryTransport.createLinkedPair();
	assert.throws(
		() => serveMcpStdio(definition, { transport: serverSide }),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.CAPABILITY_AUTH_UNSERVEABLE,
	);
});

test("auth.anonymous has no default", () => {
	assert.throws(
		() =>
			defineTool(
				"bad",
				// @ts-expect-error anonymous is required.
				{ auth: { check: () => true } },
				async () => toolResult(),
			),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
});
