import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request as httpRequest } from "node:http";
import test from "node:test";

import type {
	OAuthClientInformationContext,
	OAuthClientProvider,
	StoredOAuthClientInformation,
} from "@modelcontextprotocol/client";

import {
	InMemoryKeyValueStore,
	McpOAuthClientProvider,
	type McpKeyValueStore,
} from "../src/client/oauth.ts";
import { KMCP_ERROR_CODES, KmcpError } from "../src/errors.ts";
import { FileKeyValueStore, loopbackOAuthCallback } from "../src/node/oauth.ts";

/** Loads a URL the way a browser navigation does (Node's fetch sends `Sec-Fetch-Mode: cors`). */
function browse(url: URL): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			url,
			{ headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } },
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () =>
					resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString() }),
				);
			},
		);
		request.on("error", reject);
		request.end();
	});
}

const SERVER_URL = "https://mcp.example.com/mcp";
const REDIRECT_URL = "http://127.0.0.1:7777/callback";
const FIRST = { issuer: "https://as-one.example.com" };
const SECOND = { issuer: "https://as-two.example.com" };

function makeProvider(serverUrl: string, store: McpKeyValueStore): McpOAuthClientProvider {
	return new McpOAuthClientProvider({
		serverUrl,
		redirectUrl: REDIRECT_URL,
		store,
		onRedirect: () => undefined,
	});
}

/**
 * Calls the DCR-only `saveClientInformation` member. A static-`clientId` provider deliberately
 * does not have one, so every call site has to prove it is talking to a DCR-capable provider.
 */
async function saveRegisteredClient(
	provider: McpOAuthClientProvider,
	clientInformation: StoredOAuthClientInformation,
	ctx?: OAuthClientInformationContext,
): Promise<void> {
	const save = provider.saveClientInformation;
	if (save === undefined) throw new Error("expected a dynamically registering provider");
	await save(clientInformation, ctx);
}

async function temporaryStorePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "kmcp-oauth-"));
	return join(directory, "nested", "credentials.json");
}

test("client information and tokens round-trip per authorization-server issuer", async () => {
	const store = new InMemoryKeyValueStore();
	const provider = makeProvider(SERVER_URL, store);

	assert.equal("saveClientInformation" in provider, true);
	await saveRegisteredClient(provider, { client_id: "one", issuer: FIRST.issuer }, FIRST);
	await saveRegisteredClient(provider, { client_id: "two", issuer: SECOND.issuer }, SECOND);
	await provider.saveTokens(
		{ access_token: "a", token_type: "Bearer", issuer: FIRST.issuer },
		FIRST,
	);
	await provider.saveTokens(
		{ access_token: "b", token_type: "Bearer", issuer: SECOND.issuer },
		SECOND,
	);

	assert.deepEqual(await provider.clientInformation(FIRST), {
		client_id: "one",
		issuer: FIRST.issuer,
	});
	assert.deepEqual(await provider.clientInformation(SECOND), {
		client_id: "two",
		issuer: SECOND.issuer,
	});
	assert.partialDeepStrictEqual(await provider.tokens(FIRST), {
		access_token: "a",
		token_type: "Bearer",
		issuer: FIRST.issuer,
	});
	assert.partialDeepStrictEqual(await provider.tokens(SECOND), {
		access_token: "b",
		token_type: "Bearer",
		issuer: SECOND.issuer,
	});
	assert.equal(typeof (await store.get(`${FIRST.issuer}/tokens`)), "string");
	assert.equal(await store.get(`${SERVER_URL}/tokens`), undefined);
});

