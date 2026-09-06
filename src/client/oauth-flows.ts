import {
	type AuthorizationServerMetadata,
	AuthorizationServerMismatchError,
	ClientCredentialsProvider,
	CrossAppAccessProvider,
	type FetchLike,
	InsecureTokenEndpointError,
	InsufficientScopeError,
	IssuerMismatchError,
	OAuthError,
	OAuthErrorCode,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
	type OAuthProtectedResourceMetadata,
	PrivateKeyJwtProvider,
	RegistrationRejectedError,
	SdkHttpError,
	StaticPrivateKeyJwtProvider,
	type StoredOAuthTokens,
	UnauthorizedError,
	assertSecureTokenEndpoint,
	auth,
	discoverAndRequestJwtAuthGrant,
	discoverAuthorizationServerMetadata,
	discoverOAuthProtectedResourceMetadata,
	discoverOAuthServerInfo,
	extractWWWAuthenticateParams,
	requestJwtAuthorizationGrant,
} from "@modelcontextprotocol/client";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import { encodeBase64, encodeBase64Url } from "../internal/base64.ts";
import { MCP_MODERN_PROTOCOL_VERSION } from "../internal/protocol.ts";
import type { MaybePromise } from "../internal/value.ts";
import { decodeJwtClaims, jwtExpiresAt, type McpJwtClaims } from "./jwt.ts";
import { type McpCallbackStateVerifier, normalizeScope } from "./oauth.ts";

/** Capability extension advertised by clients that authenticate with the client-credentials grant. */
export const MCP_CLIENT_CREDENTIALS_EXTENSION = "io.modelcontextprotocol/oauth-client-credentials";
/** Capability extension advertised by clients that authenticate with enterprise-managed authorization (SEP-990). */
export const MCP_ENTERPRISE_MANAGED_AUTH_EXTENSION =
	"io.modelcontextprotocol/enterprise-managed-authorization";

/** Grant profile authorization servers list in `authorization_grant_profiles_supported` when they accept ID-JAGs. */
export const MCP_ID_JAG_GRANT_PROFILE = "urn:ietf:params:oauth:grant-profile:id-jag";

export type McpOAuthGrant = "authorization_code" | "client_credentials" | "jwt_bearer";

/** Classifies a provider by the grant it drives; `undefined` for a shape kmcp does not recognize. */
export function oauthGrantOf(provider: OAuthClientProvider): McpOAuthGrant | undefined {
	if (provider instanceof CrossAppAccessProvider) return "jwt_bearer";
	if (
		provider instanceof ClientCredentialsProvider ||
		provider instanceof PrivateKeyJwtProvider ||
		provider instanceof StaticPrivateKeyJwtProvider
	) {
		return "client_credentials";
	}
	return provider.redirectUrl === undefined ? undefined : "authorization_code";
}

// ---------------------------------------------------------------------------------------------
// Interactive authorization
// ---------------------------------------------------------------------------------------------

export interface McpAuthorizeOAuthOptions {
	/** The MCP server URL the flow authorizes against (its query and fragment are not part of the OAuth identity). */
	readonly serverUrl: string | URL;
	readonly scope?: string | readonly string[];
	readonly fetch?: FetchLike;
	/**
	 * Resolves with the callback query (`code`, optional `iss` and `state`) once the user agent
	 * returns. Required for interactive providers; a non-interactive provider never redirects.
	 */
	readonly waitForCallback?: () => Promise<URLSearchParams>;
	/** Explicit `resource_metadata` URL from a `WWW-Authenticate` challenge. */
	readonly resourceMetadataUrl?: URL;
	/** Skip the refresh branch and always start a fresh authorization request. */
	readonly forceReauthorization?: boolean;
	/** Security-weakening opt-out of the RFC 8414 issuer-echo check. */
	readonly skipIssuerMetadataValidation?: boolean;
}

export interface McpAuthorizeOAuthResult {
	/** Whether a user-agent round trip was needed. */
	readonly redirected: boolean;
	readonly tokens: StoredOAuthTokens | undefined;
}

/**
 * Runs the SDK's `auth()` orchestrator to completion ahead of any connection: discovery,
 * registration (or CIMD), refresh, and — when the authorization server needs the user — the
 * redirect leg followed by the code exchange. Interactive providers deliver the authorization URL
 * through their own `redirectToAuthorization`; the host resolves `waitForCallback` with the
 * callback query. The callback `state` is verified when the provider implements
 * `verifyCallbackState`, and an `error` on the callback is refused before any exchange.
 */
export async function authorizeOAuth(
	provider: OAuthClientProvider,
	options: McpAuthorizeOAuthOptions,
): Promise<McpAuthorizeOAuthResult> {
	const serverUrl = oauthServerUrl(options.serverUrl);
	const scope = normalizeScope(options.scope);
	const base = {
		serverUrl,
		...(scope === undefined ? {} : { scope }),
		...(options.fetch === undefined ? {} : { fetchFn: options.fetch }),
		...(options.resourceMetadataUrl === undefined
			? {}
			: { resourceMetadataUrl: options.resourceMetadataUrl }),
		...(options.skipIssuerMetadataValidation === undefined
			? {}
			: { skipIssuerMetadataValidation: options.skipIssuerMetadataValidation }),
	};
	const first = await auth(provider, {
		...base,
		...(options.forceReauthorization === undefined
			? {}
			: { forceReauthorization: options.forceReauthorization }),
	});
	if (first === "AUTHORIZED") {
		return Object.freeze({ redirected: false, tokens: await provider.tokens() });
	}
	if (options.waitForCallback === undefined) {
		throw new KmcpError(
			KMCP_ERROR_CODES.CONNECTION_AUTHORIZING,
			"The authorization server requires a user-agent round trip; pass waitForCallback to complete it.",
		);
	}
	const params = await options.waitForCallback();
	await assertCallbackSucceeded(provider, params);
	const code = params.get("code");
	if (code === null || code.length === 0) {
		throw new KmcpError(
			KMCP_ERROR_CODES.AUTH_FORBIDDEN,
			"The OAuth callback carried no authorization code.",
		);
	}
	const iss = params.get("iss");
	const second = await auth(provider, {
		...base,
		authorizationCode: code,
		...(iss === null ? {} : { iss }),
	});
	if (second !== "AUTHORIZED") {
		throw new KmcpError(
			KMCP_ERROR_CODES.CONNECTION_CONNECT_FAILED,
			"The authorization server asked for a second redirect while exchanging the code.",
		);
	}
	// The verifier and state were bound to the code just redeemed; neither may serve twice.
	await provider.invalidateCredentials?.("verifier");
	return Object.freeze({ redirected: true, tokens: await provider.tokens() });
}

/** Refuses a callback that reports an OAuth `error`, then verifies `state` when the provider can. */
export async function assertCallbackSucceeded(
	provider: OAuthClientProvider,
	params: URLSearchParams,
): Promise<void> {
	const error = params.get("error");
	if (error !== null) {
		// `error_description` is authorization-server text: diagnostic detail only, bounded.
		const description = bounded(params.get("error_description") ?? error);
		throw new KmcpError(
			KMCP_ERROR_CODES.AUTH_FORBIDDEN,
			`OAuth authorization was refused: ${description}`,
		);
	}
	const verifier = provider as Partial<McpCallbackStateVerifier>;
	if (typeof verifier.verifyCallbackState === "function") {
		await verifier.verifyCallbackState(params);
	}
}

/**
 * The URL OAuth discovery runs against: the MCP endpoint without its query and fragment. A query
 * (a tool filter, say) is a connection-level concern; the SDK would otherwise copy it onto the
 * well-known discovery URLs.
 */
export function oauthServerUrl(serverUrl: string | URL): string {
	const url = typeof serverUrl === "string" ? new URL(serverUrl) : new URL(serverUrl.href);
	url.search = "";
	url.hash = "";
	return url.href;
}

// ---------------------------------------------------------------------------------------------
// Failure explanation
// ---------------------------------------------------------------------------------------------

