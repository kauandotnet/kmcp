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

/** Every well-known lookup answers 404, so discovery finds nothing at all. */
const noDiscovery: Route = (call) =>
	call.url.includes("/.well-known/") ? new Response("nope", { status: 404 }) : undefined;

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
	// `determineScope` asks for the challenge's scope and never widens it to the advertised set.
	assert.deepEqual([...(oauth.scopes ?? [])], ["mcp:read", "mcp:write"]);
	assert.deepEqual([...(oauth.scopesSupported ?? [])], ["mcp:read", "mcp:write", "mcp:admin"]);
	// `auth()` prefers CIMD over registering, so that is what the probe reports…
	assert.equal(oauth.registration, "cimd");
	// …while `dynamicRegistration` keeps the other route visible to a host with no metadata URL.
	assert.equal(oauth.dynamicRegistration, true);
	assert.equal(oauth.issues, undefined);
	assert.deepEqual(
		[...(oauth.extensions ?? [])],
		["io.modelcontextprotocol/oauth-client-credentials"],
	);

	const suggestion = suggestAuth(oauth);
	assert.equal(suggestion.grant, "authorization_code");
	assert.equal(suggestion.interactive, true);
	assert.match(suggestion.note, /Client ID Metadata Document/);
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
	assert.equal(oauth.dynamicRegistration, false);
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