test("a context-less read follows the last-issuer pointer", async () => {
	const store = new InMemoryKeyValueStore();
	const provider = makeProvider(SERVER_URL, store);

	assert.equal(await provider.tokens(), undefined);

	await provider.saveTokens({ access_token: "a", token_type: "Bearer" }, FIRST);
	assert.equal((await provider.tokens())?.access_token, "a");
	assert.equal(await store.get(`${SERVER_URL}/issuer`), FIRST.issuer);

	await provider.saveTokens({ access_token: "b", token_type: "Bearer" }, SECOND);
	assert.equal((await provider.tokens())?.access_token, "b");

	await saveRegisteredClient(provider, { client_id: "second-client" }, SECOND);
	assert.equal((await provider.clientInformation())?.client_id, "second-client");

	// Re-authorizing against the first server moves the pointer back.
	await provider.saveTokens({ access_token: "a2", token_type: "Bearer" }, FIRST);
	assert.equal((await provider.tokens())?.access_token, "a2");
});

test("a pre-registered client is never overwritten by dynamic registration", async () => {
	const store = new InMemoryKeyValueStore();
	const provider = new McpOAuthClientProvider({
		serverUrl: SERVER_URL,
		redirectUrl: REDIRECT_URL,
		clientId: "static-client",
		clientSecret: "static-secret",
		expectedIssuer: FIRST.issuer,
		store,
		onRedirect: () => undefined,
	});

	// A static provider carries no saveClientInformation at all, exactly like the SDK's own static
	// providers: auth() reads that absence as "this credential cannot be re-registered".
	assert.equal("saveClientInformation" in provider, false);

	assert.deepEqual(await provider.clientInformation(FIRST), {
		client_id: "static-client",
		client_secret: "static-secret",
		issuer: FIRST.issuer,
	});
	assert.deepEqual(await provider.clientInformation(SECOND), {
		client_id: "static-client",
		client_secret: "static-secret",
		issuer: FIRST.issuer,
	});
	assert.equal(await store.get(`${FIRST.issuer}/client_info`), undefined);
	assert.equal(provider.saveClientInformation, undefined);
});

test("token_endpoint_auth_method follows the configured secret and grant_types stays unset", () => {
	const store = new InMemoryKeyValueStore();
	const publicClient = makeProvider(SERVER_URL, store);
	const confidentialClient = new McpOAuthClientProvider({
		serverUrl: SERVER_URL,
		redirectUrl: REDIRECT_URL,
		clientId: "static-client",
		clientSecret: "static-secret",
		clientName: "kmcp tests",
		scope: ["read", "write"],
		store,
		onRedirect: () => undefined,
	});

	assert.equal(publicClient.clientMetadata.token_endpoint_auth_method, "none");
	assert.equal(publicClient.clientMetadata.client_name, "kmcp");
	assert.equal("scope" in publicClient.clientMetadata, false);
	assert.deepEqual(publicClient.clientMetadata.redirect_uris, [REDIRECT_URL]);

	assert.equal(confidentialClient.clientMetadata.token_endpoint_auth_method, "client_secret_post");
	assert.equal(confidentialClient.clientMetadata.client_name, "kmcp tests");
	assert.equal(confidentialClient.clientMetadata.scope, "read write");
	assert.deepEqual(confidentialClient.clientMetadata.response_types, ["code"]);
	// The SDK's resolveClientMetadata supplies the SEP-2207 interactive default; an explicit
	// value here would suppress it and could cost the client its refresh token.
	assert.equal("grant_types" in confidentialClient.clientMetadata, false);
});

test("a malformed Client ID Metadata Document URL fails at construction", () => {
	for (const clientMetadataUrl of ["http://example.com/client", "https://example.com/", "nope"]) {
		assert.throws(
			() =>
				new McpOAuthClientProvider({
					serverUrl: SERVER_URL,
					redirectUrl: REDIRECT_URL,
					clientMetadataUrl,
					onRedirect: () => undefined,
				}),
			/clientMetadataUrl must be a valid HTTPS URL/,
		);
	}

	const provider = new McpOAuthClientProvider({
		serverUrl: SERVER_URL,
		redirectUrl: REDIRECT_URL,
		clientMetadataUrl: "https://example.com/client-metadata.json",
		onRedirect: () => undefined,
	});
	assert.equal(provider.clientMetadataUrl, "https://example.com/client-metadata.json");
});