export type McpOAuthFailureKind =
	| "access_denied"
	| "authorization_server_mismatch"
	| "client_rejected"
	| "http"
	| "insecure_token_endpoint"
	| "insufficient_scope"
	| "invalid_grant"
	| "issuer_mismatch"
	| "oauth"
	| "registration_rejected"
	| "registration_unsupported"
	| "unauthorized"
	| "unknown";

export interface McpOAuthFailure {
	readonly kind: McpOAuthFailureKind;
	/** A bounded, host-facing summary. Never contains callback-supplied text on mix-up paths. */
	readonly message: string;
	readonly oauthCode?: string;
	readonly httpStatus?: number;
	readonly requiredScope?: string;
	/** What a host can do about it, when the failure has a known remedy. */
	readonly remediation?: string;
}

const REGISTRATION_UNSUPPORTED = /does not support dynamic client registration/i;
const PRE_REGISTERED_REMEDY =
	"Supply a client the authorization server already recognizes: a pre-registered clientId (with its clientSecret when confidential) or a Client ID Metadata Document URL (clientMetadataUrl).";

/**
 * Explains an error raised anywhere in the OAuth client flow in stable, host-facing terms. Walks
 * the `cause` chain so wrapped errors (the manager's `CONNECTION_CONNECT_FAILED`, for instance)
 * still classify. Registration failures carry remediation, because retrying cannot fix them.
 */
export function explainOAuthError(error: unknown): McpOAuthFailure {
	let current: unknown = error;
	for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
		const explained = explainOne(current);
		if (explained !== undefined) return explained;
		current = current instanceof Error ? current.cause : undefined;
	}
	return Object.freeze({
		kind: "unknown",
		message: bounded(error instanceof Error ? error.message : String(error)),
	});
}

function explainOne(error: unknown): McpOAuthFailure | undefined {
	if (error instanceof RegistrationRejectedError) {
		const rejected = error.status === 401 || error.status === 403;
		return Object.freeze({
			kind: "registration_rejected",
			httpStatus: error.status,
			message: rejected
				? `The authorization server refused to register this client (HTTP ${error.status}). Some servers only accept a fixed allow-list of clients.`
				: `Dynamic client registration failed (HTTP ${error.status}).`,
			remediation: PRE_REGISTERED_REMEDY,
		});
	}
	if (error instanceof IssuerMismatchError) {
		// `received` is attacker-controllable on the authorization-response path: never echoed.
		return Object.freeze({
			kind: "issuer_mismatch",
			message:
				error.kind === "authorization_response"
					? "The authorization callback named a different issuer than the one discovered for this server (possible mix-up attack); the code was not redeemed."
					: "The authorization server's metadata names an issuer that does not match its discovery URL.",
		});
	}
	if (error instanceof AuthorizationServerMismatchError) {
		return Object.freeze({
			kind: "authorization_server_mismatch",
			message:
				"Discovery resolved a different authorization server on the callback leg than on the redirect leg; the authorization code was not redeemed.",
			remediation:
				"Invalidate the provider's 'discovery' scope and authorize again so the current authorization server is recorded.",
		});
	}
	if (error instanceof InsecureTokenEndpointError) {
		return Object.freeze({
			kind: "insecure_token_endpoint",
			message:
				"The resolved token endpoint is not HTTPS (and not loopback); refusing to send credentials to it.",
		});
	}
	if (error instanceof InsufficientScopeError) {
		return Object.freeze({
			kind: "insufficient_scope",
			message: "The resource server requires a scope the current token does not carry.",
			...(error.requiredScope === undefined ? {} : { requiredScope: bounded(error.requiredScope) }),
			remediation: "Authorize again requesting the required scope.",
		});
	}
	if (error instanceof OAuthError) {
		const code = error.code;
		if (code === OAuthErrorCode.InvalidClient || code === OAuthErrorCode.UnauthorizedClient) {
			return Object.freeze({
				kind: "client_rejected",
				oauthCode: code,
				message: `The authorization server rejected this client (${code}).`,
				remediation: PRE_REGISTERED_REMEDY,
			});
		}
		if (code === OAuthErrorCode.AccessDenied) {
			return Object.freeze({
				kind: "access_denied",
				oauthCode: code,
				message: "The user or the authorization server denied the request.",
			});
		}
		if (code === OAuthErrorCode.InvalidGrant) {
			return Object.freeze({
				kind: "invalid_grant",
				oauthCode: code,
				message: "The authorization grant or refresh token is invalid, expired, or revoked.",
				remediation: "Authorize again.",
			});
		}
		if (REGISTRATION_UNSUPPORTED.test(error.message)) {
			return Object.freeze({
				kind: "registration_unsupported",
				oauthCode: code,
				message: "The authorization server does not support Dynamic Client Registration.",
				remediation: PRE_REGISTERED_REMEDY,
			});
		}
		return Object.freeze({ kind: "oauth", oauthCode: code, message: bounded(error.message) });
	}
	if (error instanceof UnauthorizedError) {
		return Object.freeze({
			kind: "unauthorized",
			message:
				"The server requires authorization and none of the stored credentials were accepted.",
		});
	}
	if (error instanceof SdkHttpError) {
		return Object.freeze({
			kind: "http",
			httpStatus: error.status,
			message: `HTTP ${error.status}${error.statusText === undefined ? "" : ` ${error.statusText}`}.`,
		});
	}
	if (error instanceof Error && REGISTRATION_UNSUPPORTED.test(error.message)) {
		return Object.freeze({
			kind: "registration_unsupported",
			message: "The authorization server does not support Dynamic Client Registration.",
			remediation: PRE_REGISTERED_REMEDY,
		});
	}
	return undefined;
}

/**
 * Bounds and sanitizes text that originated at an authorization server (or any remote party):
 * C0/C1 control characters — terminal escapes, newlines that forge log lines — become spaces, and
 * the result is capped so a hostile error body cannot flood a message.
 */
function bounded(text: string, max = 400): string {
	// eslint-disable-next-line no-control-regex
	const sanitized = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
	return sanitized.length > max ? `${sanitized.slice(0, max)}…` : sanitized;
}

// ---------------------------------------------------------------------------------------------
// Client-credentials grant (io.modelcontextprotocol/oauth-client-credentials)
// ---------------------------------------------------------------------------------------------

/** JWT signing algorithms accepted for `private_key_jwt` (RFC 7518 plus EdDSA). */
export const MCP_PRIVATE_KEY_JWT_ALGORITHMS: readonly string[] = Object.freeze([
	"RS256",
	"RS384",
	"RS512",
	"PS256",
	"PS384",
	"PS512",
	"ES256",
	"ES384",
	"ES512",
	"EdDSA",
]);

interface McpClientCredentialsBase {
	readonly clientId: string;
	readonly scope?: string | readonly string[];
	readonly clientName?: string;
	/** The issuer these credentials were registered with (SEP-2352 binding). */
	readonly expectedIssuer?: string;
	/** Bypass discovery and post straight to this token endpoint (servers without discoverable metadata). */
	readonly tokenEndpoint?: string | URL;
}

export type McpClientCredentialsOptions =
	| (McpClientCredentialsBase & {
			/** `client_secret_basic` authentication. */
			readonly clientSecret: string;
	  })
	| (McpClientCredentialsBase & {
			/** `private_key_jwt` (RFC 7523 §2.2): a PEM string, raw key bytes, or a JWK. */
			readonly privateKey: string | Uint8Array | Record<string, unknown>;
			/** Default: `RS256`. */
			readonly algorithm?: string;
			readonly jwtLifetimeSeconds?: number;
			readonly claims?: Record<string, unknown>;
	  })
	| (McpClientCredentialsBase & {
			/** A pre-built, signed client assertion used verbatim. */
			readonly jwtBearerAssertion: string;
	  });

/**
 * Builds the SDK provider for machine-to-machine authentication. The transport then drives the
 * token fetch and refresh through it; no browser and no user interaction. Connections that use
 * it advertise {@link MCP_CLIENT_CREDENTIALS_EXTENSION} automatically.
 */
