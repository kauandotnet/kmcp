import assert from "node:assert/strict";
import test from "node:test";

import type { FetchLike } from "@modelcontextprotocol/client";

import {
	KMCP_ERROR_CODES,
	KmcpError,
	probeServerAuth,
	suggestAuth,
	type McpServerAuthProbe,
} from "../src/index.ts";

const MCP = "https://mcp.example.test/mcp";
const AS = "https://as.example.test";
const RESOURCE_METADATA = "https://mcp.example.test/.well-known/oauth-protected-resource/mcp";

interface ProbeCall {
	readonly method: string;
	readonly url: string;
	readonly accept: string | undefined;
}

interface FakeEndpoint {
	readonly fetch: FetchLike;
	readonly calls: ProbeCall[];
}

type Route = (call: ProbeCall) => Response | undefined;

function json(body: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("content-type", "application/json");
	return new Response(JSON.stringify(body), { ...init, headers });
}

/** A mock fetch driven by an ordered route table; unmatched requests are a test bug, not a 404. */
function fakeEndpoint(...routes: readonly Route[]): FakeEndpoint {
	const calls: ProbeCall[] = [];
	return {
		calls,
		fetch: async (input, init) => {
			const headers = new Headers(init?.headers);
			const call: ProbeCall = {
				method: init?.method ?? "GET",
				url: String(input),
				accept: headers.get("accept") ?? undefined,
			};
			calls.push(call);
			for (const route of routes) {
				const response = route(call);
				if (response !== undefined) return response;
			}
			throw new Error(`unrouted ${call.method} ${call.url}`);
		},
	};
}

/** The RFC 9728 document plus the RFC 8414 document the OAuth verdict is assembled from. */
function discoveryRoutes(
	resource: Record<string, unknown>,
	authorizationServer: Record<string, unknown>,
): readonly Route[] {
	return [
		(call) =>
			call.url.startsWith("https://mcp.example.test/.well-known/oauth-protected-resource")
				? json({ resource: MCP, authorization_servers: [AS], ...resource })
				: undefined,
		(call) =>
			call.url === `${AS}/.well-known/oauth-authorization-server`
				? json({
						issuer: AS,
						authorization_endpoint: `${AS}/authorize`,
						token_endpoint: `${AS}/token`,
						response_types_supported: ["code"],
						code_challenge_methods_supported: ["S256"],
						...authorizationServer,
					})
				: undefined,
	];
}

function challenge(value: string, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("www-authenticate", value);
	return new Response("Unauthorized", { ...init, status: 401, headers });
}

function assertKind<Kind extends McpServerAuthProbe["kind"]>(
	probe: McpServerAuthProbe,
	kind: Kind,
): Extract<McpServerAuthProbe, { kind: Kind }> {
	assert.equal(probe.kind, kind);
	return probe as Extract<McpServerAuthProbe, { kind: Kind }>;
}

