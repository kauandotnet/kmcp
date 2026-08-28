import assert from "node:assert/strict";
import { createServer, request as httpRequestRaw } from "node:http";
import test, { type TestContext } from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AuthInfo, OAuthTokenVerifier } from "@modelcontextprotocol/server";

import { OAuthError, OAuthErrorCode, staticTokenVerifier } from "../src/auth.ts";
import { KMCP_ERROR_CODES, KmcpError } from "../src/errors.ts";
import { createNodeMcpHandler, mcpHttpEnvOptions, serveMcpHttp, envBool } from "../src/node.ts";
import {
	MCP_MODERN_PROTOCOL_VERSION,
	McpAuthorizationError,
	createHttpRequestReader,
	createMcpAuthGate,
	defineServer,
	defineTool,
	forwardableHeaders,
	httpRequest,
	jsonResult,
	principal,
	requireScopes,
	textContent,
	toolResult,
} from "../src/server.ts";

const expiresAt = Math.floor(Date.now() / 1000) + 3600;
const RESOURCE = "https://rs.example/mcp";

const definition = defineServer(
	{ name: "http-serve", version: "1.0.0" },
	{
		capabilities: [
			defineTool("whoami", {}, async (ctx) =>
				jsonResult({
					...principal(ctx),
					headers: [...(httpRequest(ctx)?.headers.keys() ?? [])],
					redacted: httpRequest(ctx)?.redactedHeaderNames ?? [],
				}),
			),
			defineTool(
				"admin",
				{ auth: { check: requireScopes("admin"), anonymous: "deny" } },
				async () => toolResult(textContent("admin")),
			),
		],
	},
);

function gateFor(verifier: OAuthTokenVerifier) {
	return createMcpAuthGate({
		verifier,
		resourceServerUrl: RESOURCE,
		metadata: {
			oauthMetadata: {
				issuer: "https://as.example",
				authorization_endpoint: "https://as.example/authorize",
				token_endpoint: "https://as.example/token",
				response_types_supported: ["code"],
			},
			scopesSupported: ["mcp"],
		},
	});
}

const verifier = staticTokenVerifier([
	{ token: "good", clientId: "alice", scopes: ["mcp", "admin"], expiresAt, resource: RESOURCE },
	{ token: "reader", clientId: "bob", scopes: ["mcp"], expiresAt },
	{
		token: "foreign",
		clientId: "eve",
		scopes: ["mcp"],
		expiresAt,
		resource: "https://other.example/mcp",
	},
]);

async function serve(t: TestContext, options: Parameters<typeof serveMcpHttp>[1] = {}) {
	const handle = await serveMcpHttp(definition, {
		port: 0,
		auth: gateFor(verifier),
		health: "/healthz",
		...options,
	});
	t.after(() => handle.close());
	return handle;
}

function rpc(id: number, method: string, params: Record<string, unknown> = {}) {
	return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

/** `fetch` (undici) silently drops a caller-supplied `Host` header; raw `node:http` does not. */
function rawPost(url: URL, headers: Record<string, string>, body: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const request = httpRequestRaw(
			url,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					"content-length": String(Buffer.byteLength(body)),
					...headers,
				},
			},
			(response) => {
				response.resume();
				response.on("end", () => resolve(response.statusCode ?? 0));
			},
		);
		request.on("error", reject);
		request.end(body);
	});
}

test("serveMcpHttp pipeline: health, OPTIONS, discovery, host/origin, bearer, MCP", async (t) => {
	const { address } = await serve(t);
	const base = address.url.origin;

	assert.equal((await fetch(`${base}/healthz`)).status, 200);
	assert.equal((await fetch(address.url, { method: "OPTIONS" })).status, 405);
	assert.equal((await fetch(`${base}/nope`)).status, 404);

	const prm = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
	assert.equal(prm.status, 200);
	assert.equal(((await prm.json()) as { resource: string }).resource, RESOURCE);
	assert.equal((await fetch(`${base}/.well-known/oauth-authorization-server`)).status, 200);

	const anonymous = await fetch(address.url, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
		body: rpc(1, "tools/list"),
	});
	assert.equal(anonymous.status, 401);
	const challenge = anonymous.headers.get("www-authenticate") ?? "";
	assert.match(challenge, /invalid_token/);
	assert.match(
		challenge,
		/resource_metadata="https:\/\/rs\.example\/\.well-known\/oauth-protected-resource\/mcp"/,
	);

	for (const [token, status] of [
		["bogus", 401],
		["foreign", 401],
	] as const) {
		const response = await fetch(address.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${token}`,
			},
			body: rpc(1, "tools/list"),
		});
		assert.equal(response.status, status, token);
	}

	assert.equal(
		await rawPost(
			address.url,
			{ host: "evil.example", authorization: "Bearer good" },
			rpc(1, "tools/list"),
		),
		403,
	);
	const badOrigin = await fetch(address.url, {
		method: "POST",
		headers: {
			origin: "https://evil.example",
			"content-type": "application/json",
			authorization: "Bearer good",
		},
		body: rpc(1, "tools/list"),
	});
	assert.equal(badOrigin.status, 403);
});

test("a verifier fault answers 500 and never a challenge; scope failures answer 403", async (t) => {
	const faulty: OAuthTokenVerifier = {
		async verifyAccessToken(token) {
			if (token === "boom") throw new OAuthError(OAuthErrorCode.ServerError, "server_error");
			if (token === "plain") throw new Error("verifier bug");
			return { token, clientId: "c", scopes: ["mcp"], expiresAt };
		},
	};
	const handle = await serveMcpHttp(definition, {
		port: 0,
		auth: createMcpAuthGate({
			verifier: faulty,
			resourceServerUrl: RESOURCE,
			requiredScopes: ["mcp", "admin"],
		}),
	});
	t.after(() => handle.close());
	const post = (token: string) =>
		fetch(handle.address.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${token}`,
			},
			body: rpc(1, "tools/list"),
		});
	assert.equal((await post("boom")).status, 500);
	assert.equal((await post("plain")).status, 500);
	const scoped = await post("ok");
	assert.equal(scoped.status, 403);
	assert.match(scoped.headers.get("www-authenticate") ?? "", /insufficient_scope/);
});

