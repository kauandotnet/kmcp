import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { TestContext } from "node:test";

import { UnauthorizedError } from "@modelcontextprotocol/client";
import {
	OAuthError,
	OAuthErrorCode,
	bearerAuthChallengeResponse,
	getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/server";

import { staticTokenVerifier } from "../src/auth.ts";
import {
	InMemoryKeyValueStore,
	McpConnectionManager,
	McpOAuthClientProvider,
	httpConnection,
	type McpConnectionEvent,
} from "../src/client.ts";
import { KMCP_ERROR_CODES, KmcpError } from "../src/errors.ts";
import { serveMcpHttp } from "../src/node.ts";
import {
	createMcpAuthGate,
	defineServer,
	defineTool,
	jsonResult,
	principal,
	type McpAuthGate,
} from "../src/server.ts";
import { forEachEra } from "./helpers/in-process.ts";

/** Reserves a free loopback port (bind, read, close). */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createNetServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => resolve(body));
		request.on("error", reject);
	});
}

interface FakeAuthorizationServer {
	readonly url: string;
	readonly registrations: number;
	readonly authorizations: string[];
	readonly tokenRequests: URLSearchParams[];
	close(): Promise<void>;
}

/**
 * The smallest authorization server the SDK's `auth()` accepts: RFC 8414 metadata, RFC 7591
 * registration, an `/authorize` that redirects straight back with a code, and a `/token` that
 * grants `admin-token` when `admin` was requested and `reader` otherwise.
 */