export function clientCredentialsAuth(options: McpClientCredentialsOptions): OAuthClientProvider {
	const scope = normalizeScope(options.scope);
	const common = {
		clientId: options.clientId,
		...(options.clientName === undefined ? {} : { clientName: options.clientName }),
		...(scope === undefined ? {} : { scope }),
		...(options.expectedIssuer === undefined ? {} : { expectedIssuer: options.expectedIssuer }),
	};
	let provider: OAuthClientProvider;
	if ("privateKey" in options) {
		const algorithm = options.algorithm ?? "RS256";
		if (!MCP_PRIVATE_KEY_JWT_ALGORITHMS.includes(algorithm)) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				`Unsupported private_key_jwt algorithm '${algorithm}'. Supported: ${MCP_PRIVATE_KEY_JWT_ALGORITHMS.join(", ")}.`,
			);
		}
		provider = new PrivateKeyJwtProvider({
			...common,
			privateKey: options.privateKey,
			algorithm,
			...(options.jwtLifetimeSeconds === undefined
				? {}
				: { jwtLifetimeSeconds: options.jwtLifetimeSeconds }),
			...(options.claims === undefined ? {} : { claims: options.claims }),
		});
	} else if ("jwtBearerAssertion" in options) {
		provider = new StaticPrivateKeyJwtProvider({
			...common,
			jwtBearerAssertion: options.jwtBearerAssertion,
		});
	} else {
		if (options.clientSecret.length === 0) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				"clientCredentialsAuth requires a non-empty clientSecret, a privateKey, or a jwtBearerAssertion.",
			);
		}
		provider = new ClientCredentialsProvider({ ...common, clientSecret: options.clientSecret });
	}
	if (options.tokenEndpoint !== undefined) {
		const pinned = pinnedDiscoveryState(options.tokenEndpoint, options.expectedIssuer);
		provider.discoveryState = () => pinned;
	}
	return provider;
}

/**
 * Discovery state that pins a known token endpoint, bypassing RFC 9728 / RFC 8414 discovery. The
 * authorization endpoint and response types are unused by the client-credentials grant but the
 * SDK's metadata validation requires them. `issuer` is the identifier the SDK binds stored
 * credentials to (SEP-2352); pass the authorization server's real issuer (Okta and Auth0 issuers
 * carry a path or a trailing slash) — it defaults to the endpoint's origin only when unknown.
 */
export function pinnedDiscoveryState(
	tokenEndpoint: string | URL,
	issuer?: string,
): OAuthDiscoveryState {
	const endpoint = assertSecureTokenEndpoint(tokenEndpoint);
	const origin = endpoint.origin;
	const boundIssuer = issuer ?? origin;
	return Object.freeze({
		authorizationServerUrl: boundIssuer,
		authorizationServerMetadata: {
			issuer: boundIssuer,
			authorization_endpoint: `${origin}/authorize`,
			token_endpoint: endpoint.href,
			response_types_supported: ["code"],
			grant_types_supported: ["client_credentials"],
			token_endpoint_auth_methods_supported: [
				"client_secret_basic",
				"client_secret_post",
				"private_key_jwt",
			],
		} as AuthorizationServerMetadata,
	});
}

export interface McpValidateCredentialsOptions {
	readonly fetch?: FetchLike;
	readonly scope?: string | readonly string[];
}

export interface McpValidatedCredentials {
	readonly authorizationServerUrl: string;
	readonly scope?: string;
	readonly expiresIn?: number;
	readonly tokenType: string;
}

/**
 * Runs the SDK's `auth()` orchestrator once with a non-interactive provider (client credentials
 * or enterprise-managed authorization) to validate the material and learn the granted scope: a
 * successful validation means a connection built on the same provider will authenticate. A
 * provider built with a pinned `tokenEndpoint` skips discovery.
 */
export async function validateOAuthCredentials(
	provider: OAuthClientProvider,
	serverUrl: string | URL,
	options: McpValidateCredentialsOptions = {},
): Promise<McpValidatedCredentials> {
	if (provider.redirectUrl !== undefined) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			"validateOAuthCredentials only validates non-interactive providers; use authorizeOAuth for interactive ones.",
		);
	}
	const target = oauthServerUrl(serverUrl);
	const scope = normalizeScope(options.scope);
	const result = await auth(provider, {
		serverUrl: target,
		...(scope === undefined ? {} : { scope }),
		...(options.fetch === undefined ? {} : { fetchFn: options.fetch }),
	});
	if (result !== "AUTHORIZED") {
		throw new KmcpError(
			KMCP_ERROR_CODES.OPERATION_FAILED,
			"The provider asked for a user-agent redirect during a non-interactive validation.",
		);
	}
	const tokens = await provider.tokens();
	if (tokens === undefined) {
		throw new KmcpError(
			KMCP_ERROR_CODES.OPERATION_FAILED,
			"The provider reported success but holds no tokens.",
		);
	}
	const discovery = await provider.discoveryState?.();
	const authorizationServerUrl =
		discovery?.authorizationServerUrl ??
		(await provider.authorizationServerUrl?.()) ??
		tokens.issuer ??
		target;
	return Object.freeze({
		authorizationServerUrl,
		tokenType: tokens.token_type,
		...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
		...(tokens.expires_in === undefined ? {} : { expiresIn: tokens.expires_in }),
	});
}

// ---------------------------------------------------------------------------------------------
// Enterprise-managed authorization (SEP-990, ID-JAG)
// ---------------------------------------------------------------------------------------------

/** The material obtained from the enterprise IdP: the OIDC ID token plus an optional refresh token. */
export interface McpIdpTokens {
	readonly idToken: string;
	/** `exp` of the ID token (Unix seconds); derived from the token when omitted. */
	readonly idTokenExpiresAt?: number;
	/** Renews the ID token when the IdP granted offline access. */
	readonly refreshToken?: string;
}

export interface McpEnterpriseManagedAuthOptions {
	readonly idp: {
		/** IdP issuer for metadata discovery; `tokenEndpoint` wins when both are set. */
		readonly issuer?: string | URL;
		readonly tokenEndpoint?: string | URL;
		readonly clientId: string;
		readonly clientSecret?: string;
		readonly tokens: McpIdpTokens;
	};
	/** The client registered at the MCP server's authorization server. */
	readonly client: {
		readonly clientId: string;
		readonly clientSecret: string;
		readonly clientName?: string;
		readonly expectedIssuer?: string;
	};
	/** Scopes requested for the MCP server. */
	readonly scope?: string | readonly string[];
	readonly fetch?: FetchLike;
	/** Re-reads the stored IdP tokens before every assertion (another process may have rotated them). */
	readonly reloadIdpTokens?: () => MaybePromise<McpIdpTokens | undefined>;
	/** Persists rotated IdP tokens after a successful ID-token refresh. */
	readonly onIdpTokensRefreshed?: (tokens: McpIdpTokens) => MaybePromise<void>;
	/** Refresh the ID token when it expires within this window (ms). Default: 60 000. */
	readonly refreshBufferMs?: number;
	readonly now?: () => number;
}

/**
 * Builds the SDK `CrossAppAccessProvider` for enterprise-managed authorization: the user signed
 * in once at the enterprise IdP, and access tokens for the MCP server are obtained without
 * further interaction by exchanging the ID token for an ID-JAG at the IdP (RFC 8693) and the
 * ID-JAG for an access token at the MCP authorization server (RFC 7523). The SDK drives both
 * exchanges; this builder supplies the assertion callback and keeps the ID token fresh through
 * the IdP refresh token. Connections that use it advertise
 * {@link MCP_ENTERPRISE_MANAGED_AUTH_EXTENSION} automatically.
 */
