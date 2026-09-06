import assert from "node:assert/strict";
import test from "node:test";

import {
	Client,
	MCP_CLIENT_CREDENTIALS_EXTENSION,
	McpOAuthClientProvider,
	SSEClientTransport,
	StreamableHTTPClientTransport,
	UnauthorizedError,
	clientCredentialsAuth,
	sseConnection,
	specTypeSchemas,
	withLogging,
} from "../src/client.ts";
import { KMCP_ERROR_CODES, KmcpError } from "../src/errors.ts";
import * as root from "../src/index.ts";

test("sseConnection builds a legacy-only definition over the deprecated SSE transport", async () => {
	const provider = new McpOAuthClientProvider({
		serverUrl: "https://legacy.example.com/sse",
		redirectUrl: "http://127.0.0.1:1/callback",
		onRedirect: () => undefined,
	});
	const interactive = sseConnection({
		id: "legacy",
		url: "https://legacy.example.com/sse",
		auth: provider,
		headers: { "x-tenant": "a" },
	});
	assert.equal(interactive.transportKind, "sse");
	assert.deepEqual(interactive.clientOptions.versionNegotiation, { mode: "legacy" });
	assert.equal(interactive.interactiveOAuth, true);
	// Nothing is derived from the credential; the SDK's per-client cache needs no partition.
	assert.equal(interactive.clientOptions.cachePartition, undefined);
	const transport = await interactive.openTransport();
	assert.ok(transport instanceof SSEClientTransport);
	await transport.close();

	const m2m = sseConnection({
		id: "m2m",
		url: "https://legacy.example.com/sse",
		auth: clientCredentialsAuth({ clientId: "a", clientSecret: "b" }),
	});
	assert.deepEqual(m2m.clientOptions.capabilities?.extensions, {
		[MCP_CLIENT_CREDENTIALS_EXTENSION]: {},
	});
	assert.equal(m2m.interactiveOAuth, false);

	assert.throws(
		() =>
			sseConnection({
				id: "bad",
				url: "https://legacy.example.com/sse",
				auth: "token",
				headers: { Authorization: "Bearer other" },
			}),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
	assert.throws(
		() =>
			sseConnection({
				id: "bad",
				url: "https://legacy.example.com/sse",
				clientOptions: { versionNegotiation: { mode: "auto" } },
			}),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
});

test("kmcp/client re-exports the curated SDK client surface and the package root stays unambiguous", () => {
	assert.equal(typeof Client, "function");
	assert.equal(typeof StreamableHTTPClientTransport, "function");
	assert.equal(typeof UnauthorizedError, "function");
	assert.equal(typeof withLogging, "function");
	assert.equal(typeof specTypeSchemas.CallToolResult, "object");
	// Symbols both entries know come through the root exactly once, as the same binding.
	assert.equal(root.Client, Client);
	assert.equal(root.UnauthorizedError, UnauthorizedError);
	assert.equal(root.MCP_MODERN_PROTOCOL_VERSION, "2026-07-28");
	assert.equal(typeof root.SdkError, "function", "the server entry's SDK errors reach the root");
	assert.equal(typeof root.sseConnection, "function");
});
