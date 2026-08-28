import {
	type AuthInfo,
	type AuthMetadataOptions,
	bearerAuthChallengeResponse,
	checkResourceAllowed,
	getOAuthProtectedResourceMetadataUrl,
	type McpHandlerRequestOptions,
	type McpHttpHandler,
	OAuthError,
	OAuthErrorCode,
	type OAuthTokenVerifier,
	oauthMetadataResponse,
	requireBearerAuth,
} from "@modelcontextprotocol/server";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import type { MaybePromise } from "../internal/value.ts";
import { assertAuthInfo, sha256Hex } from "./verifiers.ts";

/**
 * A fetch-shaped authentication gate: resolves to the verified `AuthInfo`, or to the ready-to-send
 * refusal `Response`. Structurally the SDK's `requireBearerAuth` return type, so the raw SDK gate
 * is accepted wherever a gate is.
 */
export type McpAuthGate = (request: Request) => MaybePromise<AuthInfo | Response>;

/** Thrown by a `McpRequestVerifier` to refuse an authenticated-but-unauthorized request with 403. */
export class McpAuthorizationError extends KmcpError {
	constructor(message: string, options?: ErrorOptions) {
		super(KMCP_ERROR_CODES.AUTH_FORBIDDEN, message, options);
		this.name = "McpAuthorizationError";
	}
}

/**
 * Request-level identity for trusted-proxy deployments, where the proxy authenticates the caller
 * and forwards the resolved identity as headers. Headers are forgeable by anyone who can reach the
 * server directly, so provenance is REQUIRED and checked before `verifyRequest` runs. The
 * verifier sees the FULL wire headers (it is the credential-handling code).
 */
export interface McpRequestVerifier {
	readonly trustedProxy:
		| { readonly header: string; readonly secret: string }
		| { readonly assert: (request: Request) => MaybePromise<boolean> };
	/**
	 * Returns the caller's identity. `token` MUST be a stable, non-empty, per-identity value (it
	 * keys cache and rate-limit partitioning); `expiresAt` should be short. Throw
	 * `McpAuthorizationError` for 403, anything else for 401.
	 */
	verifyRequest(request: Request): MaybePromise<AuthInfo>;
}

export interface McpAuthGateOptions {
	/** Bearer-token verifier (see `kmcp/auth`). Exactly one of `verifier` / `requestVerifier`. */
	readonly verifier?: OAuthTokenVerifier;
	readonly requestVerifier?: McpRequestVerifier;
	/**
	 * This server's canonical resource URL (RFC 8707). REQUIRED and static — never derived from the
	 * `Host` header. Tokens whose `resource` does not cover it are refused, and the
	 * `resource_metadata` challenge parameter is derived from it.
	 */
	readonly resourceServerUrl: string | URL;
	readonly requiredScopes?: readonly string[];
	/** When set, the RFC 9728 / RFC 8414 discovery documents are served by the gate. */
	readonly metadata?: Omit<AuthMetadataOptions, "resourceServerUrl">;
	/** Reporting seam for verifier faults (never alters the response). */
	readonly onerror?: (error: unknown, request: Request) => void;
}

/**
 * Composes the SDK natives into one gate: well-known discovery documents (if `metadata`), then
 * bearer verification with scope enforcement, expiry, and RFC 8707 resource binding — or the
 * trusted-proxy request verifier. Clients get opaque reasons; details go to `onerror`.
 */