test("probeServerAuth reports an unauthenticated server as open", async () => {
	const endpoint = fakeEndpoint(() =>
		json(
			{ jsonrpc: "2.0", id: 0, result: {} },
			{ headers: { "mcp-session-id": "s-1", "mcp-protocol-version": "2026-07-28" } },
		),
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const open = assertKind(probe, "open");
	assert.equal(open.serverUrl, MCP);
	assert.equal(open.httpStatus, 200);
	assert.equal(open.sessionful, true);
	assert.equal(open.protocolVersionHeader, "2026-07-28");
	// One POST settles it: no GET fallback, no discovery.
	assert.equal(endpoint.calls.length, 1);
	assert.equal(endpoint.calls[0]?.method, "POST");
	assert.equal(endpoint.calls[0]?.accept, "application/json, text/event-stream");

	assert.deepEqual(suggestAuth(open), {
		grant: "none",
		interactive: false,
		note: "The server answered without an authorization challenge; connect with no auth provider.",
	});
});

test("probeServerAuth resolves an OAuth challenge into servers, grants, scopes and registration", async () => {
	const endpoint = fakeEndpoint(
		(call) =>
			call.url === MCP
				? challenge(`Bearer resource_metadata="${RESOURCE_METADATA}", scope="mcp:read mcp:write"`, {
						headers: { "mcp-protocol-version": "2026-07-28" },
					})
				: undefined,
		...discoveryRoutes(
			{
				scopes_supported: ["mcp:read", "mcp:write", "mcp:admin"],
				extensions: ["io.modelcontextprotocol/oauth-client-credentials"],
			},
			{
				registration_endpoint: `${AS}/register`,
				grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
				scopes_supported: ["mcp:read", "mcp:write", "mcp:admin"],
				client_id_metadata_document_supported: true,
			},
		),
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const oauth = assertKind(probe, "oauth");
	assert.equal(oauth.httpStatus, 401);
	assert.equal(oauth.protocolVersionHeader, "2026-07-28");
	assert.equal(oauth.sessionful, false);
	assert.equal(oauth.resourceMetadataUrl, RESOURCE_METADATA);
	assert.deepEqual([...oauth.authorizationServers], [AS]);
	assert.equal(oauth.resourceMetadata?.resource, MCP);
	assert.equal(oauth.authorizationServerMetadata?.token_endpoint, `${AS}/token`);
	assert.deepEqual(
		[...oauth.grants],
		["authorization_code", "refresh_token", "client_credentials"],
	);
	// The challenge's own scope leads, then whatever the resource metadata advertises.
	assert.deepEqual([...(oauth.scopes ?? [])], ["mcp:read", "mcp:write", "mcp:admin"]);
	// A registration endpoint wins over CIMD: it is what McpOAuthClientProvider drives unaided.
	assert.equal(oauth.registration, "dynamic");
	assert.deepEqual(
		[...(oauth.extensions ?? [])],
		["io.modelcontextprotocol/oauth-client-credentials"],
	);

	const suggestion = suggestAuth(oauth);
	assert.equal(suggestion.grant, "authorization_code");
	assert.equal(suggestion.interactive, true);
	assert.match(suggestion.note, /Dynamic Client Registration/);
});

test("probeServerAuth reports CIMD when the authorization server registers nothing dynamically", async () => {
	const endpoint = fakeEndpoint(
		(call) => (call.url === MCP ? challenge("Bearer") : undefined),
		...discoveryRoutes({}, { client_id_metadata_document_supported: true }),
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const oauth = assertKind(probe, "oauth");
	assert.equal(oauth.registration, "cimd");
	assert.equal(oauth.resourceMetadataUrl, undefined);
	// RFC 8414 §2: an omitted `grant_types_supported` means authorization_code + implicit.
	assert.deepEqual([...oauth.grants], ["authorization_code", "implicit"]);
	assert.match(suggestAuth(oauth).note, /Client ID Metadata Document/);
});

test("probeServerAuth suggests the client-credentials grant when that is all the server offers", async () => {
	const endpoint = fakeEndpoint(
		(call) => (call.url === MCP ? challenge("Bearer") : undefined),
		...discoveryRoutes({}, { grant_types_supported: ["client_credentials"] }),
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const oauth = assertKind(probe, "oauth");
	assert.equal(oauth.registration, "preregistered-only");
	const suggestion = suggestAuth(oauth);
	assert.equal(suggestion.grant, "client_credentials");
	assert.equal(suggestion.interactive, false);
	assert.match(suggestion.note, /clientCredentialsAuth/);
});

test("probeServerAuth falls back to the server origin when there is no protected-resource metadata", async () => {
	const endpoint = fakeEndpoint(
		(call) => (call.url === MCP ? challenge("Bearer") : undefined),
		(call) =>
			call.url.startsWith("https://mcp.example.test/.well-known/")
				? new Response("nope", { status: 404 })
				: undefined,
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const oauth = assertKind(probe, "oauth");
	assert.deepEqual([...oauth.authorizationServers], ["https://mcp.example.test/"]);
	assert.deepEqual([...oauth.grants], []);
	assert.equal(oauth.registration, "unknown");
	// Nothing readable still means "send the user to a browser": that is the MCP default.
	const suggestion = suggestAuth(oauth);
	assert.equal(suggestion.grant, "authorization_code");
	assert.equal(suggestion.interactive, true);
});

test("probeServerAuth reports a non-OAuth challenge as a bearer scheme", async () => {
	const endpoint = fakeEndpoint(() => challenge('Basic realm="corp proxy", charset="UTF-8"'));
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const bearer = assertKind(probe, "bearer");
	assert.equal(bearer.scheme, "Basic");
	assert.equal(bearer.realm, "corp proxy");
	assert.equal(bearer.httpStatus, 401);
	// No discovery is attempted for a scheme kmcp cannot drive.
	assert.equal(endpoint.calls.length, 1);

	const suggestion = suggestAuth(bearer);
	assert.equal(suggestion.grant, "none");
	assert.equal(suggestion.interactive, false);
	assert.match(suggestion.note, /not OAuth/);
});

test("probeServerAuth reports a 404 as not-mcp without guessing a transport", async () => {
	const endpoint = fakeEndpoint(() => new Response("Not Found", { status: 404 }));
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const notMcp = assertKind(probe, "not-mcp");
	assert.equal(notMcp.httpStatus, 404);
	assert.match(notMcp.reason, /HTTP 404/);
	assert.equal(notMcp.suggestedTransport, undefined);
	assert.deepEqual(
		endpoint.calls.map((call) => call.method),
		["POST", "GET"],
	);
	assert.match(suggestAuth(notMcp).note, /Check the URL/);
});

test("probeServerAuth spots the deprecated SSE transport behind a 405", async () => {
	const sseUrl = "https://legacy.example.test/sse";
	const endpoint = fakeEndpoint((call) =>
		call.method === "POST"
			? new Response("Method Not Allowed", { status: 405 })
			: new Response("", { status: 200, headers: { "content-type": "text/event-stream" } }),
	);
	const probe = await probeServerAuth(sseUrl, { fetch: endpoint.fetch });

	const notMcp = assertKind(probe, "not-mcp");
	assert.equal(notMcp.httpStatus, 405);
	assert.equal(notMcp.suggestedTransport, "sse");
	assert.match(notMcp.reason, /event stream/);
	assert.match(suggestAuth(notMcp).note, /sseConnection/);
});

test("probeServerAuth reports an HTML page as not-mcp", async () => {
	const endpoint = fakeEndpoint(
		() =>
			new Response("<!doctype html><title>Docs</title>", {
				status: 200,
				headers: { "content-type": "text/html; charset=utf-8" },
			}),
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const notMcp = assertKind(probe, "not-mcp");
	assert.equal(notMcp.httpStatus, 200);
	assert.match(notMcp.reason, /HTML page/);
});

test("probeServerAuth classifies a refused connection as unreachable", async () => {
	const refused = Object.assign(new TypeError("fetch failed"), {
		cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
			code: "ECONNREFUSED",
		}),
	});
	const probe = await probeServerAuth(MCP, {
		fetch: () => Promise.reject(refused),
	});

	const unreachable = assertKind(probe, "unreachable");
	assert.equal(unreachable.code, "ECONNREFUSED");
	assert.equal(unreachable.httpStatus, undefined);
	assert.equal(unreachable.sessionful, undefined);
	assert.match(suggestAuth(unreachable).note, /ECONNREFUSED/);
});

test("probeServerAuth reports a cross-origin redirect instead of following it", async () => {
	const endpoint = fakeEndpoint(
		() =>
			new Response(null, {
				status: 302,
				headers: { location: "https://other.example.test/mcp" },
			}),
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const redirect = assertKind(probe, "redirect");
	assert.equal(redirect.location, "https://other.example.test/mcp");
	assert.equal(redirect.httpStatus, 302);
	assert.equal(endpoint.calls.length, 1);
	assert.match(suggestAuth(redirect).note, /other\.example\.test/);
});

test("probeServerAuth follows a same-origin redirect", async () => {
	const endpoint = fakeEndpoint(
		(call) =>
			call.url === MCP
				? new Response(null, { status: 307, headers: { location: "/v2/mcp" } })
				: undefined,
		() => json({ jsonrpc: "2.0", id: 0, result: {} }),
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	assertKind(probe, "open");
	assert.deepEqual(
		endpoint.calls.map((call) => call.url),
		[MCP, "https://mcp.example.test/v2/mcp"],
	);
});

test("probeServerAuth reports an unexplained status as an error", async () => {
	const endpoint = fakeEndpoint(() => new Response("boom", { status: 503 }));
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const error = assertKind(probe, "error");
	assert.equal(error.httpStatus, 503);
	assert.equal(suggestAuth(error).grant, "none");
});

test("probeServerAuth gives up on its own deadline when fetch never settles", async () => {
	const probe = await probeServerAuth(MCP, {
		timeoutMs: 20,
		fetch: () => new Promise<Response>(() => {}),
	});

	const unreachable = assertKind(probe, "unreachable");
	assert.equal(unreachable.code, "TimeoutError");
	assert.equal(unreachable.serverUrl, MCP);
});

test("probeServerAuth throws only for invalid input", async () => {
	for (const bad of ["ftp://mcp.example.test/mcp", "not a url", "stdio:///bin/server"]) {
		await assert.rejects(
			() => probeServerAuth(bad),
			(error: unknown) => {
				assert.ok(error instanceof KmcpError);
				assert.equal(error.code, KMCP_ERROR_CODES.INVALID_DEFINITION);
				return true;
			},
			bad,
		);
	}
	await assert.rejects(
		() => probeServerAuth(MCP, { timeoutMs: 0 }),
		(error: unknown) => error instanceof KmcpError && error.code === "INVALID_DEFINITION",
	);
});