for (const era of ["modern", "legacy"] as const) {
	test(`an authenticated official client works end to end over real sockets [${era}]`, async (t) => {
		const { address } = await serve(t);
		const client = new Client(
			{ name: "sockets", version: "0.0.0" },
			{
				versionNegotiation:
					era === "modern" ? { mode: { pin: MCP_MODERN_PROTOCOL_VERSION } } : { mode: "legacy" },
			},
		);
		const transport = new StreamableHTTPClientTransport(address.url, {
			authProvider: { token: async () => "good" },
			requestInit: { headers: { "x-trace": "abc", cookie: "session=1" } },
		});
		await client.connect(transport);
		try {
			assert.equal(client.getProtocolEra(), era);
			const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
			assert.deepEqual(tools, ["admin", "whoami"]);
			const who = await client.callTool({ name: "whoami", arguments: {} });
			const structured = who.structuredContent as {
				clientId: string;
				scopes: string[];
				headers: string[];
				redacted: string[];
			};
			assert.equal(structured.clientId, "alice");
			assert.deepEqual(structured.scopes, ["mcp", "admin"]);
			assert.ok(structured.headers.includes("x-trace"));
			assert.ok(!structured.headers.includes("authorization"));
			assert.ok(structured.redacted.includes("authorization"));
			assert.ok(structured.redacted.includes("cookie"));
			assert.ok(!("token" in structured));
		} finally {
			await client.close();
		}

		const reader = new Client(
			{ name: "reader", version: "0.0.0" },
			{ versionNegotiation: { mode: "legacy" } },
		);
		await reader.connect(
			new StreamableHTTPClientTransport(address.url, {
				authProvider: { token: async () => "reader" },
			}),
		);
		try {
			assert.deepEqual(
				(await reader.listTools()).tools.map((tool) => tool.name),
				["whoami"],
			);
		} finally {
			await reader.close();
		}
	});
}

