import {
	type OAuthClientInformationContext,
	type OAuthClientMetadata,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
	type StoredOAuthClientInformation,
	type StoredOAuthTokens,
	validateClientMetadataUrl,
} from "@modelcontextprotocol/client";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";

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
	 * Hands the authorization URL to the host application. Required: kmcp never launches a
	 * browser, prints to a terminal, or otherwise decides how a user is prompted.
	 */
	readonly onRedirect: (url: URL) => void | Promise<void>;
}

/**
 * An interactive `authorization_code` + PKCE {@link OAuthClientProvider} for the official SDK
 * transports.
 *
 * The SDK owns the protocol: this class only persists what `auth()` hands it. There is no refresh
 * loop and no `finishAuth` of its own — the transport drives refresh, the 401 retry and the 403
 * scope step-up, and the host passes the callback `URLSearchParams` to `transport.finishAuth()`.
 *
 * Credentials are keyed per authorization server (SEP-2352). Everything the SDK resolves an
 * `issuer` for is stored under `` `${issuer}/…` ``; everything bound to the MCP server instead —
 * the PKCE verifier, the discovery state, and the "last issuer seen" pointer — is stored under
 * `` `${serverUrl}/…` ``. Two MCP servers that resolve to the same authorization server therefore
 * share client credentials and tokens, which is the RFC 6749 §2.2 identity model: a `client_id` is
 * unique to the authorization server that issued it, not to the resource.
 *
 * A pre-registered {@link McpOAuthClientProviderOptions.clientId} makes this a *static* provider:
 * `saveClientInformation` is then absent from the instance, which is how the SDK distinguishes
 * credentials it may re-register from credentials it may not.
 *
 * Instances are frozen. The store, the client secret, and the PKCE verifier are never reachable
 * through a public field.
 */
export class McpOAuthClientProvider implements OAuthClientProvider {
	/** The normalized MCP server URL used as this provider's store namespace. */
	readonly serverUrl: string;
	/** SEP-991 Client ID Metadata Document URL, when one was configured. */
	readonly clientMetadataUrl?: string;
	readonly #redirectUrl: URL;
	readonly #clientId: string | undefined;
	readonly #clientSecret: string | undefined;
	readonly #expectedIssuer: string | undefined;
	readonly #clientName: string;
	readonly #scope: string | undefined;
	readonly #store: McpKeyValueStore;
	readonly #onRedirect: (url: URL) => void | Promise<void>;

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
		this.#redirectUrl = absoluteUrl(options.redirectUrl, "redirectUrl");
		this.#clientId = options.clientId;
		this.#clientSecret = options.clientSecret;
		this.#expectedIssuer = options.clientId === undefined ? undefined : options.expectedIssuer;
		this.#clientName = options.clientName ?? "kmcp";
		this.#scope = normalizeScope(options.scope);
		this.#store = options.store ?? new InMemoryKeyValueStore();
		this.#onRedirect = options.onRedirect;
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
			redirect_uris: [this.#redirectUrl.href],
			token_endpoint_auth_method: this.#clientSecret === undefined ? "none" : "client_secret_post",
			response_types: ["code"],
			client_name: this.#clientName,
			...(this.#scope === undefined ? {} : { scope: this.#scope }),
		};
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
	 * the last-issuer pointer rather than `undefined`.
	 */
	async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
		const issuer = ctx?.issuer ?? (await this.#lastIssuer());
		return this.#readJson<StoredOAuthTokens>(this.#key("tokens", issuer));
	}

	/** Persists a token set under `ctx.issuer` and records it as the server's last issuer. */
	async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
		await this.#rememberIssuer(ctx?.issuer);
		await this.#store.set(this.#key("tokens", ctx?.issuer), JSON.stringify(tokens));
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
		}
		if (scope === "all" || scope === "discovery") {
			await this.#store.delete(this.#key("discovery"));
		}
	}

	async #saveRegisteredClient(
		clientInformation: StoredOAuthClientInformation,
		ctx?: OAuthClientInformationContext,
	): Promise<void> {
		await this.#rememberIssuer(ctx?.issuer);
		await this.#store.set(this.#key("client_info", ctx?.issuer), JSON.stringify(clientInformation));
	}

	#key(kind: string, issuer?: string): string {
		return issuer === undefined ? `${this.serverUrl}/${kind}` : `${issuer}/${kind}`;
	}

	/** Key of the "last issuer seen for this MCP server" pointer (SEP-2352). */
	#issuerPointerKey(): string {
		return `${this.serverUrl}/issuer`;
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

function absoluteUrl(value: string | URL, label: string): URL {
	try {
		return typeof value === "string" ? new URL(value) : new URL(value.href);
	} catch (error) {
		throw new KmcpError(KMCP_ERROR_CODES.INVALID_DEFINITION, `${label} must be an absolute URL.`, {
			cause: error,
		});
	}
}

function normalizeScope(scope: string | readonly string[] | undefined): string | undefined {
	if (scope === undefined) return undefined;
	const value = typeof scope === "string" ? scope : scope.join(" ");
	return value.trim().length === 0 ? undefined : value;
}
