import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test, { type TestContext } from "node:test";

import { SignJWT, exportJWK, generateKeyPair } from "jose";

import {
	OAuthError,
	OAuthErrorCode,
	bearerAuthChallengeResponse,
	introspectionVerifier,
	jwtVerifier,
	routeByIssuer,
	staticTokenVerifier,
	unverifiedIssuer,
	verifyBearerToken,
	type OAuthTokenVerifier,
} from "../src/auth.ts";

const now = () => Math.floor(Date.now() / 1000);

async function listen(
	t: TestContext,
	handler: Parameters<typeof createServer>[1],
): Promise<{ readonly server: Server; readonly origin: string }> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no address");
	return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function challengeStatus(
	verifier: OAuthTokenVerifier,
	header: string | undefined,
): Promise<Response> {
	try {
		await verifyBearerToken(header, { verifier });
		throw new Error("expected rejection");
	} catch (error) {
		return bearerAuthChallengeResponse(error, {
			resourceMetadataUrl: "https://rs.example/.well-known/oauth-protected-resource",
		});
	}
}

test("jwtVerifier validates against a JWKS and maps failures to OAuth errors", async (t) => {
	const { privateKey, publicKey } = await generateKeyPair("ES256");
	const other = await generateKeyPair("ES256");
	const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
	let jwksHits = 0;
	const { origin } = await listen(t, (_request, response) => {
		jwksHits += 1;
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ keys: [jwk] }));
	});
	const issuer = "https://as.example";
	const audience = "https://rs.example/mcp";
	const sign = (claims: Record<string, unknown>, key = privateKey, exp: string | number = "1h") =>
		new SignJWT(claims)
			.setProtectedHeader({ alg: "ES256", kid: "k1" })
			.setIssuedAt()
			.setIssuer(issuer)
			.setAudience(audience)
			.setExpirationTime(exp)
			.sign(key);
	const verifier = jwtVerifier({ jwksUri: `${origin}/jwks.json`, issuer, audience });

	const good = await verifier.verifyAccessToken(await sign({ sub: "user-1", scope: "read write" }));
	assert.equal(good.clientId, "user-1");
	assert.deepEqual(good.scopes, ["read", "write"]);
	assert.equal(good.resource?.href, audience);
	assert.ok(good.expiresAt !== undefined && good.expiresAt > now());

	const cases: Array<[string, Promise<string>, string]> = [
		["expired", sign({ sub: "u" }, privateKey, Math.floor(Date.now() / 1000) - 60), "expired"],
		["wrong key", sign({ sub: "u" }, other.privateKey), "signature"],
		[
			"no exp",
			new SignJWT({ sub: "u" })
				.setProtectedHeader({ alg: "ES256", kid: "k1" })
				.setIssuer(issuer)
				.setAudience(audience)
				.sign(privateKey),
			"no exp",
		],
		["no subject", sign({}), "no subject"],
	];
	for (const [label, token] of cases) {
		await assert.rejects(
			verifier.verifyAccessToken(await token),
			(error: unknown) => error instanceof OAuthError && error.code === OAuthErrorCode.InvalidToken,
			label,
		);
	}
	const wrongAudience = await new SignJWT({ sub: "u" })
		.setProtectedHeader({ alg: "ES256", kid: "k1" })
		.setIssuer(issuer)
		.setAudience("https://other.example")
		.setExpirationTime("1h")
		.sign(privateKey);
	assert.equal((await challengeStatus(verifier, `Bearer ${wrongAudience}`)).status, 401);
	const challenge = await challengeStatus(verifier, "Bearer nonsense");
	assert.equal(challenge.status, 401);
	assert.match(challenge.headers.get("www-authenticate") ?? "", /invalid_token/);
	assert.match(challenge.headers.get("www-authenticate") ?? "", /resource_metadata/);
	assert.ok(jwksHits >= 1);

	const unreachable = jwtVerifier({ jwksUri: "http://127.0.0.1:1/jwks.json", issuer, audience });
	assert.equal(
		(await challengeStatus(unreachable, `Bearer ${await sign({ sub: "u" })}`)).status,
		500,
	);
});