export function enterpriseManagedAuth(
	options: McpEnterpriseManagedAuthOptions,
): CrossAppAccessProvider {
	if (options.idp.issuer === undefined && options.idp.tokenEndpoint === undefined) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			"enterpriseManagedAuth requires idp.issuer or idp.tokenEndpoint.",
		);
	}
	const bufferMs = options.refreshBufferMs ?? 60_000;
	const now = options.now ?? Date.now;
	const scope = normalizeScope(options.scope);
	let current = options.idp.tokens;
	let tokenEndpoint =
		options.idp.tokenEndpoint === undefined ? undefined : String(options.idp.tokenEndpoint);

	const resolveTokenEndpoint = async (fetchFn: FetchLike | undefined): Promise<string> => {
		if (tokenEndpoint !== undefined) return tokenEndpoint;
		const metadata = await discoverAuthorizationServerMetadata(options.idp.issuer as string | URL, {
			...(fetchFn === undefined ? {} : { fetchFn }),
		});
		if (metadata?.token_endpoint === undefined) {
			throw new KmcpError(
				KMCP_ERROR_CODES.OPERATION_FAILED,
				`The enterprise IdP at ${String(options.idp.issuer)} exposes no token endpoint.`,
			);
		}
		tokenEndpoint = assertSecureTokenEndpoint(metadata.token_endpoint).href;
		return tokenEndpoint;
	};

	const validIdToken = async (fetchFn: FetchLike | undefined): Promise<string> => {
		const expiresAt = current.idTokenExpiresAt ?? jwtExpiresAt(current.idToken);
		if (expiresAt === undefined || expiresAt * 1000 - now() > bufferMs) return current.idToken;
		if (current.refreshToken === undefined) {
			throw new KmcpError(
				KMCP_ERROR_CODES.AUTH_FORBIDDEN,
				"The enterprise SSO session has expired and the IdP issued no refresh token; sign in at the IdP again.",
			);
		}
		current = await refreshIdpTokens({
			tokenEndpoint: await resolveTokenEndpoint(fetchFn),
			clientId: options.idp.clientId,
			...(options.idp.clientSecret === undefined ? {} : { clientSecret: options.idp.clientSecret }),
			refreshToken: current.refreshToken,
			...(fetchFn === undefined ? {} : { fetch: fetchFn }),
		});
		await options.onIdpTokensRefreshed?.(current);
		return current.idToken;
	};

	return new CrossAppAccessProvider({
		assertion: async (ctx) => {
			const reloaded = await options.reloadIdpTokens?.();
			if (reloaded !== undefined) current = reloaded;
			const fetchFn = ctx.fetchFn ?? options.fetch;
			const idToken = await validIdToken(fetchFn);
			const requested = ctx.scope ?? scope;
			const grantOptions = {
				audience: ctx.authorizationServerUrl,
				resource: ctx.resourceUrl,
				idToken,
				clientId: options.idp.clientId,
				...(options.idp.clientSecret === undefined
					? {}
					: { clientSecret: options.idp.clientSecret }),
				...(requested === undefined ? {} : { scope: requested }),
				fetchFn,
			};
			const result =
				tokenEndpoint !== undefined
					? await requestJwtAuthorizationGrant({ ...grantOptions, tokenEndpoint })
					: await discoverAndRequestJwtAuthGrant({
							...grantOptions,
							idpUrl: options.idp.issuer as string | URL,
						});
			return result.jwtAuthGrant;
		},
		clientId: options.client.clientId,
		clientSecret: options.client.clientSecret,
		...(options.client.clientName === undefined ? {} : { clientName: options.client.clientName }),
		...(options.client.expectedIssuer === undefined
			? {}
			: { expectedIssuer: options.client.expectedIssuer }),
		...(options.fetch === undefined ? {} : { fetchFn: options.fetch }),
	});
}

export interface McpRefreshIdpTokensOptions {
	readonly tokenEndpoint: string | URL;
	readonly clientId: string;
	readonly clientSecret?: string;
	readonly refreshToken: string;
	readonly fetch?: FetchLike;
}

/** Renews the OIDC ID token at the IdP with `grant_type=refresh_token` (HTTP Basic when confidential). */
export async function refreshIdpTokens(options: McpRefreshIdpTokensOptions): Promise<McpIdpTokens> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: options.refreshToken,
		client_id: options.clientId,
	});
	const response = await postForm(
		options.tokenEndpoint,
		body,
		options.clientId,
		options.clientSecret,
		options.fetch,
	);
	if (!response.ok) {
		const status = response.status;
		await response.text().catch(() => undefined);
		throw new KmcpError(
			status === 400 || status === 401
				? KMCP_ERROR_CODES.AUTH_FORBIDDEN
				: KMCP_ERROR_CODES.OPERATION_FAILED,
			status === 400 || status === 401
				? "The enterprise IdP refresh token is invalid or expired; sign in at the IdP again."
				: `The enterprise IdP refused to renew the ID token (HTTP ${status}).`,
		);
	}
	const parsed = (await response.json()) as { id_token?: unknown; refresh_token?: unknown };
	if (typeof parsed.id_token !== "string" || parsed.id_token.length === 0) {
		throw new KmcpError(
			KMCP_ERROR_CODES.OPERATION_FAILED,
			"The enterprise IdP returned no ID token on refresh; sign in at the IdP again.",
		);
	}
	const expiresAt = jwtExpiresAt(parsed.id_token);
	return Object.freeze({
		idToken: parsed.id_token,
		...(expiresAt === undefined ? {} : { idTokenExpiresAt: expiresAt }),
		refreshToken:
			typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0
				? parsed.refresh_token
				: options.refreshToken,
	});
}

/** Default OIDC scopes for the IdP sign-in: identity claims plus offline access for a refresh token. */
export const MCP_DEFAULT_IDP_SCOPE = "openid profile email offline_access";

export interface McpIdpAuthorizationOptions {
	/** The enterprise IdP issuer (must serve OIDC or RFC 8414 discovery). */
	readonly issuer: string | URL;
	readonly clientId: string;
	readonly clientSecret?: string;
	/** The loopback (or app) `redirect_uri` registered for the IdP client. */
	readonly redirectUrl: string | URL;
	/** Default: {@link MCP_DEFAULT_IDP_SCOPE}. */
	readonly scope?: string | readonly string[];
	/** Hands the authorization URL to the host; kmcp never opens a browser itself. */
	readonly onRedirect: (url: URL) => MaybePromise<void>;
	/** Resolves with the callback query once the user agent returns. */
	readonly waitForCallback: () => Promise<URLSearchParams>;
	readonly fetch?: FetchLike;
}

export interface McpIdpAuthorizationResult {
	readonly tokens: McpIdpTokens;
	readonly tokenEndpoint: string;
	/** Unverified, display-only claims of the ID token. */
	readonly claims: McpJwtClaims;
}

/**
 * Runs the one-time OIDC sign-in at the enterprise IdP (authorization code + PKCE S256, `state`,
 * `nonce`) and exchanges the code for an ID token (and, with offline access, a refresh token).
 * Feed the result to {@link enterpriseManagedAuth}. Runtime-neutral: PKCE uses WebCrypto.
 */
