/**
 * Wire golden test for `server/discover` (protocol revision 2026-07-28).
 *
 * Deliberately client-SDK-free: the request is a hand-built `Request` handed straight to
 * `definition.handler({ legacy: "reject" }).fetch(...)`, and the reserved `_meta` envelope keys are
 * written as string LITERALS rather than through `PROTOCOL_VERSION_META_KEY` and friends. If the
 * SDK ever renames a reserved key, importing the constant would silently follow it; the literal
 * fails loudly, which is the whole point of a golden.
 *
 * The assertions pin the exact result body a kmcp definition produces, so the capability
 * pre-declaration in `buildServerOptions` (tools/prompts/resources.subscribe/logging/completions),
 * the cache fields the modern encode seam stamps (`ttlMs`, `cacheScope`), the `resultType`
 * discriminator, and the `io.modelcontextprotocol/serverInfo` stamp are all covered by one
 * comparison.
 *
 * Not part of `pnpm run test` (that glob is `test/*.test.js`). Run it with:
 *   pnpm exec tsc -p tsconfig.test.json --outDir .test-dist-conformance \
 *     && node --test .test-dist-conformance/test/conformance/discover.golden.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
	definePrompt,
	defineResource,
	defineResourceTemplate,
	defineServer,
	defineTool,
	fromJsonSchema,
	promptResult,
	resourceResult,
	textContent,
	toolResult,
	userMessage,
} from "../../src/server.ts";

/** The reserved envelope keys, as string literals — never imported from the SDK. See the header. */
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
const MODERN_PROTOCOL_VERSION = "2026-07-28";

const definition = defineServer(
	{ name: "discover-golden", version: "1.0.0" },
	{
		instructions: "Golden fixture for the server/discover wire shape.",
		logging: true,
		capabilities: [
			defineTool("echo", { description: "Echoes." }, async () => toolResult(textContent("echo"))),
			definePrompt(
				"review",
				{
					description: "A prompt with a completable argument.",
					argsSchema: fromJsonSchema<{ language: string }>({
						type: "object",
						properties: { language: { type: "string" } },
						required: ["language"],
					}),
					// A `complete` map is what makes kmcp advertise `completions` at all.
					complete: { language: (value) => ["typescript"].filter((l) => l.startsWith(value)) },
				},
				async ({ language }) => promptResult(userMessage(`Review this ${language}.`)),
			),
			defineResource("note", "test://note", { mimeType: "text/plain" }, async (uri) =>
				resourceResult(uri.href, { text: "note", mimeType: "text/plain" }),
			),
			defineResourceTemplate(
				"notes",
				"test://notes/{id}",
				{ mimeType: "text/plain" },
				async (uri) => resourceResult(uri.href, { text: "note", mimeType: "text/plain" }),
			),
		],
	},
);

/** The modern `server/discover` exchange, byte for byte. */
function discoverRequest(): Request {
	return new Request("http://127.0.0.1/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			// A modern POST must carry BOTH the protocol-version header and, for `server/discover`,
			// the `Mcp-Method` header. Without the latter the entry answers `-32020`
			// ("the request headers and body disagree"), never the discover result.
			"MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
			"Mcp-Method": "server/discover",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "server/discover",
			params: {
				_meta: {
					[PROTOCOL_VERSION_KEY]: MODERN_PROTOCOL_VERSION,
					[CLIENT_INFO_KEY]: { name: "golden-client", version: "0.0.0" },
					[CLIENT_CAPABILITIES_KEY]: {},
				},
			},
		}),
	});
}

test("server/discover answers the exact modern wire shape", async () => {
	const handler = definition.handler({ legacy: "reject" });
	try {
		const response = await handler.fetch(discoverRequest());
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "application/json");

		const payload: unknown = await response.json();
		assert.deepEqual(payload, {
			jsonrpc: "2.0",
			id: 1,
			result: {
				supportedVersions: [MODERN_PROTOCOL_VERSION],
				capabilities: {
					tools: { listChanged: true },
					prompts: { listChanged: true },
					resources: { listChanged: true, subscribe: true },
					logging: {},
					completions: {},
				},
				instructions: "Golden fixture for the server/discover wire shape.",
				resultType: "complete",
				ttlMs: 0,
				cacheScope: "private",
				_meta: { [SERVER_INFO_KEY]: { name: "discover-golden", version: "1.0.0" } },
			},
		});
	} finally {
		await handler.close();
	}
});

test("server/discover advertises the negotiable modern revision and cache fields", async () => {
	const handler = definition.handler({ legacy: "reject" });
	try {
		const response = await handler.fetch(discoverRequest());
		const body = (await response.json()) as {
			result: {
				supportedVersions: string[];
				capabilities: Record<string, unknown> & {
					resources?: { subscribe?: boolean };
				};
				ttlMs?: number;
				cacheScope?: string;
			};
		};
		const result = body.result;

		// `supportedVersions` lists only modern revisions — 2025 versions are negotiated through
		// `initialize`, never advertised here.
		assert.ok(result.supportedVersions.includes(MODERN_PROTOCOL_VERSION));
		assert.ok(!result.supportedVersions.some((version) => version.startsWith("2025-")));

		// Capability pre-declaration: every kind is advertised from the definition's capability
		// list, so an empty list is never mistaken for "unsupported".
		assert.deepEqual(result.capabilities["completions"], {});
		assert.deepEqual(result.capabilities["logging"], {});
		assert.equal(result.capabilities.resources?.subscribe, true);

		// Cache fields are always present on a cacheable modern result.
		assert.equal(typeof result.ttlMs, "number");
		assert.equal(typeof result.cacheScope, "string");
	} finally {
		await handler.close();
	}
});

test("a legacy-shaped POST is rejected by a legacy: 'reject' handler", async () => {
	const handler = definition.handler({ legacy: "reject" });
	try {
		const response = await handler.fetch(
			new Request("http://127.0.0.1/mcp", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-11-25",
						capabilities: {},
						clientInfo: { name: "legacy-client", version: "0.0.0" },
					},
				}),
			}),
		);
		const body = (await response.json()) as { error?: { code?: number } };
		assert.notEqual(body.error, undefined);
		// `ProtocolErrorCode.UnsupportedProtocolVersion`, written as a literal for the same reason
		// the envelope keys are: the wire number is the contract, not the enum member name.
		assert.equal(body.error?.code, -32022);
	} finally {
		await handler.close();
	}
});
