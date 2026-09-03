import {
	type FetchLike,
	type OAuthClientInformationContext,
	type OAuthClientMetadata,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
	type StoredOAuthClientInformation,
	type StoredOAuthTokens,
	refreshAuthorization,
	selectResourceURL,
	validateClientMetadataUrl,
} from "@modelcontextprotocol/client";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import { encodeBase64Url } from "../internal/base64.ts";
import { decodeJwtClaims, jwtExpiresAt, type McpJwtClaims } from "./jwt.ts";

/**
 * The persistence port every kmcp OAuth credential read and write goes through.
 *
 * Values are opaque strings; `get` resolves `undefined` for an absent key rather than throwing.
 * Implementations must tolerate concurrent calls.
 */
export interface McpKeyValueStore {
	get(key: string): Promise<string | undefined>;
	set(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

/** Process-local {@link McpKeyValueStore}. Credentials do not survive a restart. */
export class InMemoryKeyValueStore implements McpKeyValueStore {
	readonly #entries = new Map<string, string>();

	async get(key: string): Promise<string | undefined> {
		return this.#entries.get(key);
	}

	async set(key: string, value: string): Promise<void> {
		this.#entries.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.#entries.delete(key);
	}
}

/** Proactive refresh policy for {@link McpOAuthClientProvider}. */
export interface McpOAuthRefreshOptions {
	/** Refresh when the access token expires within this window (ms). Default: 60 000. */
	readonly bufferMs?: number;
	/** Observes a failed proactive refresh. The stale token is still returned; the SDK's 401 path takes over. */
	readonly onError?: (error: unknown) => void;
}

/** The token set as kmcp persists it: the SDK's stored shape plus an absolute expiry. */
export type McpStoredOAuthTokens = StoredOAuthTokens & {
	/** Unix time (seconds) the access token expires, derived from `expires_in` at save time. */
	readonly expires_at?: number;
	/** ISO timestamp of the save (an authorization, an exchange, or a refresh). */
	readonly saved_at?: string;
};

/** A non-secret description of what a provider currently holds. Safe to log or display. */
export interface McpOAuthCredentialStatus {
	readonly serverUrl: string;
	readonly profile?: string;
	readonly issuer?: string;
	readonly clientId?: string;
	readonly hasTokens: boolean;
	readonly hasRefreshToken: boolean;
	readonly tokenType?: string;
	readonly scope?: string;
	/** ISO timestamp the access token expires, when the server reported a lifetime. */
	readonly expiresAt?: string;
	/** ISO timestamp the current token set was stored. */
	readonly savedAt?: string;
	/** Display-only identity claims decoded (unverified) from an OIDC `id_token`. */
	readonly identity?: Readonly<{ subject?: string; email?: string; name?: string }>;
}

/** A provider that can verify the `state` parameter of an authorization callback. */
export interface McpCallbackStateVerifier {
	verifyCallbackState(params: URLSearchParams): Promise<void>;
}

/** Construction options for {@link McpOAuthClientProvider}. */
export interface McpOAuthClientProviderOptions {
	/**
	 * The MCP server this provider authorizes against. Required: it is the explicit namespace for
	 * every store key that is not bound to a resolved authorization-server issuer.
	 */
	readonly serverUrl: string | URL;
	/** The `redirect_uri` registered for this client and used to end the authorization leg. */
	readonly redirectUrl: string | URL;
	/**
	 * A pre-registered `client_id`. When set, Dynamic Client Registration is never used and the
	 * provider carries no `saveClientInformation` method at all, exactly like the SDK's own static
	 * providers.
	 */
	readonly clientId?: string;
	/** A pre-registered `client_secret`. Selects `client_secret_post` client authentication. */
	readonly clientSecret?: string;
	/** `client_name` advertised during Dynamic Client Registration. Default: `"kmcp"`. */
	readonly clientName?: string;
	/** Extra RFC 7591 metadata (`client_uri`, `logo_uri`, `tos_uri`, ...) merged into the registration document. */
	readonly clientMetadata?: Partial<OAuthClientMetadata>;
	/** Requested scopes, as a space-delimited string or a list of scope tokens. */
	readonly scope?: string | readonly string[];
	/**
	 * SEP-991 Client ID Metadata Document URL. When the authorization server advertises
	 * `client_id_metadata_document_supported`, the SDK uses this URL as the `client_id` and skips
	 * registration. Validated eagerly by the constructor.
	 */
	readonly clientMetadataUrl?: string;
	/**
	 * The authorization-server `issuer` the pre-registered {@link clientId} belongs to. Stamped
	 * onto the returned client information so the SDK's SEP-2352 check refuses to present the
	 * credential to any other authorization server. Ignored without {@link clientId}.
	 */
	readonly expectedIssuer?: string;
	/** Credential persistence. Default: a fresh {@link InMemoryKeyValueStore}. */
	readonly store?: McpKeyValueStore;
	/**
	 * A named credential set. Two providers over one store with different profiles never share
	 * tokens, client registrations, or flow state, so one host can hold several identities for the
	 * same server (or the same authorization server). Default: the unnamed profile.
	 */
	readonly profile?: string;
	/**
	 * Hands the authorization URL to the host application. Required: kmcp never launches a
	 * browser, prints to a terminal, or otherwise decides how a user is prompted.
	 */
	readonly onRedirect: (url: URL) => void | Promise<void>;
	/**
	 * Refresh the access token BEFORE it expires (through the SDK's `refreshAuthorization`), so a
	 * request never has to fail with 401 first. Default: on, with a 60 s buffer. `false` leaves
	 * refresh entirely to the transport's 401 path.
	 */
	readonly refresh?: McpOAuthRefreshOptions | false;
	/** `fetch` used for proactive refresh. Default: the global `fetch`. */
	readonly fetch?: FetchLike;
	/**
	 * Generate an OAuth `state` parameter for every authorization request and verify it on the
	 * callback (see {@link McpOAuthClientProvider.verifyCallbackState}). Default: `true`. Some
	 * authorization servers require `state` even though OAuth 2.1 only recommends it.
	 */
	readonly state?: boolean;
	/** Clock for expiry decisions (ms since the Unix epoch). Default: `Date.now`. */
	readonly now?: () => number;
}

/**
 * An interactive `authorization_code` + PKCE {@link OAuthClientProvider} for the official SDK
 * transports.
 *
 * The SDK owns the protocol: this class persists what `auth()` hands it, verifies the callback
 * `state` the SDK deliberately leaves to hosts, and refreshes an expiring access token ahead of
 * time through the SDK's own `refreshAuthorization`. There is no `finishAuth` of its own — the
 * transport drives the 401 retry and the 403 scope step-up, and the host passes the callback
 * `URLSearchParams` to `transport.finishAuth()` (or the manager's `completeAuthorization`).
 *
 * Credentials are keyed per authorization server (SEP-2352). Everything the SDK resolves an
 * `issuer` for is stored under `` `${issuer}/…` ``; everything bound to the MCP server instead —
 * the PKCE verifier, the `state`, the discovery state, and the "last issuer seen" pointer — is
 * stored under `` `${serverUrl}/…` ``. Two MCP servers that resolve to the same authorization
 * server therefore share client credentials and tokens, which is the RFC 6749 §2.2 identity
 * model: a `client_id` is unique to the authorization server that issued it, not to the resource.
 *
 * A pre-registered {@link McpOAuthClientProviderOptions.clientId} makes this a *static* provider:
 * `saveClientInformation` is then absent from the instance, which is how the SDK distinguishes
 * credentials it may re-register from credentials it may not.
 *
 * Instances are frozen. The store, the client secret, and the PKCE verifier are never reachable
 * through a public field.
 */
export class McpOAuthClientProvider implements OAuthClientProvider, McpCallbackStateVerifier {
	/** The normalized MCP server URL used as this provider's store namespace. */
	readonly serverUrl: string;
	/** SEP-991 Client ID Metadata Document URL, when one was configured. */
	readonly clientMetadataUrl?: string;
	/** The credential profile this provider reads and writes, when one was configured. */
	readonly profile?: string;
	readonly #redirectUrl: URL;
	readonly #clientId: string | undefined;
	readonly #clientSecret: string | undefined;
	readonly #expectedIssuer: string | undefined;
	readonly #clientName: string;
	readonly #extraMetadata: Partial<OAuthClientMetadata>;
	readonly #scope: string | undefined;
	readonly #store: McpKeyValueStore;
	readonly #onRedirect: (url: URL) => void | Promise<void>;
	readonly #refresh:
		| (Required<Pick<McpOAuthRefreshOptions, "bufferMs">> & Pick<McpOAuthRefreshOptions, "onError">)
		| undefined;
	readonly #fetch: FetchLike | undefined;
	readonly #useState: boolean;
	readonly #now: () => number;
	readonly #refreshing = new Map<string, Promise<McpStoredOAuthTokens>>();

	/**
	 * Persists a dynamically registered client under `ctx.issuer`.
	 *
	 * Installed per instance and **only** when no static
	 * {@link McpOAuthClientProviderOptions.clientId} is configured, mirroring the SDK's own static
	 * providers. `auth()` reads the absence of this method as "these credentials cannot be
	 * re-registered": it then never replaces the pre-registered identity, skips the SEP-2352
	 * back-stamping warning it would otherwise log on every round, and raises
	 * `AuthorizationServerMismatchError` when an issuer-stamped static credential meets a
	 * different authorization server.
	 */
	declare readonly saveClientInformation?: (
		clientInformation: StoredOAuthClientInformation,
		ctx?: OAuthClientInformationContext,
	) => Promise<void>;

	constructor(options: McpOAuthClientProviderOptions) {
		if (typeof options.onRedirect !== "function") {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				"onRedirect must be a function; kmcp never opens a browser on its own.",
			);
		}
		// SEP-991: fail at construction rather than deep inside the SDK's auth() flow.
		validateClientMetadataUrl(options.clientMetadataUrl);
		if (options.clientMetadataUrl !== undefined) {
			this.clientMetadataUrl = options.clientMetadataUrl;
		}
		this.serverUrl = absoluteUrl(options.serverUrl, "serverUrl").href;
		if (options.profile !== undefined) {
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.profile)) {
				throw new KmcpError(
					KMCP_ERROR_CODES.INVALID_DEFINITION,
					"profile must be 1-64 characters of letters, digits, '.', '_' or '-'.",
				);
			}
			this.profile = options.profile;
		}
		this.#redirectUrl = absoluteUrl(options.redirectUrl, "redirectUrl");
		this.#clientId = options.clientId;
		this.#clientSecret = options.clientSecret;
		this.#expectedIssuer = options.clientId === undefined ? undefined : options.expectedIssuer;
		this.#clientName = options.clientName ?? "kmcp";
		this.#extraMetadata = { ...options.clientMetadata };
		this.#scope = normalizeScope(options.scope);
		this.#store = options.store ?? new InMemoryKeyValueStore();
		this.#onRedirect = options.onRedirect;
		if (options.refresh === false) this.#refresh = undefined;
		else {
			const bufferMs = options.refresh?.bufferMs ?? 60_000;
			if (!Number.isFinite(bufferMs) || bufferMs < 0) {
				throw new RangeError("refresh.bufferMs must be non-negative.");
			}
			this.#refresh = {
				bufferMs,
				...(options.refresh?.onError === undefined ? {} : { onError: options.refresh.onError }),
			};
		}
		this.#fetch = options.fetch;
		this.#useState = options.state !== false;
		this.#now = options.now ?? Date.now;
		if (options.clientId === undefined) {
			// An own property rather than a prototype method: a static provider must not carry this
			// member at all, and a prototype method cannot be withheld per instance.
			Object.defineProperty(this, "saveClientInformation", {
				value: (
					clientInformation: StoredOAuthClientInformation,
					ctx?: OAuthClientInformationContext,
				): Promise<void> => this.#saveRegisteredClient(clientInformation, ctx),
				enumerable: false,
				writable: false,
				configurable: false,
			});
		}
		Object.freeze(this);
	}

	/** The `redirect_uri` this client ends the authorization leg on. */
	get redirectUrl(): URL {
		return this.#redirectUrl;
	}

	/**
	 * RFC 7591 metadata for Dynamic Client Registration.
	 *
	 * `grant_types` is deliberately absent: the SDK's `resolveClientMetadata` defaults an
	 * interactive provider (one with a `redirectUrl`) to `["authorization_code", "refresh_token"]`
	 * per SEP-2207, and it never overwrites an explicit field. Setting it here would suppress that
	 * default and could stop an authorization server from ever issuing a refresh token.
	 */
	get clientMetadata(): OAuthClientMetadata {
		return {
			...this.#extraMetadata,
			redirect_uris: [this.#redirectUrl.href],
			token_endpoint_auth_method: this.#clientSecret === undefined ? "none" : "client_secret_post",
			response_types: ["code"],
			client_name: this.#clientName,
			...(this.#scope === undefined ? {} : { scope: this.#scope }),
		};
	}

	/**
	 * Returns a fresh OAuth `state` value and remembers it for {@link verifyCallbackState}. The
	 * SDK calls this when building the authorization URL; it never verifies the value itself.
	 */
	async state(): Promise<string> {
		const bytes = new Uint8Array(32);
		globalThis.crypto.getRandomValues(bytes);
		const value = encodeBase64Url(bytes);
		if (this.#useState) await this.#store.set(this.#key("state"), value);
		return value;
	}

	/**
	 * Verifies the `state` of an authorization callback against the value issued by
	 * {@link state} and forgets it (one-time use). Passes when no state was recorded (a callback
	 * for a redirect this process never issued cannot be checked) or when `state` is disabled.
	 */
	async verifyCallbackState(params: URLSearchParams): Promise<void> {
		if (!this.#useState) return;
		const key = this.#key("state");
		const expected = await this.#store.get(key);
		if (expected === undefined) return;
		await this.#store.delete(key);
		const received = params.get("state");
		if (received === null || !constantTimeEqual(received, expected)) {
			throw new KmcpError(
				KMCP_ERROR_CODES.AUTH_STATE_MISMATCH,
				"The OAuth callback state does not match the value issued for this authorization.",
			);
		}
	}

	/**
	 * Returns the pre-registered client, or the credentials registered with `ctx.issuer` (falling
	 * back to the last issuer seen for this server when the SDK calls without a context).
	 */
	async clientInformation(
		ctx?: OAuthClientInformationContext,
	): Promise<StoredOAuthClientInformation | undefined> {
		if (this.#clientId !== undefined) {
			return {
				client_id: this.#clientId,
				...(this.#clientSecret === undefined ? {} : { client_secret: this.#clientSecret }),
				...(this.#expectedIssuer === undefined ? {} : { issuer: this.#expectedIssuer }),
			};
		}
		const issuer = ctx?.issuer ?? (await this.#lastIssuer());
		return this.#readJson<StoredOAuthClientInformation>(this.#key("client_info", issuer));
	}

	/**
	 * Returns the token set for `ctx.issuer`. A context-less call is the transport's per-request
	 * bearer-token read, which SEP-2352 requires to resolve the most recently saved set — hence
	 * the last-issuer pointer rather than `undefined`. An access token inside the refresh buffer
	 * is refreshed first when a refresh token and discovery state are on hand; a refresh failure
	 * returns the stale set so the transport's 401 path can recover.
	 */
	async tokens(ctx?: OAuthClientInformationContext): Promise<McpStoredOAuthTokens | undefined> {
		const issuer = ctx?.issuer ?? (await this.#lastIssuer());
		const stored = await this.#readTokens(issuer);
		if (stored === undefined || this.#refresh === undefined) return stored;
		if (!this.#expiresSoon(stored, this.#refresh.bufferMs) || stored.refresh_token === undefined) {
			return stored;
		}
		return this.#refreshSingleFlight(issuer, stored);
	}

	/** Persists a token set under `ctx.issuer`, stamping an absolute expiry, and records the last issuer. */
	async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
		await this.#rememberIssuer(ctx?.issuer);
		await this.#store.set(this.#key("tokens", ctx?.issuer), JSON.stringify(this.#stamp(tokens)));
	}

	/** Hands the authorization URL to {@link McpOAuthClientProviderOptions.onRedirect}. */
	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		await this.#onRedirect(authorizationUrl);
	}

	/** Persists the PKCE verifier in the store, so it survives the redirect round-trip. */
	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		await this.#store.set(this.#key("code_verifier"), codeVerifier);
	}

	/** Reads back the PKCE verifier saved for this server. */
	async codeVerifier(): Promise<string> {
		const verifier = await this.#store.get(this.#key("code_verifier"));
		if (verifier === undefined) {
			throw new KmcpError(
				KMCP_ERROR_CODES.OPERATION_FAILED,
				`No PKCE code verifier is stored for ${this.serverUrl}.`,
			);
		}
		return verifier;
	}

	/**
	 * Persists RFC 9728 / RFC 8414 discovery results. Mandatory rather than an optimization: the
	 * SDK reads this back on the callback leg to bind the authorization code to the authorization
	 * server that issued it, and raises `AuthorizationServerMismatchError` when a provider that
	 * implements this method cannot produce the state.
	 */
	async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
		await this.#store.set(this.#key("discovery"), JSON.stringify(state));
	}

	/** Reads back the discovery state saved for this server. */
	async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
		return this.#readJson<OAuthDiscoveryState>(this.#key("discovery"));
	}

	/**
	 * Drops stored credentials the server has declared invalid. Hosts should invalidate
	 * `'discovery'` after a failed authorization round so a migrated authorization server is
	 * picked up; the SDK never invokes that scope itself.
	 */
	async invalidateCredentials(
		scope: "all" | "client" | "tokens" | "verifier" | "discovery",
	): Promise<void> {
		const issuer = await this.#lastIssuer();
		if (scope === "all" || scope === "tokens") {
			await this.#store.delete(this.#key("tokens", issuer));
			await this.#store.delete(this.#key("tokens"));
		}
		if (scope === "all" || scope === "client") {
			await this.#store.delete(this.#key("client_info", issuer));
			await this.#store.delete(this.#key("client_info"));
		}
		if (scope === "all" || scope === "verifier") {
			await this.#store.delete(this.#key("code_verifier"));
			await this.#store.delete(this.#key("state"));
		}
		if (scope === "all" || scope === "discovery") {
			await this.#store.delete(this.#key("discovery"));
		}
	}

	/** Describes the stored credentials without revealing any secret. Never triggers a refresh. */
	async status(): Promise<McpOAuthCredentialStatus> {
		const issuer = (await this.#lastIssuer()) ?? this.#expectedIssuer;
		const tokens = await this.#readTokens(issuer);
		const client = await this.clientInformation(issuer === undefined ? undefined : { issuer });
		const claims: McpJwtClaims | undefined =
			tokens?.id_token === undefined ? undefined : decodeJwtClaims(tokens.id_token);
		const identity = claims === undefined ? undefined : identityFromClaims(claims);
		return Object.freeze({
			serverUrl: this.serverUrl,
			...(this.profile === undefined ? {} : { profile: this.profile }),
			...(issuer === undefined ? {} : { issuer }),
			...(client?.client_id === undefined ? {} : { clientId: client.client_id }),
			hasTokens: tokens !== undefined,
			hasRefreshToken: tokens?.refresh_token !== undefined,
			...(tokens?.token_type === undefined ? {} : { tokenType: tokens.token_type }),
			...(tokens?.scope === undefined ? {} : { scope: tokens.scope }),
			...(tokens?.expires_at === undefined
				? {}
				: { expiresAt: new Date(tokens.expires_at * 1000).toISOString() }),
			...(tokens?.saved_at === undefined ? {} : { savedAt: tokens.saved_at }),
			...(identity === undefined ? {} : { identity }),
		});
	}

	async #saveRegisteredClient(
		clientInformation: StoredOAuthClientInformation,
		ctx?: OAuthClientInformationContext,
	): Promise<void> {
		await this.#rememberIssuer(ctx?.issuer);
		await this.#store.set(this.#key("client_info", ctx?.issuer), JSON.stringify(clientInformation));
	}

	#stamp(tokens: StoredOAuthTokens): McpStoredOAuthTokens {
		const saved_at = new Date(this.#now()).toISOString();
		const existing = (tokens as McpStoredOAuthTokens).expires_at;
		if (existing !== undefined) return { ...tokens, saved_at };
		const lifetime = tokens.expires_in;
		if (typeof lifetime !== "number" || !Number.isFinite(lifetime)) return { ...tokens, saved_at };
		return { ...tokens, expires_at: Math.floor(this.#now() / 1000) + lifetime, saved_at };
	}

	#expiresSoon(tokens: McpStoredOAuthTokens, bufferMs: number): boolean {
		if (tokens.expires_at === undefined) return false;
		return tokens.expires_at * 1000 - this.#now() <= bufferMs;
	}

	#refreshSingleFlight(
		issuer: string | undefined,
		stale: McpStoredOAuthTokens,
	): Promise<McpStoredOAuthTokens> {
		const key = issuer ?? "";
		const inFlight = this.#refreshing.get(key);
		if (inFlight !== undefined) return inFlight;
		const task = this.#refreshTokens(issuer, stale).finally(() => {
			if (this.#refreshing.get(key) === task) this.#refreshing.delete(key);
		});
		this.#refreshing.set(key, task);
		return task;
	}

	async #refreshTokens(
		issuer: string | undefined,
		stale: McpStoredOAuthTokens,
	): Promise<McpStoredOAuthTokens> {
		try {
			const discovery = await this.discoveryState();
			const refreshToken = stale.refresh_token;
			if (discovery?.authorizationServerUrl === undefined || refreshToken === undefined) {
				return stale;
			}
			const ctx = issuer === undefined ? undefined : { issuer };
			const clientInformation = await this.clientInformation(ctx);
			if (clientInformation === undefined) return stale;
			const resource = await selectResourceURL(this.serverUrl, this, discovery.resourceMetadata);
			const refreshed = await refreshAuthorization(discovery.authorizationServerUrl, {
				...(discovery.authorizationServerMetadata === undefined
					? {}
					: { metadata: discovery.authorizationServerMetadata }),
				clientInformation,
				refreshToken,
				...(resource === undefined ? {} : { resource }),
				...(this.#fetch === undefined ? {} : { fetchFn: this.#fetch }),
			});
			const stamped = this.#stamp({
				...refreshed,
				...(stale.issuer === undefined ? {} : { issuer: stale.issuer }),
			});
			await this.saveTokens(stamped, ctx);
			return stamped;
		} catch (error) {
			this.#refresh?.onError?.(error);
			return stale;
		}
	}

	async #readTokens(issuer: string | undefined): Promise<McpStoredOAuthTokens | undefined> {
		return this.#readJson<McpStoredOAuthTokens>(this.#key("tokens", issuer));
	}

	#key(kind: string, issuer?: string): string {
		return `${this.#prefix()}${issuer ?? this.serverUrl}/${kind}`;
	}

	/** Key of the "last issuer seen for this MCP server" pointer (SEP-2352). */
	#issuerPointerKey(): string {
		return `${this.#prefix()}${this.serverUrl}/issuer`;
	}

	/** Profiles partition the whole key space; the unnamed profile keeps the bare keys. */
	#prefix(): string {
		return this.profile === undefined ? "" : `profile:${this.profile}/`;
	}

	async #rememberIssuer(issuer: string | undefined): Promise<void> {
		if (issuer === undefined) return;
		await this.#store.set(this.#issuerPointerKey(), issuer);
	}

	async #lastIssuer(): Promise<string | undefined> {
		return this.#store.get(this.#issuerPointerKey());
	}

	async #readJson<Value>(key: string): Promise<Value | undefined> {
		const raw = await this.#store.get(key);
		if (raw === undefined) return undefined;
		try {
			return JSON.parse(raw) as Value;
		} catch (error) {
			throw new KmcpError(
				KMCP_ERROR_CODES.OPERATION_FAILED,
				`Stored OAuth state for '${key}' is not valid JSON.`,
				{ cause: error },
			);
		}
	}
}