export function createMcpAuthGate(options: McpAuthGateOptions): McpAuthGate {
	const resourceServerUrl = new URL(options.resourceServerUrl);
	if ((options.verifier === undefined) === (options.requestVerifier === undefined)) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			"createMcpAuthGate requires exactly one of verifier or requestVerifier.",
		);
	}
	const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
	const requiredScopes = [...(options.requiredScopes ?? [])];
	const metadata: AuthMetadataOptions | undefined =
		options.metadata === undefined ? undefined : { ...options.metadata, resourceServerUrl };
	const challengeOptions = { requiredScopes, resourceMetadataUrl };

	const bearer =
		options.verifier === undefined
			? undefined
			: requireBearerAuth({
					verifier: boundVerifier(options.verifier, resourceServerUrl),
					requiredScopes,
					resourceMetadataUrl,
				});
	const proxy = options.requestVerifier;

	return async (request) => {
		if (metadata !== undefined) {
			const document = oauthMetadataResponse(request, metadata);
			if (document !== undefined) return document;
		}
		try {
			if (bearer !== undefined) return await bearer(request);
			if (proxy === undefined) throw new Error("unreachable");
			return await verifyProxiedRequest(proxy, request, requiredScopes);
		} catch (error) {
			options.onerror?.(error, request);
			return bearerAuthChallengeResponse(error, challengeOptions);
		}
	};
}

function boundVerifier(verifier: OAuthTokenVerifier, resourceServerUrl: URL): OAuthTokenVerifier {
	return {
		async verifyAccessToken(token) {
			const authInfo = assertAuthInfo(await verifier.verifyAccessToken(token));
			if (
				authInfo.resource !== undefined &&
				!checkResourceAllowed({
					requestedResource: authInfo.resource,
					configuredResource: resourceServerUrl,
				})
			) {
				throw new OAuthError(OAuthErrorCode.InvalidToken, "invalid_token");
			}
			return authInfo;
		},
	};
}

async function verifyProxiedRequest(
	proxy: McpRequestVerifier,
	request: Request,
	requiredScopes: readonly string[],
): Promise<AuthInfo> {
	if (!(await provenanceHolds(proxy.trustedProxy, request))) {
		throw new OAuthError(OAuthErrorCode.InvalidToken, "invalid_token");
	}
	let authInfo: AuthInfo;
	try {
		authInfo = await proxy.verifyRequest(request);
	} catch (error) {
		if (error instanceof McpAuthorizationError) {
			throw new OAuthError(OAuthErrorCode.InsufficientScope, "insufficient_scope");
		}
		throw new OAuthError(OAuthErrorCode.InvalidToken, "invalid_token");
	}
	if (typeof authInfo.token !== "string" || authInfo.token.length === 0) {
		// Operator bug: an empty token would collapse every principal into one cache/rate partition.
		throw new OAuthError(OAuthErrorCode.ServerError, "server_error");
	}
	assertAuthInfo(authInfo);
	if (requiredScopes.some((scope) => !authInfo.scopes.includes(scope))) {
		throw new OAuthError(OAuthErrorCode.InsufficientScope, "insufficient_scope");
	}
	return authInfo;
}

async function provenanceHolds(
	trustedProxy: McpRequestVerifier["trustedProxy"],
	request: Request,
): Promise<boolean> {
	if ("assert" in trustedProxy) return trustedProxy.assert(request);
	const presented = request.headers.get(trustedProxy.header);
	if (presented === null) return false;
	// Compare digests so the comparison cost does not depend on where the strings diverge.
	return (await sha256Hex(presented)) === (await sha256Hex(trustedProxy.secret));
}

/**
 * Runs `gate` in front of `handler.fetch`. A caller-supplied `authInfo` is DISCARDED (so a forged
 * upstream `req.auth` can never reach the server factory) while `parsedBody` is preserved. The
 * handler's `close`, `notify` and `bus` are carried over unchanged.
 */
export function withMcpAuth(handler: McpHttpHandler, gate: McpAuthGate): McpHttpHandler {
	if (typeof gate !== "function") throw new TypeError("gate must be a function.");
	const fetch = async (request: Request, options?: McpHandlerRequestOptions): Promise<Response> => {
		const auth = await gate(request);
		if (auth instanceof Response) return auth;
		const forwarded: McpHandlerRequestOptions =
			options?.parsedBody === undefined
				? { authInfo: auth }
				: { authInfo: auth, parsedBody: options.parsedBody };
		return handler.fetch(request, forwarded);
	};
	return { ...handler, fetch };
}