async function startAuthorizationServer(t: TestContext): Promise<FakeAuthorizationServer> {
	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;
	const state = {
		registrations: 0,
		authorizations: [] as string[],
		tokenRequests: [] as URLSearchParams[],
	};
	let lastScope = "";
	const server: Server = createServer(async (request, response) => {
		const target = new URL(request.url ?? "/", url);
		const json = (status: number, body: unknown) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		};
		if (request.method === "GET" && target.pathname === "/.well-known/oauth-authorization-server") {
			json(200, {
				issuer: url,
				authorization_endpoint: `${url}/authorize`,
				token_endpoint: `${url}/token`,
				registration_endpoint: `${url}/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: [
					"none",
					"client_secret_post",
					"client_secret_basic",
				],
				scopes_supported: ["mcp", "admin"],
			});
			return;
		}
		if (request.method === "POST" && target.pathname === "/register") {
			state.registrations += 1;
			const submitted = JSON.parse(await readBody(request)) as Record<string, unknown>;
			json(201, {
				client_id: "dyn-client",
				redirect_uris: submitted.redirect_uris ?? [],
				client_name: submitted.client_name,
				token_endpoint_auth_method: "none",
			});
			return;
		}
		if (request.method === "GET" && target.pathname === "/authorize") {
			lastScope = target.searchParams.get("scope") ?? "";
			state.authorizations.push(lastScope);
			const redirect = new URL(target.searchParams.get("redirect_uri") ?? "");
			redirect.searchParams.set("code", `code-${state.authorizations.length}`);
			const stateParam = target.searchParams.get("state");
			if (stateParam !== null) redirect.searchParams.set("state", stateParam);
			response.writeHead(302, { location: redirect.href });
			response.end();
			return;
		}
		if (request.method === "POST" && target.pathname === "/token") {
			const params = new URLSearchParams(await readBody(request));
			state.tokenRequests.push(params);
			const admin = lastScope.split(" ").includes("admin");
			json(200, {
				access_token: admin ? "admin-token" : "reader",
				token_type: "Bearer",
				expires_in: 3600,
				refresh_token: "rt-1",
				scope: admin ? "mcp admin" : "mcp",
			});
			return;
		}
		json(404, { error: "not_found" });
	});
	await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
	const close = () =>
		new Promise<void>((resolve) => {
			server.closeAllConnections();
			server.close(() => resolve());
		});
	t.after(close);
	return {
		url,
		get registrations() {
			return state.registrations;
		},
		get authorizations() {
			return state.authorizations;
		},
		get tokenRequests() {
			return state.tokenRequests;
		},
		close,
	};
}

/** The JSON-RPC method of a request, without consuming the body the handler still needs. */
async function peekMethod(request: Request): Promise<string | undefined> {
	if (request.method !== "POST") return undefined;
	try {
		const parsed: unknown = JSON.parse(await request.clone().text());
		return typeof parsed === "object" && parsed !== null && "method" in parsed
			? String((parsed as { method: unknown }).method)
			: undefined;
	} catch {
		return undefined;
	}
}

forEachEra(
	"kmcp client authorizes against kmcp server: discovery, registration, step-up",
	async (era, t) => {
		const authorizationServer = await startAuthorizationServer(t);
		const mcpPort = await freePort();
		const resource = `http://127.0.0.1:${mcpPort}/mcp`;
		const expiresAt = Math.floor(Date.now() / 1000) + 3600;
		const base = createMcpAuthGate({
			verifier: staticTokenVerifier([
				{ token: "reader", clientId: "dyn-client", scopes: ["mcp"], expiresAt, resource },
				{
					token: "admin-token",
					clientId: "dyn-client",
					scopes: ["mcp", "admin"],
					expiresAt,
					resource,
				},
			]),
			resourceServerUrl: resource,
			requiredScopes: ["mcp"],
			metadata: {
				oauthMetadata: {
					issuer: authorizationServer.url,
					authorization_endpoint: `${authorizationServer.url}/authorize`,
					token_endpoint: `${authorizationServer.url}/token`,
					response_types_supported: ["code"],
				},
				scopesSupported: ["mcp"],
				dangerouslyAllowInsecureIssuerUrl: true,
			},
		});
		const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(resource));
		// `tools/call` needs `admin` on top of the server-wide `mcp`: the shape of a per-operation
		// scope requirement, answered with the 403 challenge the SDK client escalates from.
		const gate: McpAuthGate = async (request) => {
			const verdict = await base(request);
			if (verdict instanceof Response) return verdict;
			if ((await peekMethod(request)) === "tools/call" && !verdict.scopes.includes("admin")) {
				return bearerAuthChallengeResponse(
					new OAuthError(OAuthErrorCode.InsufficientScope, "insufficient_scope"),
					{ requiredScopes: ["mcp", "admin"], resourceMetadataUrl },
				);
			}
			return verdict;
		};
		const definition = defineServer(
			{ name: "oauth-e2e", version: "1.0.0" },
			{
				capabilities: [defineTool("whoami", {}, async (ctx) => jsonResult({ ...principal(ctx) }))],
			},
		);
		const handle = await serveMcpHttp(definition, { port: mcpPort, path: "/mcp", auth: gate });
		t.after(() => handle.close());
		assert.equal(handle.address.url.href, resource);

		let pendingAuthorization: URL | undefined;
		const store = new InMemoryKeyValueStore();
		const provider = new McpOAuthClientProvider({
			serverUrl: resource,
			redirectUrl: "http://127.0.0.1:53019/callback",
			clientName: "kmcp-e2e",
			store,
			onRedirect: (url) => {
				pendingAuthorization = url;
			},
		});
		const manager = new McpConnectionManager<"s">();
		t.after(() => manager.close());
		const events: McpConnectionEvent<"s">[] = [];
		manager.subscribe((event) => {
			events.push(event);
		});
		manager.register(
			httpConnection({
				id: "s",
				url: resource,
				auth: provider,
				protocolVersion: era === "modern" ? "2026-07-28" : "2025-11-25",
				defaults: { timeoutMs: 5000 },
			}),
		);
		const completeRedirect = async () => {
			assert.ok(pendingAuthorization, "the provider was handed an authorization URL");
			const url = pendingAuthorization;
			pendingAuthorization = undefined;
			const response = await fetch(url, { redirect: "manual" });
			const location = response.headers.get("location");
			assert.ok(location, "the authorization server redirected back");
			return manager.completeAuthorization("s", new URL(location, url).searchParams);
		};

		// 1. The first connect is refused with 401; discovery ran through the gate's documents.
		await assert.rejects(
			manager.connect("s"),
			(error: unknown) =>
				error instanceof KmcpError && error.code === KMCP_ERROR_CODES.CONNECTION_AUTHORIZING,
		);
		assert.equal(manager.state("s").phase, "authorizing");
		assert.equal(authorizationServer.registrations, 1, "dynamic client registration ran once");
		assert.equal(
			pendingAuthorization?.searchParams.get("scope"),
			"mcp",
			"the server-wide scope was requested",
		);
		assert.ok(pendingAuthorization?.searchParams.get("state"), "kmcp attached an OAuth state");

		// 2. Completing the round reconnects with the reader token.
		const online = await completeRedirect();
		assert.equal(online.phase, "online");
		assert.equal(online.protocolEra, era);
		assert.deepEqual(authorizationServer.authorizations, ["mcp"]);
		assert.equal(authorizationServer.tokenRequests.length, 1);
		assert.equal(
			authorizationServer.tokenRequests[0]?.get("resource"),
			resource,
			"the RFC 8707 resource indicator names the kmcp server",
		);
		assert.ok(authorizationServer.tokenRequests[0]?.get("code_verifier"), "PKCE verifier sent");
		const listed = await manager.listTools("s");
		assert.equal(listed.tools[0]?.name, "whoami");

		// 3. tools/call needs `admin`: the gate answers 403, the SDK escalates, kmcp announces it.
		await assert.rejects(
			manager.callTool("s", "whoami", {}),
			(error: unknown) => error instanceof UnauthorizedError,
		);
		assert.equal(manager.state("s").phase, "online", "a step-up never leaves the online phase");
		assert.ok(events.some((event) => event.type === "connection.authorization.required"));
		assert.equal(
			pendingAuthorization?.searchParams.get("scope"),
			"mcp admin",
			"the union scope was requested",
		);

		// 4. Finishing the round on the live transport widens the token; the retried call succeeds.
		const stillOnline = await completeRedirect();
		assert.equal(stillOnline.phase, "online");
		assert.deepEqual(authorizationServer.authorizations, ["mcp", "mcp admin"]);
		assert.equal(stillOnline.generation, online.generation, "nothing was reconnected");
		const result = await manager.callTool("s", "whoami", {});
		const who = result.structuredContent as { clientId?: string; scopes?: string[] } | undefined;
		assert.equal(who?.clientId, "dyn-client");
		assert.ok(who?.scopes?.includes("admin"));
		assert.equal(authorizationServer.tokenRequests.length, 2);

		const status = await provider.status();
		assert.equal(status.clientId, "dyn-client");
		assert.equal(status.scope, "mcp admin");
		assert.equal(status.hasRefreshToken, true);
		assert.ok(status.issuer?.startsWith(authorizationServer.url));
	},
);