export async function authorizeEnterpriseIdp(
	options: McpIdpAuthorizationOptions,
): Promise<McpIdpAuthorizationResult> {
	const metadata = await discoverAuthorizationServerMetadata(options.issuer, {
		...(options.fetch === undefined ? {} : { fetchFn: options.fetch }),
	});
	const authorizationEndpoint = metadata?.authorization_endpoint;
	const tokenEndpoint = metadata?.token_endpoint;
	if (typeof authorizationEndpoint !== "string" || typeof tokenEndpoint !== "string") {
		throw new KmcpError(
			KMCP_ERROR_CODES.OPERATION_FAILED,
			`Could not discover the authorization and token endpoints of the enterprise IdP at ${String(options.issuer)}.`,
		);
	}
	const verifier = randomToken(32);
	const challenge = encodeBase64Url(
		new Uint8Array(
			await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
		),
	);
	const state = randomToken(16);
	const nonce = randomToken(16);
	const redirectUri = String(options.redirectUrl);
	const scope = normalizeScope(options.scope) ?? MCP_DEFAULT_IDP_SCOPE;
	const authorizationUrl = new URL(authorizationEndpoint);
	if (!isSecureOrLoopback(authorizationUrl)) {
		throw new KmcpError(
			KMCP_ERROR_CODES.AUTH_FORBIDDEN,
			`The IdP authorization endpoint must use https (or http on loopback); got '${authorizationUrl.origin}'.`,
		);
	}
	authorizationUrl.searchParams.set("response_type", "code");
	authorizationUrl.searchParams.set("client_id", options.clientId);
	authorizationUrl.searchParams.set("redirect_uri", redirectUri);
	authorizationUrl.searchParams.set("scope", scope);
	authorizationUrl.searchParams.set("state", state);
	authorizationUrl.searchParams.set("nonce", nonce);
	authorizationUrl.searchParams.set("code_challenge", challenge);
	authorizationUrl.searchParams.set("code_challenge_method", "S256");
	await options.onRedirect(authorizationUrl);

	const params = await options.waitForCallback();
	const error = params.get("error");
	if (error !== null) {
		throw new KmcpError(
			KMCP_ERROR_CODES.AUTH_FORBIDDEN,
			`The enterprise IdP refused the sign-in: ${bounded(params.get("error_description") ?? error)}`,
		);
	}
	if (params.get("state") !== state) {
		throw new KmcpError(
			KMCP_ERROR_CODES.AUTH_STATE_MISMATCH,
			"The enterprise IdP callback state does not match the value issued for this sign-in.",
		);
	}
	const code = params.get("code");
	if (code === null || code.length === 0) {
		throw new KmcpError(
			KMCP_ERROR_CODES.AUTH_FORBIDDEN,
			"The enterprise IdP callback carried no authorization code.",
		);
	}
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		client_id: options.clientId,
		code_verifier: verifier,
	});
	const response = await postForm(
		tokenEndpoint,
		body,
		options.clientId,
		options.clientSecret,
		options.fetch,
	);
	if (!response.ok) {
		await response.text().catch(() => undefined);
		throw new KmcpError(
			KMCP_ERROR_CODES.AUTH_FORBIDDEN,
			`The enterprise IdP rejected the authorization code exchange (HTTP ${response.status}).`,
		);
	}
	const parsed = (await response.json()) as { id_token?: unknown; refresh_token?: unknown };
	if (typeof parsed.id_token !== "string" || parsed.id_token.length === 0) {
		throw new KmcpError(
			KMCP_ERROR_CODES.OPERATION_FAILED,
			`The enterprise IdP returned no ID token; make sure the client is an OpenID Connect client and the scope includes 'openid' (requested: '${scope}').`,
		);
	}
	const claims: McpJwtClaims = decodeJwtClaims(parsed.id_token) ?? Object.freeze({});
	// OIDC Core §3.1.3.7: a nonce was sent, so the ID token MUST carry the same one.
	if (claims.nonce !== nonce) {
		throw new KmcpError(
			KMCP_ERROR_CODES.AUTH_STATE_MISMATCH,
			"The enterprise IdP returned an ID token whose nonce does not match this sign-in.",
		);
	}
	const expiresAt = jwtExpiresAt(parsed.id_token);
	return Object.freeze({
		tokens: Object.freeze({
			idToken: parsed.id_token,
			...(expiresAt === undefined ? {} : { idTokenExpiresAt: expiresAt }),
			...(typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0
				? { refreshToken: parsed.refresh_token }
				: {}),
		}),
		tokenEndpoint,
		claims,
	});
}

/** Whether an authorization server explicitly rules out ID-JAGs (absent metadata is not a refusal). */
export async function serverAcceptsIdJag(
	serverUrl: string | URL,
	options: { readonly fetch?: FetchLike } = {},
): Promise<boolean | undefined> {
	let metadata: AuthorizationServerMetadata | undefined;
	try {
		const info = await discoverOAuthServerInfo(oauthServerUrl(serverUrl), {
			...(options.fetch === undefined ? {} : { fetchFn: options.fetch }),
		});
		metadata = info.authorizationServerMetadata;
	} catch {
		return undefined;
	}
	const profiles = (
		metadata as { readonly authorization_grant_profiles_supported?: unknown } | undefined
	)?.authorization_grant_profiles_supported;
	if (!Array.isArray(profiles)) return undefined;
	return profiles.includes(MCP_ID_JAG_GRANT_PROFILE);
}

function randomToken(bytes: number): string {
	const buffer = new Uint8Array(bytes);
	globalThis.crypto.getRandomValues(buffer);
	return encodeBase64Url(buffer);
}