test("the constructor rejects a missing onRedirect and a relative serverUrl", () => {
	assert.throws(
		() =>
			new McpOAuthClientProvider({
				serverUrl: SERVER_URL,
				redirectUrl: REDIRECT_URL,
				onRedirect: undefined as unknown as (url: URL) => void,
			}),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
	assert.throws(
		() =>
			new McpOAuthClientProvider({
				serverUrl: "/mcp",
				redirectUrl: REDIRECT_URL,
				onRedirect: () => undefined,
			}),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
});

test("one store serves several MCP servers without leaking credentials between them", async () => {
	const store = new InMemoryKeyValueStore();
	const first = makeProvider("https://one.example.com/mcp", store);
	const second = makeProvider("https://two.example.com/mcp", store);

	await first.saveTokens({ access_token: "first-only", token_type: "Bearer" }, FIRST);
	await first.saveCodeVerifier("first-verifier");
	await first.saveDiscoveryState({ authorizationServerUrl: FIRST.issuer });

	assert.equal(await second.tokens(), undefined);
	assert.equal(await second.discoveryState(), undefined);
	await assert.rejects(
		second.codeVerifier(),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.OPERATION_FAILED,
	);
	assert.equal((await first.tokens())?.access_token, "first-only");
	assert.equal(await first.codeVerifier(), "first-verifier");
});

test("the PKCE verifier and the discovery state survive in the store", async () => {
	const store = new InMemoryKeyValueStore();
	const provider = makeProvider(SERVER_URL, store);
	const state = {
		authorizationServerUrl: `${FIRST.issuer}/`,
		resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
		authorizationServerMetadata: {
			issuer: FIRST.issuer,
			authorization_endpoint: `${FIRST.issuer}/authorize`,
			token_endpoint: `${FIRST.issuer}/token`,
			response_types_supported: ["code"],
		},
	};

	await provider.saveCodeVerifier("verifier-value");
	await provider.saveDiscoveryState(state);

	// A second provider over the same store is the post-redirect leg: both values must survive it.
	const afterRedirect = makeProvider(SERVER_URL, store);
	assert.equal(await afterRedirect.codeVerifier(), "verifier-value");
	assert.deepEqual(await afterRedirect.discoveryState(), state);
	assert.equal(typeof (await store.get(`${SERVER_URL}/code_verifier`)), "string");
});

test("invalidateCredentials drops exactly the requested scope", async () => {
	const seed = async (): Promise<{
		provider: McpOAuthClientProvider;
		store: InMemoryKeyValueStore;
	}> => {
		const store = new InMemoryKeyValueStore();
		const provider = makeProvider(SERVER_URL, store);
		await saveRegisteredClient(provider, { client_id: "registered" }, FIRST);
		await provider.saveTokens({ access_token: "token", token_type: "Bearer" }, FIRST);
		await provider.saveCodeVerifier("verifier");
		await provider.saveDiscoveryState({ authorizationServerUrl: FIRST.issuer });
		return { provider, store };
	};

	const tokensOnly = await seed();
	await tokensOnly.provider.invalidateCredentials("tokens");
	assert.equal(await tokensOnly.provider.tokens(), undefined);
	assert.equal((await tokensOnly.provider.clientInformation())?.client_id, "registered");
	assert.equal(await tokensOnly.provider.codeVerifier(), "verifier");
	assert.notEqual(await tokensOnly.provider.discoveryState(), undefined);

	const clientOnly = await seed();
	await clientOnly.provider.invalidateCredentials("client");
	assert.equal(await clientOnly.provider.clientInformation(), undefined);
	assert.equal((await clientOnly.provider.tokens())?.access_token, "token");

	const verifierOnly = await seed();
	await verifierOnly.provider.invalidateCredentials("verifier");
	await assert.rejects(verifierOnly.provider.codeVerifier());
	assert.notEqual(await verifierOnly.provider.discoveryState(), undefined);

	const discoveryOnly = await seed();
	await discoveryOnly.provider.invalidateCredentials("discovery");
	assert.equal(await discoveryOnly.provider.discoveryState(), undefined);
	assert.equal((await discoveryOnly.provider.tokens())?.access_token, "token");

	const everything = await seed();
	await everything.provider.invalidateCredentials("all");
	assert.equal(await everything.provider.tokens(), undefined);
	assert.equal(await everything.provider.clientInformation(), undefined);
	assert.equal(await everything.provider.discoveryState(), undefined);
	await assert.rejects(everything.provider.codeVerifier());
});

test("redirectToAuthorization only hands the URL to onRedirect", async () => {
	const seen: URL[] = [];
	const provider = new McpOAuthClientProvider({
		serverUrl: SERVER_URL,
		redirectUrl: REDIRECT_URL,
		onRedirect: (url) => {
			seen.push(url);
		},
	});

	const authorizationUrl = new URL("https://as-one.example.com/authorize?client_id=x");
	await provider.redirectToAuthorization(authorizationUrl);

	assert.deepEqual(
		seen.map((url) => url.href),
		[authorizationUrl.href],
	);
	assert.equal(Object.isFrozen(provider), true);
	assert.equal(Object.keys(provider).includes("clientSecret"), false);
});

test("the provider satisfies the SDK OAuthClientProvider type", async () => {
	const sdkProvider: OAuthClientProvider = new McpOAuthClientProvider({
		serverUrl: SERVER_URL,
		redirectUrl: REDIRECT_URL,
		onRedirect: () => undefined,
	});

	assert.equal(String(sdkProvider.redirectUrl), REDIRECT_URL);
	assert.equal("saveClientInformation" in sdkProvider, true);
	assert.equal(typeof sdkProvider.saveClientInformation, "function");
	assert.equal(typeof sdkProvider.saveDiscoveryState, "function");
	assert.equal(typeof sdkProvider.discoveryState, "function");
	assert.equal(typeof sdkProvider.invalidateCredentials, "function");
	assert.equal(await sdkProvider.tokens(), undefined);
});

test("FileKeyValueStore persists across instances with 0600 permissions", async () => {
	const path = await temporaryStorePath();
	const store = new FileKeyValueStore(path);

	await store.set("alpha", "1");
	await store.set("beta", "2");
	await store.delete("beta");

	const reopened = new FileKeyValueStore(path);
	assert.equal(await reopened.get("alpha"), "1");
	assert.equal(await reopened.get("beta"), undefined);
	assert.equal(await reopened.get("missing"), undefined);

	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { alpha: "1" });
	assert.deepEqual(
		(await readdir(dirname(path))).filter((name) => name.endsWith(".tmp")),
		[],
	);
});

test("FileKeyValueStore serializes concurrent writes without losing entries", async () => {
	const path = await temporaryStorePath();
	const store = new FileKeyValueStore(path);
	const keys = Array.from({ length: 25 }, (_, index) => `key-${index}`);

	await Promise.all(keys.map((key, index) => store.set(key, String(index))));

	const reopened = new FileKeyValueStore(path);
	for (const [index, key] of keys.entries()) {
		assert.equal(await reopened.get(key), String(index));
	}

	await Promise.all(keys.slice(0, 10).map((key) => store.delete(key)));
	const afterDeletes = new FileKeyValueStore(path);
	assert.equal(await afterDeletes.get("key-0"), undefined);
	assert.equal(await afterDeletes.get("key-10"), "10");
});

test("FileKeyValueStore backs a provider end to end", async () => {
	const path = await temporaryStorePath();
	const provider = makeProvider(SERVER_URL, new FileKeyValueStore(path));
	await provider.saveTokens({ access_token: "persisted", token_type: "Bearer" }, FIRST);

	const restarted = makeProvider(SERVER_URL, new FileKeyValueStore(path));
	assert.equal((await restarted.tokens())?.access_token, "persisted");
});

test("loopbackOAuthCallback resolves with the full callback query", async () => {
	const handle = await loopbackOAuthCallback({ path: "/oauth/done", timeoutMs: 30_000 });
	const pending = handle.waitForCallback();

	assert.equal(handle.redirectUrl.hostname, "127.0.0.1");
	assert.equal(handle.redirectUrl.pathname, "/oauth/done");
	assert.notEqual(handle.redirectUrl.port, "0");
	const beforeRedirect: URL | undefined = handle.authorizationUrl;
	assert.equal(beforeRedirect, undefined);

	const authorizationUrl = new URL("https://as-one.example.com/authorize?client_id=x");
	handle.onRedirect(authorizationUrl);
	assert.equal(handle.authorizationUrl?.href, authorizationUrl.href);

	const wrongPath = new URL(handle.redirectUrl.href);
	wrongPath.pathname = "/favicon.ico";
	assert.equal((await browse(wrongPath)).status, 404);

	const callback = new URL(handle.redirectUrl.href);
	callback.searchParams.set("code", "auth-code");
	callback.searchParams.set("iss", FIRST.issuer);
	const response = await browse(callback);
	assert.equal(response.status, 200);
	assert.match(response.text, /Authorization complete/);

	const params = await pending;
	assert.equal(params.get("code"), "auth-code");
	assert.equal(params.get("iss"), FIRST.issuer);

	await handle.close();
	await handle.close();
	await assert.rejects(fetch(callback));
});

test("loopbackOAuthCallback rejects a callback path that is not an absolute path", async () => {
	await assert.rejects(
		loopbackOAuthCallback({ path: "callback" }),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
	await assert.rejects(
		loopbackOAuthCallback({ path: "/callback?x=1" }),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
});

test("loopbackOAuthCallback rejects on an authorization error response", async () => {
	const handle = await loopbackOAuthCallback({ timeoutMs: 30_000 });
	const pending = handle.waitForCallback();

	const callback = new URL(handle.redirectUrl.href);
	callback.searchParams.set("error", "access_denied");
	callback.searchParams.set("error_description", "the user declined");
	assert.equal((await browse(callback)).status, 200);

	await assert.rejects(
		pending,
		(error: unknown) =>
			error instanceof KmcpError &&
			error.code === KMCP_ERROR_CODES.AUTH_FORBIDDEN &&
			error.message.includes("the user declined"),
	);
	await handle.close();
});

test("loopbackOAuthCallback rejects on timeout and on an early close", async () => {
	const timedOut = await loopbackOAuthCallback({ timeoutMs: 10 });
	await assert.rejects(
		timedOut.waitForCallback(),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.HANDLER_TIMEOUT,
	);
	await timedOut.close();

	const closed = await loopbackOAuthCallback({ timeoutMs: 30_000 });
	const pending = closed.waitForCallback();
	await closed.close();
	await assert.rejects(
		pending,
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.OPERATION_FAILED,
	);
});

test("loopbackOAuthCallback supplies a redirect URL a provider can register", async () => {
	await using handle = await loopbackOAuthCallback({ timeoutMs: 30_000 });
	const provider = new McpOAuthClientProvider({
		serverUrl: SERVER_URL,
		redirectUrl: handle.redirectUrl,
		onRedirect: handle.onRedirect,
		store: new InMemoryKeyValueStore(),
	});

	assert.deepEqual(provider.clientMetadata.redirect_uris, [handle.redirectUrl.href]);
	await provider.redirectToAuthorization(new URL("https://as-one.example.com/authorize"));
	assert.equal(handle.authorizationUrl?.href, "https://as-one.example.com/authorize");
});
