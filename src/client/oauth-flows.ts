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
	PrivateKeyJwtProvider,
	RegistrationRejectedError,
	SdkHttpError,
	StaticPrivateKeyJwtProvider,
	type StoredOAuthTokens,
	UnauthorizedError,
	auth,
	discoverAndRequestJwtAuthGrant,
	discoverAuthorizationServerMetadata,
	discoverOAuthServerInfo,
	requestJwtAuthorizationGrant,
} from "@modelcontextprotocol/client";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import { encodeBase64Url } from "../internal/base64.ts";
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

function bounded(text: string, max = 400): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
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
		const pinned = pinnedDiscoveryState(options.tokenEndpoint);
		provider.discoveryState = () => pinned;
	}
	return provider;
}

/**
 * Discovery state that pins a known token endpoint, bypassing RFC 9728 / RFC 8414 discovery. The
 * authorization endpoint and response types are unused by the client-credentials grant but the
 * SDK's metadata validation requires them.
 */
export function pinnedDiscoveryState(tokenEndpoint: string | URL): OAuthDiscoveryState {
	const endpoint = typeof tokenEndpoint === "string" ? new URL(tokenEndpoint) : tokenEndpoint;
	const origin = endpoint.origin;
	return Object.freeze({
		authorizationServerUrl: origin,
		authorizationServerMetadata: {
			issuer: origin,
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
		tokenEndpoint = metadata.token_endpoint;
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
	if (authorizationUrl.protocol !== "https:" && authorizationUrl.protocol !== "http:") {
		throw new KmcpError(
			KMCP_ERROR_CODES.AUTH_FORBIDDEN,
			`The IdP authorization endpoint uses the unsupported scheme '${authorizationUrl.protocol}'.`,
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
	if (typeof claims.nonce === "string" && claims.nonce !== nonce) {
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

async function postForm(
	endpoint: string | URL,
	body: URLSearchParams,
	clientId: string,
	clientSecret: string | undefined,
	fetchFn: FetchLike | undefined,
): Promise<Response> {
	const headers: Record<string, string> = {
		"content-type": "application/x-www-form-urlencoded",
		accept: "application/json",
	};
	if (clientSecret !== undefined) {
		headers.authorization = `Basic ${globalThis.btoa(`${clientId}:${clientSecret}`)}`;
	}
	const send = fetchFn ?? ((url, init) => globalThis.fetch(url, init));
	return send(endpoint, { method: "POST", headers, body: body.toString() });
}