/** `https:` anywhere, or `http:` on a loopback host (the same rule the SDK applies to token endpoints). */
function isSecureOrLoopback(url: URL): boolean {
	if (url.protocol === "https:") return true;
	if (url.protocol !== "http:") return false;
	const host = url.hostname;
	return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/**
 * RFC 6749 §2.3.1 `client_secret_basic`: both halves form-urlencoded, then the UTF-8 bytes
 * base64-encoded — a secret containing `:` or non-ASCII survives, where `btoa` on the raw string
 * would throw or split it.
 */
function basicAuthorization(clientId: string, clientSecret: string): string {
	const credentials = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
	return `Basic ${encodeBase64(new TextEncoder().encode(credentials))}`;
}

async function postForm(
	endpoint: string | URL,
	body: URLSearchParams,
	clientId: string,
	clientSecret: string | undefined,
	fetchFn: FetchLike | undefined,
): Promise<Response> {
	// Codes, verifiers, refresh tokens and client secrets travel in this body: never in the clear.
	const target = assertSecureTokenEndpoint(endpoint);
	const headers: Record<string, string> = {
		"content-type": "application/x-www-form-urlencoded",
		accept: "application/json",
	};
	if (clientSecret !== undefined)
		headers.authorization = basicAuthorization(clientId, clientSecret);
	const send = fetchFn ?? ((url, init) => globalThis.fetch(url, init));
	return send(target, { method: "POST", headers, body: body.toString() });
}

// ---------------------------------------------------------------------------------------------
// Pre-connection auth probe
// ---------------------------------------------------------------------------------------------

/**
 * A grant type an authorization server advertises in `grant_types_supported`, carried through
 * verbatim. The named members are the ones a host is likely to branch on; any other RFC 6749 §4
 * identifier — including an `urn:ietf:params:oauth:grant-type:` URN — stays a plain string.
 */
export type McpOAuthGrantType =
	| "authorization_code"
	| "client_credentials"
	| "implicit"
	| "refresh_token"
	| "urn:ietf:params:oauth:grant-type:device_code"
	| "urn:ietf:params:oauth:grant-type:jwt-bearer"
	| "urn:ietf:params:oauth:grant-type:token-exchange"
	| (string & {});

/** How a client gets a `client_id` from the authorization server the probe found. */
export type McpOAuthRegistrationSupport =
	/** RFC 7591 Dynamic Client Registration: the server advertises a `registration_endpoint`. */
	| "dynamic"
	/** SEP-991 Client ID Metadata Documents: pass `clientMetadataUrl` instead of registering. */
	| "cimd"
	/** Neither: only clients the authorization server already knows are accepted. */
	| "preregistered-only"
	/** Authorization-server metadata could not be read, so registration support is unknown. */
	| "unknown";

/** Fields every probe outcome carries, whatever the verdict. */
export interface McpServerAuthProbeCommon {
	/** The probed endpoint, normalized (`new URL(serverUrl).href`). */
	readonly serverUrl: string;
	/** The status of the response the verdict was read from; absent when no response arrived. */
	readonly httpStatus?: number;
	/** The `mcp-protocol-version` response header, when the server sent one. */
	readonly protocolVersionHeader?: string;
	/** Whether any response carried an `mcp-session-id`. Absent when no response arrived at all. */
	readonly sessionful?: boolean;
}

/** The server answered without an authorization challenge: connect with no provider. */
export interface McpServerAuthProbeOpen extends McpServerAuthProbeCommon {
	readonly kind: "open";
}

/** The server answered `401` with a `Bearer` challenge: an OAuth 2.1 flow is required. */
export interface McpServerAuthProbeOAuth extends McpServerAuthProbeCommon {
	readonly kind: "oauth";
	/** The `resource_metadata` URL the challenge pointed at, when it carried one (RFC 9728 §5.1). */
	readonly resourceMetadataUrl?: string;
	/** RFC 9728 protected-resource metadata, when the resource server publishes it. */
	readonly resourceMetadata?: OAuthProtectedResourceMetadata;
	/**
	 * The authorization servers to choose from. Falls back to the MCP server's own origin — the
	 * same last resort the SDK's discovery takes — when no protected-resource metadata was found.
	 */
	readonly authorizationServers: readonly string[];
	/** RFC 8414 / OIDC Discovery metadata of `authorizationServers[0]`, when it could be read. */
	readonly authorizationServerMetadata?: AuthorizationServerMetadata;
	/** The challenge's `scope` unioned with the advertised `scopes_supported`. */
	readonly scopes?: readonly string[];
	/**
	 * `grant_types_supported`, or RFC 8414 §2's default of `authorization_code` + `implicit` when
	 * the metadata was read but omitted the field. Empty when no metadata could be read.
	 */
	readonly grants: readonly McpOAuthGrantType[];
	readonly registration: McpOAuthRegistrationSupport;
	/** MCP extension / grant-profile identifiers advertised by either metadata document. */
	readonly extensions?: readonly string[];
}

/** The server answered `401` with a challenge kmcp cannot drive (`Basic`, or a custom scheme). */
export interface McpServerAuthProbeBearer extends McpServerAuthProbeCommon {
	readonly kind: "bearer";
	/** The challenge's auth-scheme token, bounded (`Basic`, `Negotiate`, ...). */
	readonly scheme: string;
	readonly realm?: string;
}

/** The endpoint answered, but not like an MCP Streamable HTTP endpoint. */
export interface McpServerAuthProbeNotMcp extends McpServerAuthProbeCommon {
	readonly kind: "not-mcp";
	readonly httpStatus: number;
	/** A bounded, host-facing explanation of what the endpoint answered instead. */
	readonly reason: string;
	/** The transport worth trying, when the answers point at one. */
	readonly suggestedTransport?: "sse" | "streamable-http";
}

/** No HTTP response arrived: DNS, connection, TLS, or the probe's own deadline. */
export interface McpServerAuthProbeUnreachable extends McpServerAuthProbeCommon {
	readonly kind: "unreachable";
	/** `ECONNREFUSED`, `ENOTFOUND`, `TimeoutError`, ... — a stable code, never server text. */
	readonly code: string;
}

/** The endpoint redirected to another origin; the probe refuses to follow it. */
export interface McpServerAuthProbeRedirect extends McpServerAuthProbeCommon {
	readonly kind: "redirect";
	readonly location: string;
}

/** Any other status: the endpoint is reachable but said nothing a host can act on. */
export interface McpServerAuthProbeError extends McpServerAuthProbeCommon {
	readonly kind: "error";
	readonly httpStatus: number;
}

export type McpServerAuthProbe =
	| McpServerAuthProbeOpen
	| McpServerAuthProbeOAuth
	| McpServerAuthProbeBearer
	| McpServerAuthProbeNotMcp
	| McpServerAuthProbeUnreachable
	| McpServerAuthProbeRedirect
	| McpServerAuthProbeError;

export interface McpProbeServerAuthOptions {
	readonly fetch?: FetchLike;
	/** Whole-probe budget, including discovery. Default 10 000 ms. */
	readonly timeoutMs?: number;
	/** The `protocolVersion` the probe's `initialize` body claims. Defaults to kmcp's modern pin. */
	readonly protocolVersion?: string;
	/** Extra request headers (a tenant hint, a proxy token) merged over the probe's own. */
	readonly headers?: Readonly<Record<string, string>>;
	/** Follow an inconclusive `POST` with a `GET` to spot the deprecated SSE transport. Default `true`. */
	readonly probeGet?: boolean;
	/** Security-weakening opt-out of the RFC 8414 issuer-echo check during discovery. */
	readonly skipIssuerMetadataValidation?: boolean;
}

const PROBE_DEFAULT_TIMEOUT_MS = 10_000;
/** Same-origin hops the probe will follow before giving up and reporting the redirect. */
const PROBE_MAX_REDIRECTS = 3;
const PROBE_REDIRECT_STATUSES = Object.freeze(new Set([301, 302, 303, 307, 308]));
const PROBE_HTML = /^\s*text\/html\b/i;
const PROBE_EVENT_STREAM = /^\s*text\/event-stream\b/i;
const PROBE_SSE_PATH = /\/sse\/?$/;
const PROBE_REALM = /realm\s*=\s*(?:"([^"]*)"|([^\s,]+))/i;
/** RFC 8414 §2: `grant_types_supported` defaults to these when the metadata omits it. */
const PROBE_DEFAULT_GRANTS: readonly McpOAuthGrantType[] = Object.freeze([
	"authorization_code",
	"implicit",
]);
/** Loose metadata fields that carry MCP extension / grant-profile identifiers. */
const PROBE_EXTENSION_FIELDS: readonly string[] = Object.freeze([
	"extensions",
	"mcp_extensions",
	"authorization_grant_profiles_supported",
]);

/**
 * Asks an HTTP MCP endpoint what it wants, before any connection exists, so a host can decide
 * whether to show a login button, which grant to drive, and which transport to open.
 *
 * One `POST` carrying an `initialize`-shaped body settles it in the common case (the answer's
 * *body* is never inspected — only its status and headers); a `GET` follows only when the `POST`
 * was inconclusive, to tell the deprecated HTTP+SSE transport from a wrong URL. Redirects are not
 * followed across origins. Discovery for the OAuth verdict runs the SDK's own RFC 9728 / RFC 8414
 * helpers, so what the probe reports is exactly what a real connection would find.
 *
 * Never throws for anything the server did — every server-side condition is one of the
 * {@link McpServerAuthProbe} outcomes. Only invalid input throws.
 *
 * @throws {KmcpError} `INVALID_DEFINITION` for a non-`http(s)` URL or a non-positive `timeoutMs`.
 */