/** Display-only identity from OIDC claims (`sub`, `email`, `name` or `preferred_username`). */
export function identityFromClaims(
	claims: McpJwtClaims,
): Readonly<{ subject?: string; email?: string; name?: string }> | undefined {
	const subject = typeof claims.sub === "string" ? claims.sub : undefined;
	const email = typeof claims.email === "string" ? claims.email : undefined;
	const name =
		typeof claims.name === "string"
			? claims.name
			: typeof claims.preferred_username === "string"
				? claims.preferred_username
				: undefined;
	if (subject === undefined && email === undefined && name === undefined) return undefined;
	return Object.freeze({
		...(subject === undefined ? {} : { subject }),
		...(email === undefined ? {} : { email }),
		...(name === undefined ? {} : { name }),
	});
}

/** Whether a token set's access token has expired (or expires within `bufferMs`). */
export function oauthTokensExpireWithin(
	tokens: McpStoredOAuthTokens,
	bufferMs: number,
	now: () => number = Date.now,
): boolean {
	if (tokens.expires_at === undefined) return false;
	return tokens.expires_at * 1000 - now() <= bufferMs;
}

export { jwtExpiresAt };

function absoluteUrl(value: string | URL, label: string): URL {
	try {
		return typeof value === "string" ? new URL(value) : new URL(value.href);
	} catch (error) {
		throw new KmcpError(KMCP_ERROR_CODES.INVALID_DEFINITION, `${label} must be an absolute URL.`, {
			cause: error,
		});
	}
}

/** Joins a scope list into the space-delimited wire form; an empty value becomes `undefined`. */
export function normalizeScope(scope: string | readonly string[] | undefined): string | undefined {
	if (scope === undefined) return undefined;
	const value = typeof scope === "string" ? scope : scope.join(" ");
	return value.trim().length === 0 ? undefined : value.trim();
}

function constantTimeEqual(left: string, right: string): boolean {
	const a = new TextEncoder().encode(left);
	const b = new TextEncoder().encode(right);
	let diff = a.length ^ b.length;
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
	}
	return diff === 0;
}
