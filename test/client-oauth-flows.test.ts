import assert from "node:assert/strict";
import test from "node:test";

import {
	type FetchLike,
	IssuerMismatchError,
	OAuthError,
	OAuthErrorCode,
	RegistrationRejectedError,
	SdkErrorCode,
	SdkHttpError,
	UnauthorizedError,
} from "@modelcontextprotocol/client";

import {
	InMemoryKeyValueStore,
	KMCP_ERROR_CODES,
	KmcpError,
	McpOAuthClientProvider,
	authorizeEnterpriseIdp,
	authorizeOAuth,
	clientCredentialsAuth,
	decodeJwtClaims,
	describeError,
	enterpriseManagedAuth,
	explainOAuthError,
	jwtExpiresAt,
	oauthGrantOf,
	oauthServerUrl,
	pinnedDiscoveryState,
	refreshIdpTokens,
	validateOAuthCredentials,
	type McpIdpTokens,
} from "../src/index.ts";

const SERVER_URL = "https://mcp.example.com/mcp";
const AS = "https://as.example.com";
const IDP = "https://idp.example.com";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function unsignedJwt(claims: Record<string, unknown>): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.sig`;
}

interface FakeAuthorizationServer {
	readonly fetch: FetchLike;
	readonly calls: { method: string; url: string; body: URLSearchParams | undefined }[];
	registrations: number;
	refreshes: number;
	nonceSeen: string | undefined;
}

/** A mock fetch standing in for the MCP server's discovery documents, an authorization server, and an enterprise IdP. */
function fakeAuthorizationServer(
	options: { idTokenNonce?: () => string | undefined } = {},
): FakeAuthorizationServer {
	const calls: FakeAuthorizationServer["calls"] = [];
	const state: FakeAuthorizationServer = {
		calls,
		registrations: 0,
		refreshes: 0,
		nonceSeen: undefined,
		fetch: async (input, init) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			const body =
				init?.body instanceof URLSearchParams
					? init.body
					: typeof init?.body === "string" && !init.body.startsWith("{")
						? new URLSearchParams(init.body)
						: undefined;
			calls.push({ method, url, body });
			if (url.startsWith("https://mcp.example.com/.well-known/oauth-protected-resource")) {
				return json({
					resource: SERVER_URL,
					authorization_servers: [AS],
					scopes_supported: ["mcp"],
				});
			}
			if (url === `${AS}/.well-known/oauth-authorization-server`) {
				return json({
					issuer: AS,
					authorization_endpoint: `${AS}/authorize`,
					token_endpoint: `${AS}/token`,
					registration_endpoint: `${AS}/register`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: [
						"none",
						"client_secret_post",
						"client_secret_basic",
					],
					authorization_grant_profiles_supported: ["urn:ietf:params:oauth:grant-profile:id-jag"],
				});
			}
			if (url === `${AS}/register` && method === "POST") {
				state.registrations += 1;
				const submitted = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return json({ ...submitted, client_id: "dyn-client" }, 201);
			}
			if (url === `${AS}/token` && method === "POST") {
				const grant = body?.get("grant_type");
				if (grant === "authorization_code") {
					return json({
						access_token: "at-1",
						token_type: "Bearer",
						expires_in: 3600,
						refresh_token: "rt-1",
						scope: "mcp",
						id_token: unsignedJwt({ sub: "user-1", email: "u@example.com", name: "User One" }),
					});
				}
				if (grant === "refresh_token") {
					state.refreshes += 1;
					return json({
						access_token: `at-${state.refreshes + 1}`,
						token_type: "Bearer",
						expires_in: 3600,
						scope: "mcp",
					});
				}
				if (grant === "client_credentials") {
					return json({
						access_token: "cc-1",
						token_type: "Bearer",
						scope: "m2m",
						expires_in: 600,
					});
				}
				if (grant === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
					return json({ access_token: "ent-1", token_type: "Bearer", scope: "ent" });
				}
				return json({ error: "unsupported_grant_type" }, 400);
			}
			if (url === `${IDP}/.well-known/oauth-authorization-server`) {
				return json({
					issuer: IDP,
					authorization_endpoint: `${IDP}/authorize`,
					token_endpoint: `${IDP}/token`,
					response_types_supported: ["code"],
				});
			}
			if (url === `${IDP}/token` && method === "POST") {
				const grant = body?.get("grant_type");
				if (grant === "urn:ietf:params:oauth:grant-type:token-exchange") {
					return json({
						issued_token_type: "urn:ietf:params:oauth:token-type:id-jag",
						access_token: "jag-1",
						token_type: "N_A",
						expires_in: 300,
					});
				}
				if (grant === "refresh_token") {
					return json({
						id_token: unsignedJwt({ sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600 }),
						refresh_token: "idp-rt-2",
					});
				}
				if (grant === "authorization_code") {
					const nonce = options.idTokenNonce?.();
					state.nonceSeen = nonce;
					return json({
						id_token: unsignedJwt({
							sub: "user-1",
							email: "u@example.com",
							exp: Math.floor(Date.now() / 1000) + 3600,
							...(nonce === undefined ? {} : { nonce }),
						}),
						refresh_token: "idp-rt-1",
					});
				}
			}
			return new Response("not found", { status: 404 });
		},
	};
	return state;
}

test("authorizeOAuth runs discovery, registration, the redirect leg and the exchange, verifying state", async () => {
	const server = fakeAuthorizationServer();
	let authorizationUrl: URL | undefined;
	const store = new InMemoryKeyValueStore();
	const provider = new McpOAuthClientProvider({
		serverUrl: SERVER_URL,
		redirectUrl: "http://127.0.0.1:1/callback",
		store,
		fetch: server.fetch,
		onRedirect: (url) => {
			authorizationUrl = url;
		},
	});
	const result = await authorizeOAuth(provider, {
		serverUrl: `${SERVER_URL}?tools=a,b`,
		fetch: server.fetch,
		waitForCallback: async () => {
			assert.ok(authorizationUrl);
			const state = authorizationUrl.searchParams.get("state");
			assert.ok(state, "the SDK asked the provider for a state parameter");
			assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
			return new URLSearchParams({ code: "code-1", state, iss: AS });
		},
	});
	assert.equal(result.redirected, true);
	assert.equal(result.tokens?.access_token, "at-1");
	assert.equal(server.registrations, 1);
	assert.ok(
		server.calls.every((call) => !call.url.includes("tools=")),
		"the query string never reaches discovery",
	);
	const status = await provider.status();
	assert.equal(status.hasTokens, true);
	assert.equal(status.hasRefreshToken, true);
	assert.equal(status.clientId, "dyn-client");
	assert.equal(status.issuer, AS);
	assert.equal(status.scope, "mcp");
	assert.ok(status.expiresAt);
	assert.deepEqual(status.identity, {
		subject: "user-1",
		email: "u@example.com",
		name: "User One",
	});
	// A second run refreshes instead of redirecting.
	const again = await authorizeOAuth(provider, { serverUrl: SERVER_URL, fetch: server.fetch });
	assert.equal(again.redirected, false);
});

test("a callback with the wrong state or an error is refused before any exchange", async () => {
	const server = fakeAuthorizationServer();
	const provider = new McpOAuthClientProvider({
		serverUrl: SERVER_URL,
		redirectUrl: "http://127.0.0.1:1/callback",
		fetch: server.fetch,
		onRedirect: () => undefined,
	});
	await assert.rejects(
		authorizeOAuth(provider, {
			serverUrl: SERVER_URL,
			fetch: server.fetch,
			waitForCallback: async () => new URLSearchParams({ code: "code-1", state: "forged" }),
		}),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.AUTH_STATE_MISMATCH,
	);
	assert.equal(
		server.calls.filter((call) => call.body?.get("grant_type") === "authorization_code").length,
		0,
	);
	await assert.rejects(
		authorizeOAuth(provider, {
			serverUrl: SERVER_URL,
			fetch: server.fetch,
			waitForCallback: async () =>
				new URLSearchParams({ error: "access_denied", error_description: "nope" }),
		}),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.AUTH_FORBIDDEN,
	);
});

test("the provider refreshes an expiring access token ahead of time, single-flight", async () => {
	const server = fakeAuthorizationServer();
	let now = Date.UTC(2026, 0, 1);
	const provider = new McpOAuthClientProvider({
		serverUrl: SERVER_URL,
		redirectUrl: "http://127.0.0.1:1/callback",
		clientId: "static-client",
		expectedIssuer: AS,
		fetch: server.fetch,
		now: () => now,
		onRedirect: () => undefined,
	});
	await provider.saveDiscoveryState({
		authorizationServerUrl: AS,
		authorizationServerMetadata: {
			issuer: AS,
			authorization_endpoint: `${AS}/authorize`,
			token_endpoint: `${AS}/token`,
			response_types_supported: ["code"],
		},
	});
	await provider.saveTokens(
		{
			access_token: "at-1",
			token_type: "Bearer",
			expires_in: 3600,
			refresh_token: "rt-1",
			issuer: AS,
		},
		{ issuer: AS },
	);
	assert.equal((await provider.tokens())?.access_token, "at-1");
	assert.equal(server.refreshes, 0);
	now += 3600_000 - 30_000;
	const [first, second] = await Promise.all([provider.tokens(), provider.tokens()]);
	assert.equal(first?.access_token, "at-2");
	assert.equal(second?.access_token, "at-2");
	assert.equal(server.refreshes, 1, "concurrent reads share one refresh");
	assert.equal(first?.refresh_token, "rt-1", "a non-rotating server keeps the refresh token");
	assert.ok((first as { expires_at?: number })?.expires_at);
	// A later read inside the new lifetime does not refresh again.
	assert.equal((await provider.tokens())?.access_token, "at-2");
	assert.equal(server.refreshes, 1);
});

test("a failed proactive refresh returns the stale token and reports the error", async () => {
	const errors: unknown[] = [];
	let now = Date.UTC(2026, 0, 1);
	const provider = new McpOAuthClientProvider({
		serverUrl: SERVER_URL,
		redirectUrl: "http://127.0.0.1:1/callback",
		clientId: "static-client",
		fetch: async () => new Response("down", { status: 503 }),
		now: () => now,
		refresh: { bufferMs: 120_000, onError: (error) => errors.push(error) },
		onRedirect: () => undefined,
	});
	await provider.saveDiscoveryState({
		authorizationServerUrl: AS,
		authorizationServerMetadata: {
			issuer: AS,
			authorization_endpoint: `${AS}/authorize`,
			token_endpoint: `${AS}/token`,
			response_types_supported: ["code"],
		},
	});
	await provider.saveTokens({
		access_token: "old",
		token_type: "Bearer",
		expires_in: 60,
		refresh_token: "rt",
	});
	now += 1000;
	assert.equal((await provider.tokens())?.access_token, "old");
	assert.equal(errors.length, 1);
	const off = new McpOAuthClientProvider({
		serverUrl: SERVER_URL,
		redirectUrl: "http://127.0.0.1:1/callback",
		refresh: false,
		onRedirect: () => undefined,
	});
	await off.saveTokens({
		access_token: "x",
		token_type: "Bearer",
		expires_in: 0,
		refresh_token: "r",
	});
	assert.equal((await off.tokens())?.access_token, "x");
});

test("client-credentials providers validate through auth() with discovery or a pinned endpoint", async () => {
	const server = fakeAuthorizationServer();
	const discovered = clientCredentialsAuth({
		clientId: "m2m",
		clientSecret: "secret",
		scope: ["a", "b"],
	});
	assert.equal(oauthGrantOf(discovered), "client_credentials");
	const validated = await validateOAuthCredentials(discovered, `${SERVER_URL}#frag`, {
		fetch: server.fetch,
	});
	assert.equal(validated.scope, "m2m");
	assert.equal(validated.tokenType, "Bearer");
	assert.equal(validated.expiresIn, 600);
	assert.equal(validated.authorizationServerUrl, AS);
	const pinned = clientCredentialsAuth({
		clientId: "m2m",
		clientSecret: "secret",
		tokenEndpoint: `${AS}/token`,
	});
	const before = server.calls.length;
	const viaPin = await validateOAuthCredentials(pinned, SERVER_URL, { fetch: server.fetch });
	assert.equal(viaPin.scope, "m2m");
	assert.ok(
		!server.calls.slice(before).some((call) => call.url.includes("oauth-authorization-server")),
		"a pinned token endpoint skips authorization-server discovery",
	);
	assert.throws(
		() => clientCredentialsAuth({ clientId: "k", privateKey: "-----BEGIN", algorithm: "HS256" }),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
	const interactive = new McpOAuthClientProvider({
		serverUrl: SERVER_URL,
		redirectUrl: "http://127.0.0.1:1/callback",
		onRedirect: () => undefined,
	});
	await assert.rejects(validateOAuthCredentials(interactive, SERVER_URL));
});