export async function probeServerAuth(
	serverUrl: string | URL,
	options: McpProbeServerAuthOptions = {},
): Promise<McpServerAuthProbe> {
	const target = probeTarget(serverUrl);
	const timeoutMs = options.timeoutMs ?? PROBE_DEFAULT_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`probeServerAuth() needs a positive, finite timeoutMs; received ${String(options.timeoutMs)}.`,
		);
	}
	// One deadline for the whole probe — the POST, the GET fallback, and every discovery hop.
	const signal = AbortSignal.timeout(timeoutMs);
	const raw =
		options.fetch ?? ((url: string | URL, init?: RequestInit) => globalThis.fetch(url, init));
	// A mock or a non-conforming `fetch` may ignore `signal`, so the deadline is also raced here.
	const send: FetchLike = (url, init) => withDeadline(raw(url, { ...init, signal }), signal);
	const seen: ProbeSignals = { protocolVersionHeader: undefined, sessionful: false };

	let current = target;
	let response: Response;
	for (let hop = 0; ; hop += 1) {
		try {
			response = await send(current, {
				method: "POST",
				headers: { "content-type": "application/json", ...probeHeaders(options) },
				body: probeBody(options),
				redirect: "manual",
			});
		} catch (error) {
			return Object.freeze({
				kind: "unreachable",
				code: probeNetworkCode(error),
				...probeBase(target, seen, false),
			});
		}
		recordProbeSignals(seen, response);
		// A browser hides a manual redirect behind an opaque response: report it, do not follow.
		if (response.type === "opaqueredirect") {
			await drainResponse(response);
			return Object.freeze({
				kind: "redirect",
				location: current.href,
				...probeBase(target, seen, true),
			});
		}
		if (!PROBE_REDIRECT_STATUSES.has(response.status)) break;
		const location = response.headers.get("location");
		const status = response.status;
		await drainResponse(response);
		const next = resolveLocation(location, current);
		if (next === undefined) {
			return Object.freeze({ kind: "error", ...probeBase(target, seen, true), httpStatus: status });
		}
		if (next.origin !== current.origin || hop + 1 >= PROBE_MAX_REDIRECTS) {
			return Object.freeze({
				kind: "redirect",
				location: next.href,
				...probeBase(target, seen, true),
				httpStatus: status,
			});
		}
		current = next;
	}

	const status = response.status;
	const contentType = response.headers.get("content-type") ?? "";
	if (status === 401) {
		const challenge = response.headers.get("www-authenticate");
		const scheme = challengeScheme(challenge);
		if (scheme !== undefined && scheme.toLowerCase() !== "bearer") {
			const realm = PROBE_REALM.exec(challenge ?? "");
			await drainResponse(response);
			const value = realm?.[1] ?? realm?.[2];
			return Object.freeze({
				kind: "bearer",
				scheme: bounded(scheme, 64),
				...(value === undefined ? {} : { realm: bounded(value, 200) }),
				...probeBase(target, seen, true),
				httpStatus: status,
			});
		}
		if (scheme !== undefined) {
			const params = extractWWWAuthenticateParams(response);
			await drainResponse(response);
			return await probeOAuth(target, seen, status, params, send, options);
		}
	}
	await drainResponse(response);
	if (PROBE_HTML.test(contentType)) {
		return await probeNotMcp(
			target,
			seen,
			status,
			`The endpoint answered '${bounded(contentType, 80)}': an HTML page, not an MCP endpoint.`,
			send,
			options,
		);
	}
	if (status === 404 || status === 405 || status === 406) {
		return await probeNotMcp(target, seen, status, notMcpReason(status), send, options);
	}
	if (status >= 200 && status < 300) {
		return Object.freeze({
			kind: "open",
			...probeBase(target, seen, true),
			httpStatus: status,
		});
	}
	return Object.freeze({ kind: "error", ...probeBase(target, seen, true), httpStatus: status });
}

/** What a host should do about a probe: which kmcp auth helper to reach for, and whether a user is needed. */
export interface McpAuthSuggestion {
	/**
	 * `authorization_code` calls for an {@link McpOAuthClientProvider}; `client_credentials` for
	 * {@link clientCredentialsAuth}; `none` means connect without a provider (or that kmcp cannot
	 * drive what the server asked for).
	 */
	readonly grant: "authorization_code" | "client_credentials" | "none";
	/** Whether a user must be sent through a browser for this grant. */
	readonly interactive: boolean;
	/** A bounded, host-facing sentence explaining the choice. */
	readonly note: string;
}

/** Turns a {@link probeServerAuth} outcome into the auth decision a host has to make. */
export function suggestAuth(probe: McpServerAuthProbe): McpAuthSuggestion {
	switch (probe.kind) {
		case "open":
			return Object.freeze({
				grant: "none" as const,
				interactive: false,
				note: "The server answered without an authorization challenge; connect with no auth provider.",
			});
		case "oauth": {
			const interactiveOffered =
				probe.grants.length === 0 || probe.grants.includes("authorization_code");
			const machineOnly = !interactiveOffered && probe.grants.includes("client_credentials");
			if (machineOnly) {
				return Object.freeze({
					grant: "client_credentials" as const,
					interactive: false,
					note: `The authorization server offers no authorization_code grant, only client_credentials; use clientCredentialsAuth(). ${registrationNote(probe.registration)}`,
				});
			}
			return Object.freeze({
				grant: "authorization_code" as const,
				interactive: true,
				note: `${
					probe.grants.length === 0
						? "The server requires OAuth but its metadata could not be read; assume the interactive authorization_code grant"
						: "The authorization server offers the authorization_code grant"
				}; use McpOAuthClientProvider and send the user through a browser. ${registrationNote(probe.registration)}`,
			});
		}
		case "bearer":
			return Object.freeze({
				grant: "none" as const,
				interactive: false,
				note: `The server asked for a '${probe.scheme}' credential, which is not OAuth; supply the Authorization header yourself via the connection's headers.`,
			});
		case "not-mcp":
			return Object.freeze({
				grant: "none" as const,
				interactive: false,
				note: `${probe.reason}${
					probe.suggestedTransport === "sse"
						? " Try sseConnection() against this URL."
						: probe.suggestedTransport === "streamable-http"
							? " Try httpConnection() against the server's Streamable HTTP endpoint."
							: " Check the URL before offering a sign-in."
				}`,
			});
		case "unreachable":
			return Object.freeze({
				grant: "none" as const,
				interactive: false,
				note: `The endpoint could not be reached (${probe.code}); nothing can be decided about auth until it answers.`,
			});
		case "redirect":
			return Object.freeze({
				grant: "none" as const,
				interactive: false,
				note: `The endpoint redirects to another origin (${probe.location}); probe that URL instead of authorizing against this one.`,
			});
		case "error":
			return Object.freeze({
				grant: "none" as const,
				interactive: false,
				note: `The endpoint answered HTTP ${probe.httpStatus} with no authorization challenge; retry later rather than prompting for a sign-in.`,
			});
	}
}

interface ProbeSignals {
	protocolVersionHeader: string | undefined;
	sessionful: boolean;
}

interface ProbeBase {
	readonly serverUrl: string;
	readonly protocolVersionHeader?: string;
	readonly sessionful?: boolean;
}

/** Accepts only an absolute `http:`/`https:` URL — every other scheme is a caller mistake. */
function probeTarget(serverUrl: string | URL): URL {
	let url: URL;
	try {
		url = typeof serverUrl === "string" ? new URL(serverUrl) : new URL(serverUrl.href);
	} catch {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`probeServerAuth() needs an absolute http(s) URL; '${bounded(String(serverUrl), 120)}' is not a URL.`,
		);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`probeServerAuth() only probes http(s) endpoints; '${bounded(url.protocol, 32)}' is not one.`,
		);
	}
	return url;
}

function probeBase(target: URL, seen: ProbeSignals, responded: boolean): ProbeBase {
	return {
		serverUrl: target.href,
		...(seen.protocolVersionHeader === undefined
			? {}
			: { protocolVersionHeader: seen.protocolVersionHeader }),
		...(responded ? { sessionful: seen.sessionful } : {}),
	};
}

function probeHeaders(options: McpProbeServerAuthOptions): Record<string, string> {
	return { accept: "application/json, text/event-stream", ...options.headers };
}

function probeBody(options: McpProbeServerAuthOptions): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id: 0,
		method: "initialize",
		params: {
			protocolVersion: options.protocolVersion ?? MCP_MODERN_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "kmcp-probe", version: "0" },
		},
	});
}

function recordProbeSignals(seen: ProbeSignals, response: Response): void {
	const version = response.headers.get("mcp-protocol-version");
	if (version !== null && version.length > 0 && seen.protocolVersionHeader === undefined) {
		seen.protocolVersionHeader = bounded(version, 64);
	}
	const session = response.headers.get("mcp-session-id");
	if (session !== null && session.length > 0) seen.sessionful = true;
}

function resolveLocation(location: string | null, from: URL): URL | undefined {
	if (location === null || location.length === 0) return undefined;
	try {
		return new URL(location, from);
	} catch {
		return undefined;
	}
}

/** The auth-scheme token of a `WWW-Authenticate` header, or `undefined` when there is no challenge. */
function challengeScheme(header: string | null): string | undefined {
	if (header === null) return undefined;
	const token = header.trim().split(/[\s,]+/, 1)[0];
	return token === undefined || token.length === 0 ? undefined : token;
}

function notMcpReason(status: number): string {
	if (status === 404) return "The endpoint answered HTTP 404: nothing is served at this path.";
	if (status === 405) return "The endpoint answered HTTP 405: it does not accept POST.";
	return "The endpoint answered HTTP 406: it rejected 'application/json, text/event-stream'.";
}