test("probeServerAuth suggests no grant when the server advertises none kmcp can drive", async () => {
	const endpoint = fakeEndpoint(
		(call) => (call.url === MCP ? challenge("Bearer") : undefined),
		...discoveryRoutes(
			{},
			{ grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code", "implicit"] },
		),
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const oauth = assertKind(probe, "oauth");
	const suggestion = suggestAuth(oauth);
	assert.equal(suggestion.grant, "none");
	assert.equal(suggestion.interactive, false);
	assert.match(suggestion.note, /device_code, implicit/);
	assert.match(suggestion.note, /neither authorization_code nor client_credentials/);
});

test("probeServerAuth falls back to the advertised scopes only when the challenge names none", async () => {
	const endpoint = fakeEndpoint(
		(call) => (call.url === MCP ? challenge("Bearer") : undefined),
		...discoveryRoutes({ scopes_supported: ["mcp:read"] }, { scopes_supported: ["as:extra"] }),
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const oauth = assertKind(probe, "oauth");
	// The resource metadata is `determineScope`'s only fallback; the AS list is advertisement.
	assert.deepEqual([...(oauth.scopes ?? [])], ["mcp:read"]);
	assert.deepEqual([...(oauth.scopesSupported ?? [])], ["mcp:read", "as:extra"]);
});

test("probeServerAuth falls back to the server origin when there is no protected-resource metadata", async () => {
	const endpoint = fakeEndpoint(
		(call) => (call.url === MCP ? challenge("Bearer") : undefined),
		noDiscovery,
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const oauth = assertKind(probe, "oauth");
	assert.deepEqual([...oauth.authorizationServers], ["https://mcp.example.test/"]);
	assert.deepEqual([...oauth.grants], []);
	assert.equal(oauth.registration, "unknown");
	assert.equal(oauth.dynamicRegistration, false);
	// Nothing readable still means "send the user to a browser": that is the MCP default.
	const suggestion = suggestAuth(oauth);
	assert.equal(suggestion.grant, "authorization_code");
	assert.equal(suggestion.interactive, true);
});

test("probeServerAuth keeps the endpoint's query on the protected-resource lookup", async () => {
	const url = `${MCP}?tenant=acme#ignored`;
	const endpoint = fakeEndpoint(
		(call) => (call.url.startsWith(`${MCP}?tenant=acme`) ? challenge("Bearer") : undefined),
		...discoveryRoutes({ resource: `${MCP}?tenant=acme` }, {}),
	);
	const probe = await probeServerAuth(url, { fetch: endpoint.fetch });

	assertKind(probe, "oauth");
	// `discoverMetadataWithFallback` copies `issuer.search` onto the well-known URL; only the
	// fragment is dropped, exactly as `resourceUrlFromServerUrl` does for a real connection.
	assert.ok(
		endpoint.calls.some(
			(call) =>
				call.url ===
				`https://mcp.example.test/.well-known/oauth-protected-resource/mcp?tenant=acme`,
		),
		endpoint.calls.map((call) => call.url).join("\n"),
	);
	assert.ok(
		!endpoint.calls.some((call) => call.url.includes("/.well-known/") && call.url.includes("#")),
	);
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

test("probeServerAuth finds a Bearer challenge behind other schemes in one header", async () => {
	const endpoint = fakeEndpoint(
		(call) =>
			call.url === MCP
				? challenge(
						`Negotiate, Basic realm="corp proxy", Bearer realm="mcp", resource_metadata="${RESOURCE_METADATA}", scope="mcp:read"`,
					)
				: undefined,
		...discoveryRoutes({}, {}),
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	// RFC 7235 allows several challenges: the Bearer one wins even when it is listed last.
	const oauth = assertKind(probe, "oauth");
	assert.equal(oauth.resourceMetadataUrl, RESOURCE_METADATA);
	assert.deepEqual([...(oauth.scopes ?? [])], ["mcp:read"]);
});

test("probeServerAuth still reports a non-OAuth scheme when no challenge is a Bearer", async () => {
	const endpoint = fakeEndpoint(() => challenge('Negotiate, Basic realm="corp, and more"'));
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const bearer = assertKind(probe, "bearer");
	assert.equal(bearer.scheme, "Negotiate");
	assert.equal(bearer.realm, undefined);
	assert.equal(endpoint.calls.length, 1);
});

test("probeServerAuth treats a 403 with a Bearer challenge as a scope step-up", async () => {
	const endpoint = fakeEndpoint(
		(call) =>
			call.url === MCP
				? new Response("Forbidden", {
						status: 403,
						headers: {
							"www-authenticate": 'Bearer error="insufficient_scope", scope="mcp:admin"',
						},
					})
				: undefined,
		...discoveryRoutes({}, {}),
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const oauth = assertKind(probe, "oauth");
	assert.equal(oauth.httpStatus, 403);
	assert.deepEqual([...(oauth.scopes ?? [])], ["mcp:admin"]);
	assert.equal(suggestAuth(oauth).grant, "authorization_code");
});

test("probeServerAuth reports a challenge-less 401 as unauthorized when discovery finds nothing", async () => {
	const endpoint = fakeEndpoint(
		(call) => (call.url === MCP ? new Response("no", { status: 401 }) : undefined),
		noDiscovery,
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const unauthorized = assertKind(probe, "unauthorized");
	assert.equal(unauthorized.httpStatus, 401);
	// The SDK's well-known fallback still ran before the verdict was reached.
	assert.ok(endpoint.calls.some((call) => call.url.includes("/.well-known/")));

	const suggestion = suggestAuth(unauthorized);
	assert.equal(suggestion.grant, "none");
	assert.equal(suggestion.interactive, false);
	assert.match(suggestion.note, /credentials are required/);
	assert.match(suggestion.note, /never said which/);
});

test("probeServerAuth reports a bare 403 as unauthorized", async () => {
	const endpoint = fakeEndpoint(
		(call) => (call.url === MCP ? new Response("no", { status: 403 }) : undefined),
		noDiscovery,
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const unauthorized = assertKind(probe, "unauthorized");
	assert.equal(unauthorized.httpStatus, 403);
});

test("probeServerAuth reports a challenge-less 401 as oauth when discovery finds a server", async () => {
	const endpoint = fakeEndpoint(
		(call) => (call.url === MCP ? new Response("no", { status: 401 }) : undefined),
		...discoveryRoutes({}, { registration_endpoint: `${AS}/register` }),
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const oauth = assertKind(probe, "oauth");
	assert.equal(oauth.httpStatus, 401);
	assert.equal(oauth.registration, "dynamic");
	assert.equal(suggestAuth(oauth).grant, "authorization_code");
});

test("probeServerAuth flags a protected resource that does not cover the probed URL", async () => {
	const endpoint = fakeEndpoint(
		(call) => (call.url === MCP ? challenge("Bearer") : undefined),
		...discoveryRoutes({ resource: "https://elsewhere.example.test/mcp" }, {}),
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const oauth = assertKind(probe, "oauth");
	assert.equal(oauth.issues?.length, 1);
	assert.match(oauth.issues?.[0] ?? "", /selectResourceURL/);
	assert.match(oauth.issues?.[0] ?? "", /elsewhere\.example\.test/);

	// `auth()` would throw here, so no grant is worth suggesting.
	const suggestion = suggestAuth(oauth);
	assert.equal(suggestion.grant, "none");
	assert.equal(suggestion.interactive, false);
	assert.match(suggestion.note, /would refuse this one/);
});

test("probeServerAuth flags a token endpoint the SDK would refuse to post to", async () => {
	const endpoint = fakeEndpoint(
		(call) => (call.url === MCP ? challenge("Bearer") : undefined),
		...discoveryRoutes({}, { token_endpoint: "http://as.example.test/token" }),
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const oauth = assertKind(probe, "oauth");
	assert.equal(oauth.issues?.length, 1);
	assert.match(oauth.issues?.[0] ?? "", /token endpoint/);
	assert.equal(suggestAuth(oauth).grant, "none");
});

test("probeServerAuth refuses a resource_metadata URL aimed at a link-local address", async () => {
	const hostile = "https://169.254.169.254/.well-known/oauth-protected-resource";
	const endpoint = fakeEndpoint(
		(call) => (call.url === MCP ? challenge(`Bearer resource_metadata="${hostile}"`) : undefined),
		(call) =>
			call.url.startsWith("https://169.254.169.254")
				? json({ resource: MCP, authorization_servers: ["https://attacker.example.test"] })
				: undefined,
		noDiscovery,
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const oauth = assertKind(probe, "oauth");
	assert.ok(!endpoint.calls.some((call) => call.url.includes("169.254.169.254")));
	assert.equal(oauth.resourceMetadataUrl, undefined);
	// Discovery fell back to the well-known path, so no attacker-chosen server was surfaced.
	assert.deepEqual([...oauth.authorizationServers], ["https://mcp.example.test/"]);
});

test("probeServerAuth refuses a plaintext resource_metadata URL for a TLS server", async () => {
	const hostile = "http://mcp.example.test/.well-known/oauth-protected-resource";
	const endpoint = fakeEndpoint(
		(call) => (call.url === MCP ? challenge(`Bearer resource_metadata="${hostile}"`) : undefined),
		noDiscovery,
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const oauth = assertKind(probe, "oauth");
	assert.ok(!endpoint.calls.some((call) => call.url.startsWith("http://")));
	assert.equal(oauth.resourceMetadataUrl, undefined);
});

test("probeServerAuth does not follow redirects during discovery", async () => {
	const endpoint = fakeEndpoint(
		(call) => (call.url === MCP ? challenge("Bearer") : undefined),
		(call) =>
			call.url.includes("/.well-known/")
				? new Response(null, {
						status: 302,
						headers: { location: "https://attacker.example.test/metadata" },
					})
				: undefined,
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const oauth = assertKind(probe, "oauth");
	assert.ok(!endpoint.calls.some((call) => call.url.startsWith("https://attacker.example.test")));
	// A redirect during discovery counts as "nothing published here".
	assert.equal(oauth.authorizationServerMetadata, undefined);
	assert.deepEqual([...oauth.authorizationServers], ["https://mcp.example.test/"]);
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

test("probeServerAuth lets a caller replace the Accept header and quotes what it sent", async () => {
	const endpoint = fakeEndpoint(() => new Response("Not Acceptable", { status: 406 }));
	const probe = await probeServerAuth(MCP, {
		fetch: endpoint.fetch,
		// Differently cased: `Headers` replaces the probe's own value rather than appending to it.
		headers: { Accept: "application/json" },
	});

	const notMcp = assertKind(probe, "not-mcp");
	assert.deepEqual(
		endpoint.calls.map((call) => call.accept),
		["application/json", "application/json"],
	);
	assert.match(notMcp.reason, /rejected 'application\/json'/);
	assert.ok(!notMcp.reason.includes("text/event-stream"));
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
	assert.equal(redirect.reason, "cross-origin");
	assert.equal(redirect.location, "https://other.example.test/mcp");
	assert.equal(redirect.httpStatus, 302);
	assert.equal(endpoint.calls.length, 1);
	assert.match(suggestAuth(redirect).note, /other\.example\.test/);
	assert.match(suggestAuth(redirect).note, /another origin/);
});

test("probeServerAuth refuses a same-origin redirect that leaves http(s)", async () => {
	const endpoint = fakeEndpoint(
		() =>
			new Response(null, {
				status: 307,
				// `blob:` reports the inner URL's origin, so an origin check alone would follow this.
				headers: { location: "blob:https://mcp.example.test/9f2c" },
			}),
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const redirect = assertKind(probe, "redirect");
	assert.equal(redirect.reason, "cross-origin");
	assert.equal(redirect.location, "blob:https://mcp.example.test/9f2c");
	assert.equal(endpoint.calls.length, 1);
});

test("probeServerAuth reports an exhausted same-origin redirect chain as too-many-redirects", async () => {
	let hop = 0;
	const endpoint = fakeEndpoint(() => {
		hop += 1;
		return new Response(null, { status: 307, headers: { location: `/hop/${hop}` } });
	});
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const redirect = assertKind(probe, "redirect");
	// The chain never left the origin: saying "cross-origin" would point back into the loop.
	assert.equal(redirect.reason, "too-many-redirects");
	assert.equal(redirect.location, "https://mcp.example.test/hop/3");
	assert.equal(endpoint.calls.length, 3);
	const note = suggestAuth(redirect).note;
	assert.match(note, /within its own origin/);
	assert.ok(!note.includes("another origin"));
});

test("probeServerAuth reports an opaque redirect without inventing a location", async () => {
	const opaque = new Response(null, { status: 200 });
	Object.defineProperty(opaque, "type", { value: "opaqueredirect" });
	const probe = await probeServerAuth(MCP, { fetch: () => Promise.resolve(opaque) });

	const redirect = assertKind(probe, "redirect");
	assert.equal(redirect.reason, "opaque");
	// The URL just probed is not the redirect target: report no location rather than a wrong one.
	assert.equal(redirect.location, undefined);
	assert.match(suggestAuth(redirect).note, /hid the target/);
});

test("probeServerAuth bounds a server-chosen redirect location", async () => {
	const endpoint = fakeEndpoint(
		() =>
			new Response(null, {
				status: 302,
				headers: { location: `https://other.example.test/${"a".repeat(2000)}` },
			}),
	);
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const redirect = assertKind(probe, "redirect");
	assert.ok((redirect.location?.length ?? 0) <= 401, String(redirect.location?.length));
	assert.ok(redirect.location?.endsWith("…"));
	assert.ok((suggestAuth(redirect).note.length ?? 0) < 600);
});

test("probeServerAuth reports an unexplained status as an error", async () => {
	const endpoint = fakeEndpoint(() => new Response("boom", { status: 503 }));
	const probe = await probeServerAuth(MCP, { fetch: endpoint.fetch });

	const error = assertKind(probe, "error");
	assert.equal(error.httpStatus, 503);
	assert.equal(suggestAuth(error).grant, "none");
});

test("probeServerAuth never buffers a body, so an open stream does not hold it", async () => {
	// A body that never ends: reading it to completion would hang the probe past its own deadline,
	// because a response already in hand is no longer racing the abort signal.
	const stream = new ReadableStream<Uint8Array>({ start() {} });
	const endpoint = fakeEndpoint(
		() =>
			new Response(stream, {
				status: 503,
				headers: { "content-type": "text/event-stream" },
			}),
	);
	const hung = Symbol("hung");
	const guard = new Promise<typeof hung>((resolve) => {
		setTimeout(() => resolve(hung), 2000).unref();
	});
	const probe = await Promise.race([probeServerAuth(MCP, { fetch: endpoint.fetch }), guard]);

	assert.notEqual(probe, hung);
	assert.equal(assertKind(probe as McpServerAuthProbe, "error").httpStatus, 503);
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

test("probeServerAuth leaves no unhandled rejection when a fetch rejects after the deadline", async () => {
	const rejections: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		rejections.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	try {
		const endpoint = fakeEndpoint((call) => (call.url === MCP ? challenge("Bearer") : undefined));
		const probe = await probeServerAuth(MCP, {
			timeoutMs: 25,
			// A `fetch` that ignores `signal` and fails late: the POST answers at once, then both
			// discovery legs lose the race — the first to the abort listener, the second to the
			// already-aborted fast path — and neither loser may be left unobserved.
			fetch: async (input, init) => {
				const early = await Promise.resolve(endpoint.fetch(input, init)).catch(() => undefined);
				if (early !== undefined) return early;
				return await new Promise<Response>((_, reject) => {
					setTimeout(() => reject(new Error("late failure")), 60).unref();
				});
			},
		});

		assertKind(probe, "oauth");
		await new Promise((resolve) => {
			setTimeout(resolve, 150).unref();
		});
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
	assert.deepEqual(rejections, []);
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
