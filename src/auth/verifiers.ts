import {
	type AuthInfo,
	type FetchLike,
	OAuthError,
	OAuthErrorCode,
	type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";

/**
 * Verifier adapters for the official bearer-auth helpers (`requireBearerAuth` / `verifyBearerToken`).
 *
 * Contract every verifier here follows:
 * - reject with `OAuthError(InvalidToken)` carrying an OPAQUE reason (a plain `Error` would be
 *   answered as `500 server_error` with no `WWW-Authenticate` challenge);
 * - raise `OAuthError(ServerError)` only for genuinely internal faults (JWKS fetch, introspection
 *   endpoint down);
 * - always produce a complete `AuthInfo`: non-empty `token` and `clientId`, `scopes`, and a numeric
 *   `expiresAt` (the SDK enforces only `expiresAt` at runtime; kmcp enforces the rest).
 */

function invalidToken(reason = "invalid_token"): OAuthError {
	return new OAuthError(OAuthErrorCode.InvalidToken, reason);
}

function serverError(reason = "server_error"): OAuthError {
	return new OAuthError(OAuthErrorCode.ServerError, reason);
}

/** Enforces the parts of `AuthInfo` the SDK requires by type but never checks at runtime. */
export function assertAuthInfo(authInfo: AuthInfo): AuthInfo {
	if (typeof authInfo.token !== "string" || authInfo.token.length === 0) {
		throw serverError("verifier produced an empty token");
	}
	if (typeof authInfo.clientId !== "string" || authInfo.clientId.length === 0) {
		throw serverError("verifier produced an empty clientId");
	}
	if (!Array.isArray(authInfo.scopes) || authInfo.scopes.some((s) => typeof s !== "string")) {
		throw serverError("verifier produced invalid scopes");
	}
	if (typeof authInfo.expiresAt !== "number" || !Number.isFinite(authInfo.expiresAt)) {
		throw invalidToken("token has no expiration");
	}
	return authInfo;
}

const encoder = new TextEncoder();

/** Hex SHA-256 of a secret, for cache keys and lookups that must never hold the raw token. */
export async function sha256Hex(value: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function scopesFromClaim(value: unknown): string[] {
	if (typeof value === "string") return value.split(" ").filter((scope) => scope.length > 0);
	if (Array.isArray(value))
		return value.filter((scope): scope is string => typeof scope === "string");
	return [];
}

function resourceFromAudience(audience: string | readonly string[] | undefined): URL | undefined {
	const candidates = typeof audience === "string" ? [audience] : (audience ?? []);
	for (const candidate of candidates) {
		try {
			return new URL(candidate);
		} catch {
			// not a URL audience
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------------------------
// jwtVerifier — JWKS-backed JWT validation (optional peer dependency `jose`)
// ---------------------------------------------------------------------------------------------

export interface McpJwtVerifierOptions {
	/** The authorization server's JWKS document URL. */
	readonly jwksUri: string | URL;
	/** Expected `iss` claim. */
	readonly issuer: string;
	/** Expected `aud` claim — REQUIRED so a token minted for another resource is never accepted (RFC 8707). */
	readonly audience: string | readonly string[];
	/** Clock skew tolerance in seconds. Default: 0. */
	readonly leewaySeconds?: number;
	/** Allowed signing algorithms. Default: the asymmetric algorithms `jose` accepts for the key. */
	readonly algorithms?: readonly string[];
}

/**
 * Validates JWT bearer tokens against a remote JWKS. Requires the optional peer dependency
 * `jose` (loaded lazily on first use). `clientId` comes from `client_id`, then `azp`, then `sub`;
 * scopes from `scope` (space-separated) or `scp`; `resource` from the first `aud` that is a URL.
 * A token without `exp` is rejected.
 */
export function jwtVerifier(options: McpJwtVerifierOptions): OAuthTokenVerifier {
	const jwksUri = new URL(options.jwksUri);
	if (typeof options.issuer !== "string" || options.issuer.length === 0) {
		throw new KmcpError(KMCP_ERROR_CODES.INVALID_DEFINITION, "jwtVerifier requires an issuer.");
	}
	const audience = typeof options.audience === "string" ? options.audience : [...options.audience];
	if (audience.length === 0) {
		throw new KmcpError(KMCP_ERROR_CODES.INVALID_DEFINITION, "jwtVerifier requires an audience.");
	}
	let jose: Promise<typeof import("jose")> | undefined;
	let jwks: ReturnType<typeof import("jose").createRemoteJWKSet> | undefined;
	const load = async () => {
		jose ??= import("jose").catch((error: unknown) => {
			jose = undefined;
			throw new KmcpError(
				KMCP_ERROR_CODES.OPERATION_FAILED,
				"jwtVerifier needs the optional peer dependency 'jose' (pnpm add jose).",
				{ cause: error },
			);
		});
		const module = await jose;
		jwks ??= module.createRemoteJWKSet(jwksUri);
		return { module, jwks };
	};
	return {
		async verifyAccessToken(token: string): Promise<AuthInfo> {
			const { module, jwks: keys } = await load();
			let payload;
			try {
				({ payload } = await module.jwtVerify(token, keys, {
					issuer: options.issuer,
					audience,
					clockTolerance: options.leewaySeconds ?? 0,
					...(options.algorithms === undefined ? {} : { algorithms: [...options.algorithms] }),
				}));
			} catch (error) {
				throw mapJoseError(error);
			}
			if (typeof payload.exp !== "number") throw invalidToken("token has no expiration");
			const clientId =
				stringClaim(payload["client_id"]) ??
				stringClaim(payload["azp"]) ??
				stringClaim(payload.sub);
			if (clientId === undefined) throw invalidToken("token has no client identity");
			const resource = resourceFromAudience(payload.aud);
			return assertAuthInfo({
				token,
				clientId,
				scopes: scopesFromClaim(payload["scope"] ?? payload["scp"]),
				expiresAt: payload.exp,
				...(resource === undefined ? {} : { resource }),
				extra: { ...payload },
			});
		},
	};
}

function stringClaim(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * `jose` failures about the TOKEN (`ERR_JWT_*`, `ERR_JWS_*`, `ERR_JOSE_*`, no matching key) are the
 * caller's problem → `invalid_token`; failures reaching or parsing the JWKS (network errors carry
 * no jose code; `ERR_JWKS_INVALID` / `ERR_JWKS_TIMEOUT`) are ours → `server_error`.
 */
function mapJoseError(error: unknown): OAuthError {
	const code =
		typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
	if (typeof code !== "string") return serverError("jwks_unavailable");
	if (code === "ERR_JWKS_INVALID" || code === "ERR_JWKS_TIMEOUT") {
		return serverError("jwks_unavailable");
	}
	return invalidToken();
}

// ---------------------------------------------------------------------------------------------
// introspectionVerifier — RFC 7662
// ---------------------------------------------------------------------------------------------

export interface McpIntrospectionVerifierOptions {
	readonly endpoint: string | URL;
	readonly credentials:
		{ readonly clientId: string; readonly clientSecret: string } | { readonly bearer: string };
	/** Positive-result cache TTL in seconds (clamped to the token's own `exp`). Default: 0 (off). */
	readonly cacheTtlSeconds?: number;
	/** Negative-result cache TTL in seconds. Default: 5. */
	readonly negativeCacheSeconds?: number;
	/** Maximum cached entries (oldest evicted first). Default: 1000. */
	readonly maxEntries?: number;
	/** Expiry assigned to active tokens whose introspection response carries no `exp`. Default: reject them. */
	readonly defaultTtlSeconds?: number;
	readonly fetch?: FetchLike;
}

interface IntrospectionEntry {
	readonly authInfo?: AuthInfo;
	readonly expiresAt: number;
}

/**
 * Validates opaque tokens through an RFC 7662 introspection endpoint. Results are cached under a
 * SHA-256 digest of the token (never the raw token), positive entries expire no later than the
 * token itself, negative results are cached briefly so an attacker cannot force one upstream call
 * per request, and the cache is bounded.
 */
export function introspectionVerifier(
	options: McpIntrospectionVerifierOptions,
): OAuthTokenVerifier {
	const endpoint = new URL(options.endpoint);
	const cacheTtl = options.cacheTtlSeconds ?? 0;
	const negativeTtl = options.negativeCacheSeconds ?? 5;
	const maxEntries = options.maxEntries ?? 1000;
	for (const [name, value] of Object.entries({ cacheTtl, negativeTtl, maxEntries })) {
		if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative.`);
	}
	const fetchFn: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
	const authorization =
		"bearer" in options.credentials
			? `Bearer ${options.credentials.bearer}`
			: `Basic ${globalThis.btoa(`${options.credentials.clientId}:${options.credentials.clientSecret}`)}`;
	const cache = new Map<string, IntrospectionEntry>();
	const remember = (key: string, entry: IntrospectionEntry) => {
		if (entry.expiresAt <= nowSeconds()) return;
		if (cache.size >= maxEntries) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		cache.set(key, entry);
	};
	return {
		async verifyAccessToken(token: string): Promise<AuthInfo> {
			const key = await sha256Hex(token);
			const cached = cache.get(key);
			if (cached !== undefined) {
				if (cached.expiresAt > nowSeconds()) {
					if (cached.authInfo === undefined) throw invalidToken();
					return cached.authInfo;
				}
				cache.delete(key);
			}
			let response: Response;
			try {
				response = await fetchFn(endpoint, {
					method: "POST",
					headers: {
						authorization,
						"content-type": "application/x-www-form-urlencoded",
						accept: "application/json",
					},
					body: new URLSearchParams({ token }).toString(),
				});
			} catch {
				throw serverError("introspection_unavailable");
			}
			if (!response.ok) throw serverError("introspection_failed");
			let body: Record<string, unknown>;
			try {
				body = (await response.json()) as Record<string, unknown>;
			} catch {
				throw serverError("introspection_malformed");
			}
			if (body["active"] !== true) {
				remember(key, { expiresAt: nowSeconds() + negativeTtl });
				throw invalidToken();
			}
			const exp = typeof body["exp"] === "number" ? body["exp"] : undefined;
			const expiresAt =
				exp ??
				(options.defaultTtlSeconds === undefined
					? undefined
					: nowSeconds() + options.defaultTtlSeconds);
			if (expiresAt === undefined) throw invalidToken("token has no expiration");
			const clientId = stringClaim(body["client_id"]) ?? stringClaim(body["sub"]);
			if (clientId === undefined) throw invalidToken("token has no client identity");
			const resource = resourceFromAudience(body["aud"] as string | string[] | undefined);
			const authInfo = assertAuthInfo({
				token,
				clientId,
				scopes: scopesFromClaim(body["scope"]),
				expiresAt,
				...(resource === undefined ? {} : { resource }),
				extra: { ...body },
			});
			if (cacheTtl > 0)
				remember(key, { authInfo, expiresAt: Math.min(nowSeconds() + cacheTtl, expiresAt) });
			return authInfo;
		},
	};
}

// ---------------------------------------------------------------------------------------------
// staticTokenVerifier — fixed token table (tests, internal tooling)
// ---------------------------------------------------------------------------------------------

export interface McpStaticToken {
	readonly token: string;
	readonly clientId: string;
	readonly scopes?: readonly string[];
	/** Unix seconds. REQUIRED — the SDK rejects tokens without an expiry, and static tokens have no natural one. */
	readonly expiresAt: number;
	readonly resource?: string | URL;
	readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Accepts exactly the listed tokens. Lookups go through a SHA-256 digest table (no prototype keys,
 * no raw tokens retained, no early-exit string comparison).
 */
export function staticTokenVerifier(tokens: readonly McpStaticToken[]): OAuthTokenVerifier {
	if (tokens.length === 0) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			"staticTokenVerifier needs at least one token.",
		);
	}
	for (const entry of tokens) {
		if (typeof entry.token !== "string" || entry.token.length === 0) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				"static tokens must be non-empty strings.",
			);
		}
		if (typeof entry.clientId !== "string" || entry.clientId.length === 0) {
			throw new KmcpError(KMCP_ERROR_CODES.INVALID_DEFINITION, "static tokens need a clientId.");
		}
		if (typeof entry.expiresAt !== "number" || !Number.isFinite(entry.expiresAt)) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				"static tokens need a numeric expiresAt.",
			);
		}
	}
	let table: Promise<Map<string, McpStaticToken>> | undefined;
	const load = () =>
		(table ??= Promise.all(
			tokens.map(async (entry) => [await sha256Hex(entry.token), entry] as const),
		).then((pairs) => new Map(pairs)));
	return {
		async verifyAccessToken(token: string): Promise<AuthInfo> {
			const entry = (await load()).get(await sha256Hex(token));
			if (entry === undefined || entry.token !== token) throw invalidToken();
			const resource = entry.resource === undefined ? undefined : new URL(entry.resource);
			return assertAuthInfo({
				token,
				clientId: entry.clientId,
				scopes: [...(entry.scopes ?? [])],
				expiresAt: entry.expiresAt,
				...(resource === undefined ? {} : { resource }),
				...(entry.extra === undefined ? {} : { extra: { ...entry.extra } }),
			});
		},
	};
}

// ---------------------------------------------------------------------------------------------
// routeByIssuer — exactly one authoritative verifier per token
// ---------------------------------------------------------------------------------------------

export interface RouteByIssuerOptions {
	/** Verifier for tokens that are not JWTs or whose `iss` is unknown. Default: reject. */
	readonly fallback?: OAuthTokenVerifier;
}

/**
 * Routes each token to the verifier registered for its (unverified) `iss` claim, so no verifier
 * ever sees a token minted by another issuer and a transient fault in one issuer's verifier
 * surfaces as that fault instead of a generic rejection. Replaces first-success-wins chaining.
 */
export function routeByIssuer(
	routes: Readonly<Record<string, OAuthTokenVerifier>>,
	options: RouteByIssuerOptions = {},
): OAuthTokenVerifier {
	const table = new Map(Object.entries(routes));
	if (table.size === 0) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			"routeByIssuer needs at least one issuer.",
		);
	}
	return {
		verifyAccessToken(token: string): Promise<AuthInfo> {
			const issuer = unverifiedIssuer(token);
			const verifier = issuer === undefined ? undefined : table.get(issuer);
			const target = verifier ?? options.fallback;
			if (target === undefined) return Promise.reject(invalidToken());
			return target.verifyAccessToken(token);
		},
	};
}

/** Reads `iss` from a JWT payload WITHOUT verifying it — only ever used to pick a verifier. */
export function unverifiedIssuer(token: string): string | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const payload = JSON.parse(
			new TextDecoder().decode(base64UrlDecode(parts[1] ?? "")),
		) as unknown;
		return typeof payload === "object" && payload !== null
			? stringClaim((payload as { iss?: unknown }).iss)
			: undefined;
	} catch {
		return undefined;
	}
}

function base64UrlDecode(value: string): Uint8Array {
	const base64 = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = globalThis.atob(base64);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