/**
 * Turns an inconclusive answer into a `not-mcp` verdict, following it with one `GET` so an
 * endpoint that streams to `GET` but refuses `POST` is reported as the deprecated SSE transport
 * rather than as a wrong URL.
 */
async function probeNotMcp(
	target: URL,
	seen: ProbeSignals,
	status: number,
	reason: string,
	send: FetchLike,
	options: McpProbeServerAuthOptions,
): Promise<McpServerAuthProbeNotMcp> {
	const looksSse = PROBE_SSE_PATH.test(target.pathname);
	let streams = false;
	let getStatus: number | undefined;
	if (options.probeGet !== false) {
		try {
			const response = await send(target, {
				method: "GET",
				headers: probeHeaders(options),
				redirect: "manual",
			});
			recordProbeSignals(seen, response);
			getStatus = response.status;
			streams =
				response.status < 400 &&
				PROBE_EVENT_STREAM.test(response.headers.get("content-type") ?? "");
			await drainResponse(response);
		} catch {
			// The GET is only ever corroboration; the POST's verdict already stands.
		}
	}
	const suggestedTransport =
		streams || (looksSse && status === 405)
			? ("sse" as const)
			: looksSse && getStatus !== undefined && getStatus >= 400
				? ("streamable-http" as const)
				: undefined;
	const detail = streams
		? " A GET to the same URL returns an event stream, so this is the deprecated HTTP+SSE transport."
		: looksSse && status === 405
			? " The path ends in '/sse', so this is probably the deprecated HTTP+SSE transport."
			: looksSse && suggestedTransport === "streamable-http"
				? " The path ends in '/sse' but nothing streams there; the server's Streamable HTTP endpoint is elsewhere."
				: "";
	return Object.freeze({
		kind: "not-mcp",
		reason: bounded(`${reason}${detail}`),
		...(suggestedTransport === undefined ? {} : { suggestedTransport }),
		...probeBase(target, seen, true),
		httpStatus: status,
	});
}

/** Fills in the OAuth verdict by running the SDK's own RFC 9728 and RFC 8414 discovery. */
async function probeOAuth(
	target: URL,
	seen: ProbeSignals,
	status: number,
	params: ReturnType<typeof extractWWWAuthenticateParams>,
	send: FetchLike,
	options: McpProbeServerAuthOptions,
): Promise<McpServerAuthProbeOAuth> {
	const identity = oauthServerUrl(target);
	let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
	try {
		resourceMetadata = await discoverOAuthProtectedResourceMetadata(
			identity,
			params.resourceMetadataUrl === undefined
				? {}
				: { resourceMetadataUrl: params.resourceMetadataUrl },
			send,
		);
	} catch {
		// RFC 9728 metadata is optional; discovery falls back to the server's own origin below.
	}
	const declared = arrayOfStrings(resourceMetadata?.authorization_servers);
	const authorizationServers = declared.length > 0 ? declared : [String(new URL("/", identity))];
	const primary = authorizationServers[0] ?? identity;
	let authorizationServerMetadata: AuthorizationServerMetadata | undefined;
	try {
		authorizationServerMetadata = await discoverAuthorizationServerMetadata(primary, {
			fetchFn: send,
			...(options.skipIssuerMetadataValidation === undefined
				? {}
				: { skipIssuerValidation: options.skipIssuerMetadataValidation }),
		});
	} catch {
		// A mismatched issuer or an unreadable document leaves the grant list unknown, not fatal.
	}
	const advertised = arrayOfStrings(authorizationServerMetadata?.grant_types_supported);
	const grants: readonly McpOAuthGrantType[] =
		authorizationServerMetadata === undefined
			? []
			: advertised.length > 0
				? Object.freeze(advertised)
				: PROBE_DEFAULT_GRANTS;
	const scopes = uniqueStrings([
		...(normalizeScope(params.scope)?.split(/\s+/) ?? []),
		...arrayOfStrings(
			resourceMetadata?.scopes_supported ?? authorizationServerMetadata?.scopes_supported,
		),
	]);
	const extensions = uniqueStrings([
		...extensionHints(resourceMetadata),
		...extensionHints(authorizationServerMetadata),
	]);
	return Object.freeze({
		kind: "oauth",
		...(params.resourceMetadataUrl === undefined
			? {}
			: { resourceMetadataUrl: params.resourceMetadataUrl.href }),
		...(resourceMetadata === undefined ? {} : { resourceMetadata }),
		authorizationServers: Object.freeze(authorizationServers),
		...(authorizationServerMetadata === undefined ? {} : { authorizationServerMetadata }),
		...(scopes.length === 0 ? {} : { scopes: Object.freeze(scopes) }),
		grants,
		registration: registrationSupport(authorizationServerMetadata),
		...(extensions.length === 0 ? {} : { extensions: Object.freeze(extensions) }),
		...probeBase(target, seen, true),
		httpStatus: status,
	});
}

function registrationSupport(
	metadata: AuthorizationServerMetadata | undefined,
): McpOAuthRegistrationSupport {
	if (metadata === undefined) return "unknown";
	// Dynamic registration first: it is what `McpOAuthClientProvider` drives with no configuration.
	const endpoint = metadata.registration_endpoint;
	if (typeof endpoint === "string" && endpoint.length > 0) return "dynamic";
	if (metadata.client_id_metadata_document_supported === true) return "cimd";
	return "preregistered-only";
}

function extensionHints(metadata: object | undefined): string[] {
	if (metadata === undefined) return [];
	const loose = metadata as Record<string, unknown>;
	const hints: string[] = [];
	for (const field of PROBE_EXTENSION_FIELDS) {
		for (const hint of arrayOfStrings(loose[field])) hints.push(bounded(hint, 200));
	}
	return hints;
}

function arrayOfStrings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
		: [];
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values.filter((value) => value.length > 0))];
}

function registrationNote(registration: McpOAuthRegistrationSupport): string {
	switch (registration) {
		case "dynamic":
			return "It accepts Dynamic Client Registration, so no clientId is needed.";
		case "cimd":
			return "It accepts a Client ID Metadata Document, so pass clientMetadataUrl instead of registering.";
		case "preregistered-only":
			return "It registers no clients dynamically, so a pre-registered clientId is required.";
		case "unknown":
			return "Its metadata could not be read, so a pre-registered clientId may be required.";
	}
}

/**
 * Races a request against the probe's deadline. `fetch` honours `signal` on its own, but a caller
 * -supplied `fetch` (a mock, a proxy wrapper) may not, and an unbounded probe would hang a host.
 */
function withDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => {
			signal.removeEventListener("abort", onAbort);
		});
	});
}

/** Releases a response body the probe never reads, so the socket is not held open. */
async function drainResponse(response: Response): Promise<void> {
	try {
		await response.arrayBuffer();
	} catch {
		// Already consumed, or the body errored: nothing left to release either way.
	}
}

const PROBE_NETWORK_CODE =
	/^(E[A-Z]{2,}|EAI_[A-Z]+|UND_ERR_[A-Z_]+|CERT_[A-Z_]+|ERR_TLS_[A-Z_]+|ERR_SSL_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_[A-Z_]+)$/;

/**
 * A stable code for a failure that produced no response. Mirrors the manager's classification —
 * Node system errors, undici codes, TLS failures, and aborts raised as `DOMException`s — without
 * importing it, since `manager.ts` reaches this module through `connection.ts`.
 */
function probeNetworkCode(error: unknown): string {
	let current: unknown = error;
	for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
		if (current instanceof DOMException) {
			if (current.name === "TimeoutError" || current.name === "AbortError") return current.name;
		} else if (current instanceof Error) {
			const code = (current as { readonly code?: unknown }).code;
			if (typeof code === "string" && PROBE_NETWORK_CODE.test(code)) return code;
		}
		current = current instanceof Error ? current.cause : undefined;
	}
	return error instanceof Error ? bounded(error.name, 64) : "UNKNOWN";
}