test("introspectionVerifier caches by digest, clamps to exp and caches negatives", async (t) => {
	let calls = 0;
	const { origin } = await listen(t, async (request, response) => {
		calls += 1;
		let body = "";
		for await (const chunk of request) body += chunk;
		const token = new URLSearchParams(body).get("token");
		assert.match(request.headers.authorization ?? "", /^(Basic|Bearer) /);
		response.writeHead(200, { "content-type": "application/json" });
		if (token === "alive") {
			response.end(JSON.stringify({ active: true, client_id: "c1", scope: "a b", exp: now() + 2 }));
		} else if (token === "eternal") {
			response.end(JSON.stringify({ active: true, sub: "s1" }));
		} else {
			response.end(JSON.stringify({ active: false }));
		}
	});
	const verifier = introspectionVerifier({
		endpoint: `${origin}/introspect`,
		credentials: { clientId: "rs", clientSecret: "secret" },
		cacheTtlSeconds: 60,
		negativeCacheSeconds: 60,
	});
	const first = await verifier.verifyAccessToken("alive");
	assert.equal(first.clientId, "c1");
	assert.deepEqual(first.scopes, ["a", "b"]);
	await verifier.verifyAccessToken("alive");
	assert.equal(calls, 1, "positive result served from cache");
	await assert.rejects(verifier.verifyAccessToken("dead"), (e: unknown) => e instanceof OAuthError);
	await assert.rejects(verifier.verifyAccessToken("dead"), (e: unknown) => e instanceof OAuthError);
	assert.equal(calls, 2, "negative result served from cache");
	await assert.rejects(verifier.verifyAccessToken("eternal"), /no expiration/);
	const lenient = introspectionVerifier({
		endpoint: `${origin}/introspect`,
		credentials: { bearer: "rs-token" },
		defaultTtlSeconds: 30,
	});
	assert.equal((await lenient.verifyAccessToken("eternal")).clientId, "s1");
	const down = introspectionVerifier({
		endpoint: "http://127.0.0.1:1/x",
		credentials: { bearer: "b" },
	});
	assert.equal((await challengeStatus(down, "Bearer whatever")).status, 500);
});

test("staticTokenVerifier resists prototype-key and empty lookups", async () => {
	const verifier = staticTokenVerifier([
		{ token: "s3cret", clientId: "svc", scopes: ["mcp"], expiresAt: now() + 3600 },
		{ token: "old", clientId: "svc", expiresAt: now() - 1 },
	]);
	assert.equal((await verifier.verifyAccessToken("s3cret")).clientId, "svc");
	for (const bad of ["constructor", "__proto__", "toString", "", "s3cre"]) {
		assert.equal((await challengeStatus(verifier, `Bearer ${bad}`)).status, 401, bad);
	}
	assert.equal((await challengeStatus(verifier, "Bearer old")).status, 401);
	assert.equal((await challengeStatus(verifier, undefined)).status, 401);
	assert.throws(() => staticTokenVerifier([]));
});

test("routeByIssuer dispatches on the unverified iss claim only", async () => {
	const seen: string[] = [];
	const make = (name: string): OAuthTokenVerifier => ({
		async verifyAccessToken(token) {
			seen.push(name);
			return { token, clientId: name, scopes: [], expiresAt: now() + 60 };
		},
	});
	const a = "https://a.example";
	const b = "https://b.example";
	const tokenFor = (iss: string) =>
		`eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ iss })).toString("base64url")}.x`;
	assert.equal(unverifiedIssuer(tokenFor(a)), a);
	assert.equal(unverifiedIssuer("opaque"), undefined);
	const verifier = routeByIssuer({ [a]: make("A"), [b]: make("B") });
	assert.equal((await verifier.verifyAccessToken(tokenFor(b))).clientId, "B");
	await assert.rejects(
		verifier.verifyAccessToken(tokenFor("https://c.example")),
		(e: unknown) => e instanceof OAuthError,
	);
	await assert.rejects(
		verifier.verifyAccessToken("opaque"),
		(e: unknown) => e instanceof OAuthError,
	);
	const withFallback = routeByIssuer({ [a]: make("A") }, { fallback: make("F") });
	assert.equal((await withFallback.verifyAccessToken("opaque")).clientId, "F");
	assert.deepEqual(seen, ["B", "F"]);
});