test("createNodeMcpHandler with a gate discards a forged req.auth", async (t) => {
	const forged: AuthInfo = { token: "forged", clientId: "mallory", scopes: ["admin"], expiresAt };
	const gated = createNodeMcpHandler(definition, { auth: gateFor(verifier) });
	const ungated = createNodeMcpHandler(definition);
	t.after(async () => {
		await gated.close();
		await ungated.close();
	});
	const server = createServer((request, response) => {
		Object.assign(request, { auth: forged });
		void (request.url === "/gated" ? gated(request, response) : ungated(request, response));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);
	const port = (server.address() as { port: number }).port;
	const post = (path: string, token?: string) =>
		fetch(`http://127.0.0.1:${port}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
				"mcp-protocol-version": MCP_MODERN_PROTOCOL_VERSION,
				"mcp-method": "tools/list",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/list",
				params: {
					_meta: {
						"io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
						"io.modelcontextprotocol/clientInfo": { name: "raw", version: "0" },
						"io.modelcontextprotocol/clientCapabilities": {},
					},
				},
			}),
		});
	assert.equal((await post("/gated")).status, 401);
	const reader = await post("/gated", "reader");
	assert.equal(reader.status, 200);
	const readerTools = (
		(await reader.json()) as { result: { tools: { name: string }[] } }
	).result.tools.map((tool) => tool.name);
	assert.deepEqual(readerTools, ["whoami"], "the forged admin identity did not survive the gate");
	const passthrough = await post("/ungated");
	assert.equal(passthrough.status, 200);
	const forgedTools = (
		(await passthrough.json()) as { result: { tools: { name: string }[] } }
	).result.tools
		.map((tool) => tool.name)
		.sort();
	assert.deepEqual(
		forgedTools,
		["admin", "whoami"],
		"without a gate req.auth passes through (documented)",
	);
});

test("serveMcpHttp refuses unsafe routable binds and unserveable definitions", async () => {
	await assert.rejects(
		serveMcpHttp(definition, { port: 0 }),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.CAPABILITY_AUTH_UNSERVEABLE,
	);
	const open = defineServer(
		{ name: "open", version: "1.0.0" },
		{ capabilities: [defineTool("t", {}, async () => toolResult())] },
	);
	await assert.rejects(
		serveMcpHttp(open, { host: "0.0.0.0", port: 0 }),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
	await assert.rejects(
		serveMcpHttp(open, { host: "0.0.0.0", port: 0, allowUnauthenticated: true }),
		/dnsRebinding\.hosts/,
	);
	const handle = await serveMcpHttp(open, {
		host: "0.0.0.0",
		port: 0,
		allowUnauthenticated: true,
		dnsRebinding: { hosts: ["api.example"] },
	});
	try {
		const url = new URL(`http://127.0.0.1:${handle.address.port}/mcp`);
		assert.notEqual(await rawPost(url, { host: "api.example" }, rpc(1, "tools/list")), 403);
		assert.equal(await rawPost(url, { host: "other.example" }, rpc(1, "tools/list")), 403);
	} finally {
		await handle.close();
	}
});

test("trusted-proxy request verifier requires provenance and maps 401/403", async (t) => {
	const gate = createMcpAuthGate({
		resourceServerUrl: RESOURCE,
		requestVerifier: {
			trustedProxy: { header: "x-proxy-secret", secret: "s3cret" },
			async verifyRequest(request) {
				const user = request.headers.get("x-user");
				if (user === null) throw new Error("no user");
				if (user === "banned") throw new McpAuthorizationError("banned");
				return { token: `proxy:${user}`, clientId: user, scopes: ["mcp"], expiresAt };
			},
		},
	});
	const handle = await serveMcpHttp(definition, { port: 0, auth: gate });
	t.after(() => handle.close());
	const post = (headers: Record<string, string>) =>
		fetch(handle.address.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...headers,
			},
			body: rpc(1, "tools/list"),
		});
	assert.equal((await post({ "x-user": "alice" })).status, 401, "no provenance");
	assert.equal((await post({ "x-proxy-secret": "wrong", "x-user": "alice" })).status, 401);
	assert.equal(
		(await post({ "x-proxy-secret": "s3cret" })).status,
		401,
		"verifier threw plain error",
	);
	assert.equal((await post({ "x-proxy-secret": "s3cret", "x-user": "banned" })).status, 403);
	assert.equal((await post({ "x-proxy-secret": "s3cret", "x-user": "alice" })).status, 200);
});

test("http context helpers", () => {
	const headers = new Headers({
		authorization: "Bearer x",
		cookie: "a=b",
		connection: "keep-alive",
		host: "rs.example",
		"content-type": "application/json",
		"mcp-method": "tools/call",
		"x-request-id": "r1",
		traceparent: "00-1-2-01",
	});
	const forwarded = forwardableHeaders(headers);
	assert.deepEqual([...forwarded.keys()].sort(), ["traceparent", "x-request-id"]);
	assert.equal(
		forwardableHeaders(headers, { include: ["authorization"] }).get("authorization"),
		"Bearer x",
	);
	const reader = createHttpRequestReader({
		redactHeaders: ["x-request-id"],
		exposeHeaders: ["cookie"],
	});
	const view = reader({
		mcpReq: {},
		http: { req: new Request("http://h/mcp?x=1", { headers }) },
	} as never);
	assert.deepEqual(view?.redactedHeaderNames, ["authorization", "x-request-id"]);
	assert.equal(view?.headers.get("cookie"), "a=b");
	assert.equal(view?.url, "/mcp?x=1");
	assert.equal(reader({ mcpReq: {} } as never), undefined);
	assert.deepEqual(mcpHttpEnvOptions({ MCP_HOST: "0.0.0.0", PORT: "8080", MCP_PATH: "/api/mcp" }), {
		host: "0.0.0.0",
		port: 8080,
		path: "/api/mcp",
	});
	assert.throws(() => mcpHttpEnvOptions({ MCP_PORT: "abc" }), RangeError);
	assert.equal(envBool("X", { X: "yes" }), true);
	assert.equal(envBool("X", { X: "off" }), false);
	assert.equal(envBool("X", {}), undefined);
	assert.throws(() => envBool("X", { X: "maybe" }), RangeError);
});