test("enterpriseManagedAuth refreshes the IdP ID token and exchanges it for an MCP access token", async () => {
	const server = fakeAuthorizationServer();
	const refreshed: McpIdpTokens[] = [];
	const expired = unsignedJwt({ sub: "user-1", exp: Math.floor(Date.now() / 1000) - 10 });
	const provider = enterpriseManagedAuth({
		idp: {
			tokenEndpoint: `${IDP}/token`,
			clientId: "idp-client",
			clientSecret: "idp-secret",
			tokens: { idToken: expired, refreshToken: "idp-rt-1" },
		},
		client: { clientId: "ent-client", clientSecret: "ent-secret" },
		scope: "ent",
		fetch: server.fetch,
		onIdpTokensRefreshed: async (tokens) => {
			refreshed.push(tokens);
		},
	});
	assert.equal(oauthGrantOf(provider), "jwt_bearer");
	const validated = await validateOAuthCredentials(provider, SERVER_URL, { fetch: server.fetch });
	assert.equal(validated.scope, "ent");
	assert.equal(refreshed.length, 1);
	assert.equal(refreshed[0]?.refreshToken, "idp-rt-2");
	assert.ok(refreshed[0]?.idTokenExpiresAt);
	const exchange = server.calls.find(
		(call) => call.body?.get("grant_type") === "urn:ietf:params:oauth:grant-type:token-exchange",
	);
	assert.ok(exchange, "an ID-JAG was requested from the IdP");
	assert.equal(exchange.body?.get("audience"), AS);
	assert.ok(
		server.calls.some(
			(call) => call.body?.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer",
		),
	);
	assert.throws(
		() =>
			enterpriseManagedAuth({
				idp: { clientId: "x", tokens: { idToken: expired } },
				client: { clientId: "c", clientSecret: "s" },
			}),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
});

test("authorizeEnterpriseIdp runs the PKCE sign-in at the IdP and checks state and nonce", async () => {
	let authorization: URL | undefined;
	const server = fakeAuthorizationServer({
		idTokenNonce: () => authorization?.searchParams.get("nonce") ?? undefined,
	});
	const result = await authorizeEnterpriseIdp({
		issuer: IDP,
		clientId: "idp-client",
		redirectUrl: "http://127.0.0.1:1/callback",
		fetch: server.fetch,
		onRedirect: (url) => {
			authorization = url;
		},
		waitForCallback: async () => {
			assert.ok(authorization);
			assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
			assert.equal(authorization.searchParams.get("scope"), "openid profile email offline_access");
			return new URLSearchParams({
				code: "idp-code",
				state: authorization.searchParams.get("state") ?? "",
			});
		},
	});
	assert.equal(result.tokenEndpoint, `${IDP}/token`);
	assert.equal(result.tokens.refreshToken, "idp-rt-1");
	assert.equal(result.claims.email, "u@example.com");
	assert.equal(jwtExpiresAt(result.tokens.idToken), result.tokens.idTokenExpiresAt);
	const exchange = server.calls.find(
		(call) => call.body?.get("grant_type") === "authorization_code",
	);
	assert.ok(exchange?.body?.get("code_verifier"));

	await assert.rejects(
		authorizeEnterpriseIdp({
			issuer: IDP,
			clientId: "idp-client",
			redirectUrl: "http://127.0.0.1:1/callback",
			fetch: server.fetch,
			onRedirect: () => undefined,
			waitForCallback: async () => new URLSearchParams({ code: "idp-code", state: "wrong" }),
		}),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.AUTH_STATE_MISMATCH,
	);
});

test("explainOAuthError and describeError classify the SDK's OAuth flow errors", () => {
	const rejected = new RegistrationRejectedError({
		status: 403,
		body: "Forbidden",
		submittedMetadata: { redirect_uris: [] },
	});
	assert.equal(explainOAuthError(rejected).kind, "registration_rejected");
	assert.equal(explainOAuthError(rejected).httpStatus, 403);
	assert.ok(explainOAuthError(rejected).remediation?.includes("clientId"));
	assert.deepEqual(describeError(rejected), {
		kind: "oauth",
		code: "registration_rejected",
		httpStatus: 403,
	});

	const wrapped = new KmcpError(KMCP_ERROR_CODES.CONNECTION_CONNECT_FAILED, "wrapped", {
		cause: new OAuthError(OAuthErrorCode.InvalidClient, "bad client"),
	});
	assert.equal(explainOAuthError(wrapped).kind, "client_rejected");
	assert.equal(explainOAuthError(wrapped).oauthCode, "invalid_client");
	assert.deepEqual(describeError(wrapped), { kind: "oauth", code: "invalid_client" });

	const mismatch = new IssuerMismatchError("authorization_response", AS, "https://evil.example");
	const explained = explainOAuthError(mismatch);
	assert.equal(explained.kind, "issuer_mismatch");
	assert.ok(!explained.message.includes("evil"), "attacker-controlled issuer is never echoed");
	assert.equal(explainOAuthError(new UnauthorizedError("no")).kind, "unauthorized");
	assert.equal(
		explainOAuthError(new SdkHttpError(SdkErrorCode.ClientHttpForbidden, "x", { status: 500 }))
			.httpStatus,
		500,
	);
	assert.equal(
		explainOAuthError(new Error("does not support dynamic client registration")).kind,
		"registration_unsupported",
	);
	assert.equal(explainOAuthError("weird").kind, "unknown");
	assert.equal(explainOAuthError(new Error("x".repeat(1000))).message.length, 401);
});

test("JWT helpers decode without verifying and reject malformed input", () => {
	const jwt = unsignedJwt({ sub: "s", exp: 123 });
	assert.deepEqual(decodeJwtClaims(jwt), { sub: "s", exp: 123 });
	assert.equal(jwtExpiresAt(jwt), 123);
	assert.equal(decodeJwtClaims("not-a-jwt"), undefined);
	assert.equal(decodeJwtClaims("a.b.c"), undefined);
	assert.equal(oauthServerUrl("https://mcp.example.com/mcp?x=1#y"), "https://mcp.example.com/mcp");
});

test("state verification fails closed: no pending state, a consumed state, and a non-consuming match", async () => {
	const store = new InMemoryKeyValueStore();
	const provider = new McpOAuthClientProvider({
		serverUrl: SERVER_URL,
		redirectUrl: "http://127.0.0.1:1/callback",
		store,
		onRedirect: () => undefined,
	});
	await assert.rejects(
		provider.verifyCallbackState(new URLSearchParams({ code: "x" })),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.AUTH_STATE_MISMATCH,
	);
	const state = await provider.state();
	assert.equal(await provider.matchesIssuedState(new URLSearchParams({ state })), true);
	assert.equal(await provider.matchesIssuedState(new URLSearchParams({ state: "other" })), false);
	assert.equal(await provider.matchesIssuedState(new URLSearchParams()), false);
	await provider.verifyCallbackState(new URLSearchParams({ state }));
	// One-time use: the same state cannot be presented twice.
	await assert.rejects(
		provider.verifyCallbackState(new URLSearchParams({ state })),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.AUTH_STATE_MISMATCH,
	);
	const off = new McpOAuthClientProvider({
		serverUrl: SERVER_URL,
		redirectUrl: "http://127.0.0.1:1/callback",
		state: false,
		onRedirect: () => undefined,
	});
	await off.verifyCallbackState(new URLSearchParams({ code: "x" }));
	assert.equal(await off.matchesIssuedState(new URLSearchParams()), true);
});

test("a successful authorization discards the PKCE verifier and state", async () => {
	const server = fakeAuthorizationServer();
	const store = new InMemoryKeyValueStore();
	let authorizationUrl: URL | undefined;
	const provider = new McpOAuthClientProvider({
		serverUrl: SERVER_URL,
		redirectUrl: "http://127.0.0.1:1/callback",
		store,
		fetch: server.fetch,
		onRedirect: (url) => {
			authorizationUrl = url;
		},
	});
	await authorizeOAuth(provider, {
		serverUrl: SERVER_URL,
		fetch: server.fetch,
		waitForCallback: async () =>
			new URLSearchParams({
				code: "code-1",
				state: authorizationUrl?.searchParams.get("state") ?? "",
				iss: AS,
			}),
	});
	assert.equal(await store.get(`${SERVER_URL}/code_verifier`), undefined);
	assert.equal(await store.get(`${SERVER_URL}/state`), undefined);
	assert.ok(await store.get(`${AS}/tokens`));
});

test("invalidating tokens clears every issuer ever written and fences an in-flight refresh", async () => {
	const store = new InMemoryKeyValueStore();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let now = Date.UTC(2026, 0, 1);
	const provider = new McpOAuthClientProvider({
		serverUrl: SERVER_URL,
		redirectUrl: "http://127.0.0.1:1/callback",
		clientId: "static-client",
		store,
		now: () => now,
		fetch: async () => {
			await gate;
			return new Response(
				JSON.stringify({ access_token: "late", token_type: "Bearer", expires_in: 3600 }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		},
		onRedirect: () => undefined,
	});
	const first = { issuer: "https://as-one.example.com" };
	const second = { issuer: "https://as-two.example.com" };
	await provider.saveTokens(
		{ access_token: "a", token_type: "Bearer", refresh_token: "ra" },
		first,
	);
	await provider.saveTokens(
		{ access_token: "b", token_type: "Bearer", refresh_token: "rb" },
		second,
	);
	await provider.invalidateCredentials("tokens");
	assert.equal(await provider.tokens(first), undefined, "the earlier issuer's tokens are gone too");
	assert.equal(await provider.tokens(second), undefined);

	// A refresh that started before an invalidation must not re-persist what was dropped.
	await provider.saveDiscoveryState({
		authorizationServerUrl: second.issuer,
		authorizationServerMetadata: {
			issuer: second.issuer,
			authorization_endpoint: `${second.issuer}/authorize`,
			token_endpoint: `${second.issuer}/token`,
			response_types_supported: ["code"],
		},
	});
	await provider.saveTokens(
		{ access_token: "old", token_type: "Bearer", expires_in: 1, refresh_token: "rb" },
		second,
	);
	now += 10_000;
	const refreshing = provider.tokens();
	await new Promise((resolve) => setTimeout(resolve, 5));
	await provider.invalidateCredentials("tokens");
	release();
	const served = await refreshing;
	assert.equal(served?.access_token, "late", "the caller still gets the fresh set");
	assert.equal(await store.get(`${second.issuer}/tokens`), undefined, "but nothing was re-stored");
	// A contextual read (the SDK's own auth() orchestration) never refreshes proactively.
	await provider.saveTokens(
		{ access_token: "old", token_type: "Bearer", expires_in: 1, refresh_token: "rb" },
		second,
	);
	assert.equal((await provider.tokens(second))?.access_token, "old");
});

test("client credentials post form-encoded Basic credentials only to secure endpoints", async () => {
	const seen: { url: string; authorization: string | undefined }[] = [];
	const fetchFn: FetchLike = async (input, init) => {
		const headers = new Headers(init?.headers);
		seen.push({ url: String(input), authorization: headers.get("authorization") ?? undefined });
		return new Response(JSON.stringify({ id_token: unsignedJwt({ sub: "s", exp: 9e9 }) }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	await refreshIdpTokens({
		tokenEndpoint: "https://idp.example.com/token",
		clientId: "id:with:colons",
		clientSecret: "pässword:1",
		refreshToken: "r",
		fetch: fetchFn,
	});
	const header = seen[0]?.authorization ?? "";
	assert.ok(header.startsWith("Basic "));
	const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
	assert.equal(
		decoded,
		`${encodeURIComponent("id:with:colons")}:${encodeURIComponent("pässword:1")}`,
	);
	await assert.rejects(
		refreshIdpTokens({
			tokenEndpoint: "http://idp.example.com/token",
			clientId: "c",
			refreshToken: "r",
			fetch: fetchFn,
		}),
		/https|secure|insecure/i,
	);
	// Loopback stays allowed for local development.
	await refreshIdpTokens({
		tokenEndpoint: "http://127.0.0.1:9/token",
		clientId: "c",
		refreshToken: "r",
		fetch: fetchFn,
	});
	assert.equal(seen.length, 2);
});

test("the IdP sign-in refuses a plaintext authorization endpoint and an ID token without the nonce", async () => {
	const plaintext: FetchLike = async (input) => {
		if (String(input).includes("well-known")) {
			return new Response(
				JSON.stringify({
					issuer: "https://idp.example.com",
					authorization_endpoint: "http://idp.example.com/authorize",
					token_endpoint: "https://idp.example.com/token",
					response_types_supported: ["code"],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		return new Response("nope", { status: 404 });
	};
	await assert.rejects(
		authorizeEnterpriseIdp({
			issuer: "https://idp.example.com",
			clientId: "c",
			redirectUrl: "http://127.0.0.1:1/callback",
			fetch: plaintext,
			onRedirect: () => undefined,
			waitForCallback: async () => new URLSearchParams(),
		}),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.AUTH_FORBIDDEN,
	);
	// The scenario server mints ID tokens without a nonce claim; that must be refused now.
	const server = fakeAuthorizationServer();
	let authorization: URL | undefined;
	await assert.rejects(
		authorizeEnterpriseIdp({
			issuer: IDP,
			clientId: "idp-client",
			redirectUrl: "http://127.0.0.1:1/callback",
			fetch: server.fetch,
			onRedirect: (url) => {
				authorization = url;
			},
			waitForCallback: async () =>
				new URLSearchParams({
					code: "idp-code",
					state: authorization?.searchParams.get("state") ?? "",
				}),
		}),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.AUTH_STATE_MISMATCH,
	);
});

test("pinned discovery state keeps the caller's issuer and explanations strip control characters", () => {
	const pinned = pinnedDiscoveryState(
		"https://x.okta.com/oauth2/default/v1/token",
		"https://x.okta.com/oauth2/default",
	);
	assert.equal(pinned.authorizationServerUrl, "https://x.okta.com/oauth2/default");
	assert.equal(pinned.authorizationServerMetadata?.issuer, "https://x.okta.com/oauth2/default");
	assert.equal(
		pinnedDiscoveryState("https://as.example.com/token").authorizationServerUrl,
		"https://as.example.com",
	);
	assert.throws(() => pinnedDiscoveryState("http://as.example.com/token"));
	const hostile = new OAuthError(OAuthErrorCode.ServerError, "bad\u001b[31m\nfake log line");
	const explained = explainOAuthError(hostile);
	assert.ok(!/[\u0000-\u001f]/.test(explained.message), "no control characters survive");
	assert.ok(explained.message.includes("bad"));
});
