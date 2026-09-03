import assert from "node:assert/strict";
import test from "node:test";

import type { AuthInfo, McpRequestContext } from "@modelcontextprotocol/server";

import {
	McpInsufficientScopeError,
	allOf,
	anyOf,
	authorize,
	defineServer,
	defineTool,
	requireRoles,
	requireScopes,
	restrictTag,
	textContent,
	toolResult,
	type McpAuthVerdict,
} from "../src/index.ts";
import { createTestClient, forEachEra } from "./helpers/in-process.ts";

const context: McpRequestContext = { era: "modern" };

function authInfo(scopes: readonly string[], extra?: Record<string, unknown>): AuthInfo {
	return { token: "t", clientId: "c", scopes: [...scopes], ...(extra ? { extra } : {}) };
}

async function verdictOf(
	check: (authInfo: AuthInfo, context: McpRequestContext) => unknown,
	info: AuthInfo,
): Promise<McpAuthVerdict> {
	return (await check(info, context)) as McpAuthVerdict;
}

test("requireScopes reports the missing scopes", async () => {
	const check = requireScopes("read", "write");
	assert.deepEqual(await verdictOf(check, authInfo(["read", "write"])), { allowed: true });
	const denied = await verdictOf(check, authInfo(["read"]));
	assert.equal(denied.allowed, false);
	assert.ok(!denied.allowed && denied.missingScopes !== undefined);
	assert.deepEqual(denied.allowed ? [] : [...(denied.missingScopes ?? [])], ["write"]);
});

test("requireRoles denies without disclosing scopes", async () => {
	const check = requireRoles(
		(info) => (info.extra?.["roles"] as string[] | undefined) ?? [],
		"admin",
	);
	assert.deepEqual(await verdictOf(check, authInfo([], { roles: ["admin"] })), { allowed: true });
	const denied = await verdictOf(check, authInfo([], { roles: ["user"] }));
	assert.equal(denied.allowed, false);
	assert.ok(!denied.allowed && denied.missingScopes === undefined);
});

test("allOf unions scope shortfalls and stops at the first opaque failure", async () => {
	const scopeAware = allOf(requireScopes("a"), requireScopes("b"));
	const denied = await verdictOf(scopeAware, authInfo([]));
	assert.ok(!denied.allowed);
	assert.deepEqual([...(denied.allowed ? [] : (denied.missingScopes ?? []))].sort(), ["a", "b"]);

	const withOpaque = allOf(requireScopes("a"), () => false, requireScopes("b"));
	const stopped = await verdictOf(withOpaque, authInfo([]));
	assert.ok(!stopped.allowed);
	// Aggregation stops at the opaque check: `b` is never disclosed.
	assert.deepEqual([...(stopped.allowed ? [] : (stopped.missingScopes ?? []))], ["a"]);
});

test("anyOf passes on the first success", async () => {
	const either = anyOf(requireScopes("a"), requireScopes("b"));
	assert.deepEqual(await verdictOf(either, authInfo(["b"])), { allowed: true });
	const denied = await verdictOf(either, authInfo([]));
	assert.ok(!denied.allowed);
});

forEachEra("restrictTag stamps scope auth onto tagged capabilities", async (era) => {
	const definition = defineServer(
		{ name: "restrict", version: "1.0.0" },
		{
			capabilities: [
				defineTool("open", {}, async () => toolResult(textContent("open"))),
				defineTool("guarded", { tags: ["sensitive"] }, async () =>
					toolResult(textContent("guarded")),
				),
			],
		},
	).transform(restrictTag("sensitive", "admin"));
	const anonymous = await createTestClient(definition, { era });
	try {
		const tools = await anonymous.client.listTools();
		assert.deepEqual(
			tools.tools.map((tool) => tool.name),
			["open"],
		);
	} finally {
		await anonymous.close();
	}
	const admin = await createTestClient(definition, { era, authInfo: authInfo(["admin"]) });
	try {
		const tools = await admin.client.listTools();
		assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["guarded", "open"]);
	} finally {
		await admin.close();
	}
});

forEachEra("authorize() enforces extra checks at call time", async (era) => {
	const definition = defineServer(
		{ name: "authz", version: "1.0.0" },
		{
			capabilities: [defineTool("act", {}, async () => toolResult(textContent("done")))],
			middleware: [authorize(requireScopes("ops"))],
		},
	);
	const missing = await createTestClient(definition, { era, authInfo: authInfo(["other"]) });
	try {
		const result = await missing.client.callTool({ name: "act" });
		assert.equal(result.isError, true);
		assert.match((result.content[0] as { text: string }).text, /ops/);
	} finally {
		await missing.close();
	}
	const allowed = await createTestClient(definition, { era, authInfo: authInfo(["ops"]) });
	try {
		const result = await allowed.client.callTool({ name: "act" });
		assert.equal(result.isError, undefined);
	} finally {
		await allowed.close();
	}
});

test("McpInsufficientScopeError carries only the missing scopes", () => {
	const error = new McpInsufficientScopeError(["a", "b"]);
	assert.equal(error.code, "CAPABILITY_INSUFFICIENT_SCOPE");
	assert.deepEqual([...error.missingScopes], ["a", "b"]);
});
