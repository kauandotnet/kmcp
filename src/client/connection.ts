import {
	type AuthProvider,
	Client,
	type ClientCapabilities,
	type ClientContext,
	type ClientOptions,
	type ConnectOptions,
	type HandlerResultTypeMap,
	type Implementation,
	InMemoryTransport,
	type InputRequiredOptions,
	type ListChangedHandlers,
	type LoggingLevel,
	type Middleware,
	mergeCapabilities,
	type NotificationTypeMap,
	type OAuthClientProvider,
	type ProgressCallback,
	type RequestTypeMap,
	type ResponseCacheStore,
	type Root,
	type ServerCapabilities,
	StreamableHTTPClientTransport,
	type StreamableHTTPClientTransportOptions,
	type StreamableHTTPReconnectionOptions,
	type Transport,
	type VersionNegotiationOptions,
	applyMiddlewares,
} from "@modelcontextprotocol/client";
import type {
	AuthInfo,
	CreateMcpHandlerOptions,
	McpHttpHandler,
	McpRequestContext,
	Transport as McpServerTransport,
} from "@modelcontextprotocol/server";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import {
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_SUPPORTED_PROTOCOL_VERSIONS,
	type McpProtocolEra,
	isModernProtocolVersion,
	resolveProtocolPin,
} from "../internal/protocol.ts";
import { assertNonEmpty, type MaybePromise } from "../internal/value.ts";
import { KMCP_VERSION } from "../internal/version.ts";
import type { McpCallbackStateVerifier } from "./oauth.ts";
import {
	MCP_CLIENT_CREDENTIALS_EXTENSION,
	MCP_ENTERPRISE_MANAGED_AUTH_EXTENSION,
	oauthGrantOf,
} from "./oauth-flows.ts";

export type McpTransportFactory = () => MaybePromise<Transport>;

export type McpClientRequestMethod = "elicitation/create" | "roots/list" | "sampling/createMessage";

/**
 * Server→client request handlers, keyed by the SDK method name so the types can never drift from
 * `Client.setRequestHandler`. These are what the SDK's multi-round-trip driver dispatches
 * `input_required` rounds to on the modern era, and what a 2025-era server's push requests reach.
 * `sampling/createMessage` and `roots/list` are deprecated as of protocol revision 2026-07-28.
 */
export type McpClientRequestHandlers = {
	readonly [Method in McpClientRequestMethod]?: (
		request: RequestTypeMap[Method],
		context: ClientContext,
	) => MaybePromise<HandlerResultTypeMap[Method]>;
};

export type McpClientNotificationMethod =
	"notifications/message" | "notifications/resources/updated";

/**
 * Notification handlers. `notifications/message` (deprecated in 2026-07-28) carries untrusted
 * upstream text — bound and sanitise it before it reaches logs or model context. Neither handler has
 * a default sink: on stdio, stdout is the protocol.
 */
export type McpClientNotificationHandlers = {
	readonly [Method in McpClientNotificationMethod]?: (
		notification: NotificationTypeMap[Method],
	) => MaybePromise<void>;
};

/** Opt-ins for client capabilities that widen what an upstream may ask of this client. */
export interface McpClientAdvertise {
	/** Accept URL-mode elicitation (the upstream chooses the URL). */
	readonly elicitationUrl?: true;
	/** Accept tool-augmented sampling requests. */
	readonly samplingTools?: true;
}

export type McpRootsSource =
	readonly string[] | readonly Root[] | (() => MaybePromise<readonly string[] | readonly Root[]>);

export interface McpRequestDefaults {
	/** Default timeout for every request (ms). */
	readonly timeoutMs?: number;
	readonly toolTimeoutMs?: number;
	readonly resourceTimeoutMs?: number;
	readonly promptTimeoutMs?: number;
	readonly resetTimeoutOnProgress?: boolean;
	/** Whole-flow budget (ms) — the only correct bound for a multi-round-trip call. */
	readonly maxTotalTimeoutMs?: number;
	/** Default progress handler; a per-call `onprogress` wins. */
	readonly onprogress?: ProgressCallback;
}

export interface McpAutoRefreshOptions {
	/** SDK-side debounce of list-changed notifications before kmcp reacts (ms). Default: the SDK's 300. */
	readonly debounceMs?: number;
	/** Hard minimum between two refreshes of one generation (ms). Default: 1000. */
	readonly minIntervalMs?: number;
	/** After this many refreshes in one generation the catalog stops re-fetching and is published stale. Default: 100. */
	readonly maxRefreshesPerGeneration?: number;
}

/** `McpAutoRefreshOptions` with kmcp's defaults applied (the shape stored on a definition). */
export type McpResolvedAutoRefreshOptions = Readonly<
	Required<Omit<McpAutoRefreshOptions, "debounceMs">> & Pick<McpAutoRefreshOptions, "debounceMs">
>;

export interface McpReconnectBackoffOptions {
	/** Delay before the first retry (ms). */
	readonly initialMs: number;
	/** Delay ceiling (ms). Default: 30000. */
	readonly maxMs?: number;
	/** Exponential growth factor. Default: 2. */
	readonly factor?: number;
	/** Randomize each delay into `[delay/2, delay]` to avoid thundering herds. Default: `true`. */
	readonly jitter?: boolean;
}

/**
 * Opt-in automatic reconnection after an UNEXPECTED close of an online connection. Deliberate
 * lifecycle (disconnect, remove, drain, close) never reconnects, and every attempt re-enters the
 * manager's public `connect()` — single-flight, drain queuing, and generation discipline are
 * inherited, not re-implemented.
 */
export interface McpReconnectOptions {
	readonly maxAttempts: number;
	readonly backoff: McpReconnectBackoffOptions;
	/**
	 * Reset the attempt counter when the connection had been up for at least this long (ms).
	 * Absent: the counter resets on every successful connect.
	 */
	readonly resetAfterMs?: number;
}

/** `McpReconnectOptions` with defaults applied (the shape stored on a definition). */
export interface McpResolvedReconnectOptions {
	readonly maxAttempts: number;
	readonly initialMs: number;
	readonly maxMs: number;
	readonly factor: number;
	readonly jitter: boolean;
	readonly resetAfterMs?: number;
}

/**
 * Opt-in liveness probing of an online connection: a periodic `ping` (legacy) or
 * `server/discover` (modern). After `failureThreshold` consecutive failures the session is closed
 * as an UNEXPECTED close, so the definition's `reconnect` policy (when any) takes over.
 */
export interface McpKeepaliveOptions {
	/** Interval between probes (ms). Default: 30000. */
	readonly intervalMs?: number;
	/** Timeout of one probe (ms). Default: 10000. */
	readonly timeoutMs?: number;
	/** Consecutive failures before the session is declared dead. Default: 2. */
	readonly failureThreshold?: number;
}

export type McpResolvedKeepaliveOptions = Readonly<Required<McpKeepaliveOptions>>;

/** The transport carrying a connection, as declared by the helper that built it. */
export type McpTransportKind = "custom" | "in-process" | "sse" | "stdio" | "streamable-http";

/**
 * A server-side session adopted without a handshake. The SDK skips `initialize` / the
 * `server/discover` probe when the transport already carries a session id, so the client learns
 * neither the era nor the server's capabilities; this record supplies what the original handshake
 * reported. Persist it from a connection snapshot (`sessionId`, `protocolVersion`, `capabilities`,
 * `serverInfo`, `instructions`) and hand it back on the next start.
 */
export interface McpResumedSession {
	readonly sessionId: string;
	/** The revision the original handshake negotiated; drives the era and the wire header. */
	readonly protocolVersion?: string;
	readonly capabilities?: ServerCapabilities;
	readonly serverInfo?: Implementation;
	readonly instructions?: string;
}

/** `McpResumedSession` with the era resolved from `protocolVersion`. */
export interface McpResolvedResumedSession extends McpResumedSession {
	readonly era: McpProtocolEra | undefined;
}

/** The SDK's `capabilities.extensions` map: reverse-DNS extension ids to JSON option objects. */
export type McpCapabilityExtensions = NonNullable<ClientCapabilities["extensions"]>;

export interface McpConnectionDefinitionOptions<Id extends string> {
	readonly id: Id;
	readonly label?: string;
	readonly tags?: Readonly<Record<string, string>>;
	readonly clientInfo?: Implementation;
	readonly clientOptions?: ClientOptions;
	readonly connectOptions?: ConnectOptions;
	readonly transport: McpTransportFactory;
	/** What `transport` opens; drives transport-specific behavior (session termination, close budgets). */
	readonly transportKind?: McpTransportKind;
	readonly requestHandlers?: McpClientRequestHandlers;
	readonly notificationHandlers?: McpClientNotificationHandlers;
	readonly advertise?: McpClientAdvertise;
	/** Static roots (bare paths become `file://` URIs) or a callback for dynamic roots. */
	readonly roots?: McpRootsSource;
	/**
	 * Multi-round-trip driver settings. REQUIRED (with an explicit small `maxRounds`) whenever a
	 * request handler is registered: the SDK default lets any upstream drive ten automatic
	 * elicitation/sampling rounds per call.
	 */
	readonly inputRequired?: InputRequiredOptions & { readonly maxRounds: number };
	/** Refresh the catalog when the upstream announces a list change (both eras). */
	readonly autoRefreshCatalog?: boolean | McpAutoRefreshOptions;
	/** Reconnect automatically after an unexpected close (see `McpReconnectOptions`). */
	readonly reconnect?: McpReconnectOptions;
	/** Probe liveness periodically and treat repeated failures as an unexpected close (see `McpKeepaliveOptions`). */
	readonly keepalive?: boolean | McpKeepaliveOptions;
	/**
	 * Pin one exact protocol revision (strict, no fallback) instead of the default `auto`
	 * negotiation. A modern revision pins the `server/discover` probe; a legacy revision runs the
	 * plain `initialize` handshake offering only that revision. Mutually exclusive with an explicit
	 * `clientOptions.versionNegotiation`.
	 */
	readonly protocolVersion?: string;
	/**
	 * Upper bound on closing the official client during `disconnect` (ms). A close that overruns
	 * it is reported as a close failure (the connection is quarantined) rather than hanging the
	 * caller. Absent: unbounded.
	 */
	readonly disconnectTimeoutMs?: number;
	/**
	 * Send the Streamable HTTP `DELETE` that terminates the server-side session before closing the
	 * client on `disconnect`. Default: `true`. Only transports that expose `terminateSession` are
	 * affected.
	 */
	readonly terminateSession?: boolean;
	/**
	 * Advertise the 2025-11-25 `tasks` client capability (`list` and `cancel`) so servers may
	 * expose task-augmented tool calls. Default: `true`.
	 */
	readonly tasks?: boolean;
	/**
	 * The session the FIRST transport this definition opens resumes (the transport factory must
	 * carry the same `sessionId`). While that session lives, snapshots and era-dependent verbs use
	 * this record in place of the handshake the SDK skipped, and strict capability enforcement is
	 * off (there is nothing to enforce against) unless `clientOptions.enforceStrictCapabilities`
	 * says otherwise. A later reconnect runs a full handshake.
	 */
	readonly resumed?: McpResumedSession;
	/** Capability extensions (reverse-DNS keys) merged into `capabilities.extensions`. */
	readonly extensions?: McpCapabilityExtensions;
	/**
	 * Raw escape hatch: runs on the freshly constructed official `Client` after every typed
	 * handler is installed and BEFORE `connect()`. Synchronous by design — an async hook would
	 * push construction into the connect critical section.
	 */
	readonly configureClient?: (client: Client) => void;
	readonly defaults?: McpRequestDefaults;
	/** Initial log level stamped on modern requests (`_meta["io.modelcontextprotocol/logLevel"]`). */
	readonly logLevel?: LoggingLevel;
	/**
	 * An interactive OAuth provider (see `McpOAuthClientProvider`). When a connect attempt is
	 * refused with the SDK's `UnauthorizedError`, the manager parks the connection in the
	 * `authorizing` phase instead of failing it. Never exposed on snapshots.
	 */
	readonly oauth?: OAuthClientProvider;
}

export class McpConnectionDefinition<const Id extends string = string> {
	readonly id: Id;
	readonly label: string;
	readonly tags: Readonly<Record<string, string>>;
	readonly clientInfo: Readonly<Implementation>;
	readonly clientOptions: ClientOptions;
	readonly connectOptions: ConnectOptions | undefined;
	readonly defaults: McpRequestDefaults;
	readonly autoRefreshCatalog: McpResolvedAutoRefreshOptions | undefined;
	readonly reconnect: McpResolvedReconnectOptions | undefined;
	readonly keepalive: McpResolvedKeepaliveOptions | undefined;
	readonly logLevel: LoggingLevel | undefined;
	readonly transportKind: McpTransportKind;
	readonly protocolVersion: string | undefined;
	readonly disconnectTimeoutMs: number | undefined;
	readonly terminateSession: boolean;
	readonly resumed: McpResolvedResumedSession | undefined;
	readonly #transportFactory: McpTransportFactory;
	readonly #requestHandlers: McpClientRequestHandlers;
	readonly #notificationHandlers: McpClientNotificationHandlers;
	readonly #roots: McpRootsSource | undefined;
	readonly #oauth: OAuthClientProvider | undefined;
	readonly #configureClient: ((client: Client) => void) | undefined;

	constructor(options: McpConnectionDefinitionOptions<Id>) {
		assertNonEmpty(options.id, "connection id");
		this.id = options.id;
		this.label = options.label ?? options.id;
		assertNonEmpty(this.label, "connection label");
		this.tags = Object.freeze({ ...options.tags });
		this.clientInfo = Object.freeze({
			name: "kmcp",
			version: KMCP_VERSION,
			...options.clientInfo,
		});
		this.#requestHandlers = Object.freeze({ ...options.requestHandlers });
		this.#notificationHandlers = Object.freeze({ ...options.notificationHandlers });
		this.#roots = options.roots;
		this.#oauth = options.oauth;
		for (const [method, handler] of Object.entries(this.#requestHandlers)) {
			if (typeof handler !== "function")
				throw new TypeError(`requestHandlers['${method}'] must be a function.`);
		}
		for (const [method, handler] of Object.entries(this.#notificationHandlers)) {
			if (typeof handler !== "function")
				throw new TypeError(`notificationHandlers['${method}'] must be a function.`);
		}
		if (this.#roots !== undefined && this.#requestHandlers["roots/list"] !== undefined) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				"Pass either roots or requestHandlers['roots/list'], not both.",
			);
		}
		const handlesRequests =
			Object.keys(this.#requestHandlers).length > 0 || this.#roots !== undefined;
		if (handlesRequests && options.inputRequired === undefined) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				"A connection with request handlers must set inputRequired.maxRounds explicitly.",
			);
		}
		if (options.inputRequired !== undefined) {
			const rounds = options.inputRequired.maxRounds;
			if (!Number.isSafeInteger(rounds) || rounds < 1) {
				throw new KmcpError(
					KMCP_ERROR_CODES.INVALID_DEFINITION,
					"inputRequired.maxRounds must be a positive integer.",
				);
			}
		}
		this.defaults = Object.freeze({ ...options.defaults });
		this.autoRefreshCatalog = normalizeAutoRefresh(options.autoRefreshCatalog);
		this.reconnect = normalizeReconnect(options.reconnect);
		this.keepalive = normalizeKeepalive(options.keepalive);
		if (options.configureClient !== undefined && typeof options.configureClient !== "function") {
			throw new TypeError("configureClient must be a function.");
		}
		this.#configureClient = options.configureClient;
		this.logLevel = options.logLevel;
		this.transportKind = options.transportKind ?? "custom";
		this.protocolVersion = options.protocolVersion;
		if (
			options.disconnectTimeoutMs !== undefined &&
			(!Number.isFinite(options.disconnectTimeoutMs) || options.disconnectTimeoutMs <= 0)
		) {
			throw new RangeError("disconnectTimeoutMs must be positive.");
		}
		this.disconnectTimeoutMs = options.disconnectTimeoutMs;
		this.terminateSession = options.terminateSession !== false;
		this.resumed = normalizeResumed(options.resumed);
		const pin =
			options.protocolVersion === undefined
				? undefined
				: resolveProtocolPin(options.protocolVersion);
		if (pin !== undefined && options.clientOptions?.versionNegotiation !== undefined) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				"Pass either protocolVersion or clientOptions.versionNegotiation, not both.",
			);
		}
		const extensions: McpCapabilityExtensions = { ...options.extensions };
		this.clientOptions = Object.freeze({
			// A resumed session never re-learns the server's capabilities, so there is nothing to
			// enforce against; the record supplied in `resumed` is display-only.
			enforceStrictCapabilities: this.resumed === undefined,
			...options.clientOptions,
			versionNegotiation:
				pin?.versionNegotiation ??
				options.clientOptions?.versionNegotiation ??
				({ mode: "auto" } as const),
			...(pin?.supportedProtocolVersions === undefined
				? {}
				: { supportedProtocolVersions: [...pin.supportedProtocolVersions] }),
			capabilities: mergeCapabilities(
				options.clientOptions?.capabilities ?? {},
				derivedCapabilities(
					this.#requestHandlers,
					this.#roots,
					options.advertise,
					options.tasks !== false,
					extensions,
				),
			),
			...(options.inputRequired === undefined
				? {}
				: { inputRequired: { ...options.inputRequired } }),
		});
		this.connectOptions = options.connectOptions;
		this.#transportFactory = options.transport;
		if (typeof options.transport !== "function") {
			throw new TypeError("transport must be a factory function.");
		}
		Object.freeze(this);
	}

	openTransport(): MaybePromise<Transport> {
		return this.#transportFactory();
	}

	/** True when the definition carries an interactive OAuth provider (the manager may park it in `authorizing`). */
	get interactiveOAuth(): boolean {
		return this.#oauth !== undefined;
	}

	/**
	 * Verifies an authorization callback against the OAuth provider (the `state` parameter, when
	 * the provider issued one) before the code is exchanged. A no-op for providers without
	 * `verifyCallbackState`.
	 */
	async verifyAuthorizationCallback(params: URLSearchParams): Promise<void> {
		const verifier = this.#oauth as Partial<McpCallbackStateVerifier> | undefined;
		if (typeof verifier?.verifyCallbackState === "function") {
			await verifier.verifyCallbackState(params);
		}
	}

	/** Registers this definition's server→client handlers and roots on a freshly constructed client. */
	installHandlers(client: Client, overrides: McpOfficialClientOverrides = {}): void {
		for (const [method, handler] of Object.entries(this.#requestHandlers)) {
			client.setRequestHandler(method as McpClientRequestMethod, handler as never);
		}
		const observer = overrides.onResourceUpdated;
		for (const [method, handler] of Object.entries(this.#notificationHandlers)) {
			if (method === "notifications/resources/updated" && observer !== undefined) continue;
			client.setNotificationHandler(method as McpClientNotificationMethod, handler as never);
		}
		if (observer !== undefined) {
			// `setNotificationHandler` is last-write-wins; compose observer-then-user so the
			// manager's event stream never clobbers a user handler (and vice versa).
			const user = this.#notificationHandlers["notifications/resources/updated"];
			client.setNotificationHandler("notifications/resources/updated", async (notification) => {
				try {
					observer(notification);
				} catch {
					// The manager's observation seam cannot break the user's handler.
				}
				await user?.(notification);
			});
		}
		const roots = this.#roots;
		if (roots !== undefined) {
			client.setRequestHandler("roots/list", async () => ({
				roots: normalizeRoots(typeof roots === "function" ? await roots() : roots),
			}));
		}
		this.#configureClient?.(client);
	}
}

function normalizeAutoRefresh(
	value: boolean | McpAutoRefreshOptions | undefined,
): McpResolvedAutoRefreshOptions | undefined {
	if (value === undefined || value === false) return undefined;
	const options = value === true ? {} : value;
	const minIntervalMs = options.minIntervalMs ?? 1000;
	const maxRefreshesPerGeneration = options.maxRefreshesPerGeneration ?? 100;
	if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0)
		throw new RangeError("minIntervalMs must be non-negative.");
	if (!Number.isSafeInteger(maxRefreshesPerGeneration) || maxRefreshesPerGeneration < 1) {
		throw new RangeError("maxRefreshesPerGeneration must be a positive integer.");
	}
	const debounceMs = options.debounceMs;
	if (debounceMs !== undefined && (!Number.isFinite(debounceMs) || debounceMs < 0)) {
		throw new RangeError("debounceMs must be non-negative.");
	}
	return Object.freeze({
		minIntervalMs,
		maxRefreshesPerGeneration,
		...(debounceMs === undefined ? {} : { debounceMs }),
	});
}

function normalizeReconnect(
	value: McpReconnectOptions | undefined,
): McpResolvedReconnectOptions | undefined {
	if (value === undefined) return undefined;
	const { maxAttempts, backoff, resetAfterMs } = value;
	if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
		throw new RangeError("reconnect.maxAttempts must be a positive integer.");
	}
	const initialMs = backoff?.initialMs;
	if (!Number.isFinite(initialMs) || initialMs <= 0) {
		throw new RangeError("reconnect.backoff.initialMs must be positive.");
	}
	const maxMs = backoff.maxMs ?? 30_000;
	if (!Number.isFinite(maxMs) || maxMs < initialMs) {
		throw new RangeError("reconnect.backoff.maxMs must be at least initialMs.");
	}
	const factor = backoff.factor ?? 2;
	if (!Number.isFinite(factor) || factor < 1) {
		throw new RangeError("reconnect.backoff.factor must be at least 1.");
	}
	if (resetAfterMs !== undefined && (!Number.isFinite(resetAfterMs) || resetAfterMs < 0)) {
		throw new RangeError("reconnect.resetAfterMs must be non-negative.");
	}
	return Object.freeze({
		maxAttempts,
		initialMs,
		maxMs,
		factor,
		jitter: backoff.jitter !== false,
		...(resetAfterMs === undefined ? {} : { resetAfterMs }),
	});
}

function normalizeResumed(
	value: McpResumedSession | undefined,
): McpResolvedResumedSession | undefined {
	if (value === undefined) return undefined;
	assertNonEmpty(value.sessionId, "resumed.sessionId");
	if (
		value.protocolVersion !== undefined &&
		!MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(value.protocolVersion)
	) {
		throw new KmcpError(
			KMCP_ERROR_CODES.PROTOCOL_VERSION_UNSUPPORTED,
			`resumed.protocolVersion '${value.protocolVersion}' is not a revision kmcp can speak.`,
		);
	}
	return Object.freeze({
		...value,
		era:
			value.protocolVersion === undefined
				? undefined
				: isModernProtocolVersion(value.protocolVersion)
					? "modern"
					: "legacy",
	});
}

function normalizeKeepalive(
	value: boolean | McpKeepaliveOptions | undefined,
): McpResolvedKeepaliveOptions | undefined {
	if (value === undefined || value === false) return undefined;
	const options = value === true ? {} : value;
	const intervalMs = options.intervalMs ?? 30_000;
	const timeoutMs = options.timeoutMs ?? 10_000;
	const failureThreshold = options.failureThreshold ?? 2;
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
		throw new RangeError("keepalive.intervalMs must be positive.");
	}
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new RangeError("keepalive.timeoutMs must be positive.");
	}
	if (!Number.isSafeInteger(failureThreshold) || failureThreshold < 1) {
		throw new RangeError("keepalive.failureThreshold must be a positive integer.");
	}
	return Object.freeze({ intervalMs, timeoutMs, failureThreshold });
}

/** The minimal capability set implied by the configured handlers (see `McpClientAdvertise` for the opt-ins). */
function derivedCapabilities(
	handlers: McpClientRequestHandlers,
	roots: McpRootsSource | undefined,
	advertise: McpClientAdvertise | undefined,
	tasks: boolean,
	extensions: McpCapabilityExtensions,
): Partial<ClientCapabilities> {
	return {
		...(handlers["elicitation/create"] === undefined
			? {}
			: { elicitation: advertise?.elicitationUrl === true ? { form: {}, url: {} } : { form: {} } }),
		...(handlers["sampling/createMessage"] === undefined
			? {}
			: { sampling: advertise?.samplingTools === true ? { tools: {} } : {} }),
		...(handlers["roots/list"] === undefined && roots === undefined
			? {}
			: { roots: { listChanged: typeof roots === "function" } }),
		...(tasks ? { tasks: { list: {}, cancel: {} } } : {}),
		...(Object.keys(extensions).length === 0 ? {} : { extensions: { ...extensions } }),
	};
}

/** Bare paths become `file://` URIs; `Root` objects pass through. */
export function normalizeRoots(roots: readonly string[] | readonly Root[]): Root[] {
	return roots.map((root) => {
		if (typeof root !== "string") return { ...root };
		if (/^[a-z][a-z0-9+.-]*:/i.test(root)) return { uri: root };
		return { uri: new URL(`file://${root.startsWith("/") ? "" : "/"}${root}`).href };
	});
}

export function defineConnection<const Id extends string>(
	options: McpConnectionDefinitionOptions<Id>,
): McpConnectionDefinition<Id> {
	return new McpConnectionDefinition(options);
}

export type McpHttpAuth = string | AuthProvider | OAuthClientProvider;

/**
 * A server-side session to resume instead of running a fresh handshake (Streamable HTTP). The
 * SDK skips the handshake when a session id is supplied, so `protocolVersion` is needed for the
 * `MCP-Protocol-Version` header and the era, and the remaining fields stand in for what the
 * original handshake reported (see `McpResumedSession`).
 */
export type McpHttpResumeOptions = McpResumedSession;

/**
 * kmcp's default Streamable HTTP reconnection policy for the server-to-client SSE stream:
 * 1 s → 30 s exponential backoff (factor 2), at most 10 retries. The SDK's own defaults give up
 * after two attempts, which is too little for a long-lived connection.
 */
export const MCP_HTTP_RECONNECTION_DEFAULTS: StreamableHTTPReconnectionOptions = Object.freeze({
	initialReconnectionDelay: 1000,
	maxReconnectionDelay: 30_000,
	reconnectionDelayGrowFactor: 2,
	maxRetries: 10,
});

export interface McpHttpConnectionOptions<Id extends string> extends Omit<
	McpConnectionDefinitionOptions<Id>,
	"transport" | "transportKind" | "oauth" | "resumed"
> {
	readonly url: string | URL;
	readonly transportOptions?: StreamableHTTPClientTransportOptions;
	/**
	 * A static bearer token (a leading `Bearer ` is stripped), an SDK `AuthProvider`
	 * (`{ token, onUnauthorized? }`), or an `OAuthClientProvider` (interactive providers also arm
	 * the manager's `authorizing` flow; client-credentials and enterprise providers advertise their
	 * capability extension automatically). Credentials live only inside the transport closure.
	 */
	readonly auth?: McpHttpAuth;
	/** Per-request headers for schemes `AuthProvider` cannot express (non-Bearer token types, extra headers). */
	readonly authHeaders?: () => MaybePromise<Readonly<Record<string, string>>>;
	/** Static extra headers. An `Authorization` entry alongside `auth` is rejected: the SDK spreads `requestInit.headers` after the provider's header and would silently win. */
	readonly headers?: Readonly<Record<string, string>>;
	/** SDK fetch middlewares (`withLogging`, `createMiddleware`, ...) composed around the transport's fetch, outermost first. */
	readonly middlewares?: readonly Middleware[];
	/** Resume a server-side session once (see `McpResumedSession`); a later reconnect always starts fresh. */
	readonly resume?: McpHttpResumeOptions;
	/** Overrides for the SSE stream reconnection policy (see `MCP_HTTP_RECONNECTION_DEFAULTS`). */
	readonly reconnection?: Partial<StreamableHTTPReconnectionOptions>;
	/** Principal id partitioning `'private'` cache entries. Defaults to a digest of the credential identity when `auth` is set. */
	readonly cachePartition?: string;
	readonly responseCacheStore?: ResponseCacheStore;
	readonly defaultCacheTtlMs?: number;
}

export function httpConnection<const Id extends string>(
	options: McpHttpConnectionOptions<Id>,
): McpConnectionDefinition<Id> {
	const {
		url,
		transportOptions,
		auth,
		authHeaders,
		headers,
		middlewares,
		resume,
		reconnection,
		cachePartition,
		responseCacheStore,
		defaultCacheTtlMs,
		...definition
	} = options;
	const endpoint = typeof url === "string" ? new URL(url) : new URL(url.href);
	if (headers !== undefined && auth !== undefined) {
		for (const name of Object.keys(headers)) {
			if (name.toLowerCase() === "authorization") {
				throw new KmcpError(
					KMCP_ERROR_CODES.INVALID_DEFINITION,
					"headers.Authorization would silently override the auth provider; pass one or the other.",
				);
			}
		}
	}
	if (middlewares !== undefined && middlewares.some((entry) => typeof entry !== "function")) {
		throw new TypeError("middlewares must be functions.");
	}
	const authProvider = auth === undefined ? undefined : toAuthProvider(auth);
	const oauthProvider = auth !== undefined && isOAuthClientProvider(auth) ? auth : undefined;
	const grant = oauthProvider === undefined ? undefined : oauthGrantOf(oauthProvider);
	const oauth = grant === "authorization_code" ? oauthProvider : undefined;
	const grantExtensions =
		grant === "client_credentials"
			? { [MCP_CLIENT_CREDENTIALS_EXTENSION]: {} }
			: grant === "jwt_bearer"
				? { [MCP_ENTERPRISE_MANAGED_AUTH_EXTENSION]: {} }
				: {};
	const partition =
		cachePartition ?? (auth === undefined ? undefined : `kmcp:${credentialIdentity(auth)}`);
	const clientOptions: ClientOptions = {
		...definition.clientOptions,
		...(partition === undefined ? {} : { cachePartition: partition }),
		...(responseCacheStore === undefined ? {} : { responseCacheStore }),
		...(defaultCacheTtlMs === undefined ? {} : { defaultCacheTtlMs }),
	};
	const reconnectionOptions: StreamableHTTPReconnectionOptions = {
		...MCP_HTTP_RECONNECTION_DEFAULTS,
		...transportOptions?.reconnectionOptions,
		...reconnection,
	};
	// The resumed session is consumed by the first transport only: a reconnect after the server
	// declared it gone must start a fresh session, or it would resume a dead one forever.
	let pendingResume: McpHttpResumeOptions | undefined = resume;
	const baseFetch = transportOptions?.fetch ?? ((input, init) => globalThis.fetch(input, init));
	const wrappedFetch =
		middlewares === undefined || middlewares.length === 0
			? transportOptions?.fetch
			: applyMiddlewares(...middlewares)(baseFetch);
	const finalFetch =
		authHeaders === undefined ? wrappedFetch : fetchWithAuthHeaders(authHeaders, wrappedFetch);
	return new McpConnectionDefinition({
		...definition,
		clientOptions,
		extensions: { ...grantExtensions, ...definition.extensions },
		transportKind: "streamable-http",
		...(resume === undefined ? {} : { resumed: resume }),
		...(oauth === undefined ? {} : { oauth }),
		transport: () => {
			const resumed = pendingResume;
			pendingResume = undefined;
			return new StreamableHTTPClientTransport(endpoint, {
				...transportOptions,
				reconnectionOptions,
				...(authProvider === undefined ? {} : { authProvider }),
				...(headers === undefined
					? {}
					: { requestInit: { ...transportOptions?.requestInit, headers: { ...headers } } }),
				...(finalFetch === undefined ? {} : { fetch: finalFetch }),
				...(resumed === undefined
					? {}
					: {
							sessionId: resumed.sessionId,
							...(resumed.protocolVersion === undefined
								? {}
								: { protocolVersion: resumed.protocolVersion }),
						}),
			});
		},
	});
}

function toAuthProvider(auth: McpHttpAuth): AuthProvider | OAuthClientProvider {
	if (typeof auth === "string") {
		const token = auth.replace(/^Bearer\s+/i, "").trim();
		assertNonEmpty(token, "bearer token");
		return { token: async () => token };
	}
	return auth;
}

function isOAuthClientProvider(auth: McpHttpAuth): auth is OAuthClientProvider {
	return (
		typeof auth === "object" && auth !== null && "clientMetadata" in auth && "redirectUrl" in auth
	);
}

let anonymousCredentialCounter = 0;
const credentialIdentities = new WeakMap<object, string>();

/** A stable, non-secret identity for a credential: static tokens hash by content, providers by object identity. */
function credentialIdentity(auth: McpHttpAuth): string {
	if (typeof auth === "string") return `token:${fnv(auth.replace(/^Bearer\s+/i, "").trim())}`;
	let identity = credentialIdentities.get(auth);
	if (identity === undefined) {
		anonymousCredentialCounter += 1;
		identity = `provider:${anonymousCredentialCounter}`;
		credentialIdentities.set(auth, identity);
	}
	return identity;
}

function fnv(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function fetchWithAuthHeaders(
	authHeaders: () => MaybePromise<Readonly<Record<string, string>>>,
	base: StreamableHTTPClientTransportOptions["fetch"],
): NonNullable<StreamableHTTPClientTransportOptions["fetch"]> {
	const inner = base ?? ((url, init) => globalThis.fetch(url, init));
	return async (url, init) => {
		const merged = new Headers(init?.headers);
		for (const [name, value] of Object.entries(await authHeaders())) merged.set(name, value);
		return inner(url, { ...init, headers: merged });
	};
}

/**
 * The server-side surface an in-process connection needs. `McpServerDefinition` satisfies it
 * structurally; the interface exists so `kmcp/client` never gains a runtime edge to the
 * authoring layer.
 */
export interface McpInProcessServer {
	handler(options?: CreateMcpHandlerOptions): McpHttpHandler;
	instantiate(context: McpRequestContext): Promise<{
		connect(transport: McpServerTransport): Promise<void>;
		close(): Promise<void>;
	}>;
}

export interface McpInProcessConnectionOptions<Id extends string> extends Omit<
	McpConnectionDefinitionOptions<Id>,
	"transport" | "transportKind" | "oauth"
> {
	readonly definition: McpInProcessServer;
	/** The protocol era the connection negotiates. Default: `"modern"`. */
	readonly era?: McpProtocolEra;
	/** `createMcpHandler` options for the modern arm (`legacy` is always `"reject"`). */
	readonly mcp?: CreateMcpHandlerOptions;
	/** Pass-through `authInfo` handed to the per-request factory, as an HTTP auth gate would. */
	readonly authInfo?: AuthInfo;
}

/**
 * Connects to a server definition inside the current process.
 *
 * - `era: "modern"` drives the official `createMcpHandler` HTTP entry through a
 *   `StreamableHTTPClientTransport` whose `fetch` calls `handler.fetch` directly — the same code
 *   path a real HTTP deployment takes, with no sockets — pinned to
 *   {@link MCP_MODERN_PROTOCOL_VERSION}.
 * - `era: "legacy"` materializes one instance and links it over an `InMemoryTransport` pair.
 *
 * The returned transport owns the server side: closing it also closes the handler or instance.
 * A caller-supplied `clientOptions.versionNegotiation` that contradicts `era` is rejected.
 */
export function inProcessConnection<const Id extends string>(
	options: McpInProcessConnectionOptions<Id>,
): McpConnectionDefinition<Id> {
	const { definition, era = "modern", mcp, authInfo, ...rest } = options;
	if (typeof definition?.handler !== "function" || typeof definition.instantiate !== "function") {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			"inProcessConnection requires a server definition with handler() and instantiate().",
		);
	}
	if (rest.protocolVersion !== undefined) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			"inProcessConnection selects the revision through era; protocolVersion is not accepted.",
		);
	}
	const negotiation = inProcessNegotiation(era, rest.clientOptions?.versionNegotiation);
	return new McpConnectionDefinition({
		...rest,
		clientOptions: { ...rest.clientOptions, versionNegotiation: negotiation },
		transportKind: "in-process",
		transport:
			era === "modern"
				? () => openModernInProcessTransport(definition, mcp, authInfo)
				: () => openLegacyInProcessTransport(definition, authInfo),
	});
}

function inProcessNegotiation(
	era: McpProtocolEra,
	supplied: VersionNegotiationOptions | undefined,
): VersionNegotiationOptions {
	const expected: VersionNegotiationOptions =
		era === "modern" ? { mode: { pin: MCP_MODERN_PROTOCOL_VERSION } } : { mode: "legacy" as const };
	if (supplied === undefined) return expected;
	const mode = supplied.mode;
	const compatible =
		era === "modern"
			? mode === "auto" ||
				(typeof mode === "object" && mode !== null && mode.pin === MCP_MODERN_PROTOCOL_VERSION)
			: mode === "legacy" || mode === undefined;
	if (!compatible) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`clientOptions.versionNegotiation contradicts the requested in-process era '${era}'.`,
		);
	}
	const resolvedMode = mode ?? expected.mode;
	if (resolvedMode === undefined) return expected;
	return { ...supplied, mode: resolvedMode };
}

const IN_PROCESS_URL = "http://localhost/mcp";

async function openModernInProcessTransport(
	definition: McpInProcessServer,
	mcp: CreateMcpHandlerOptions | undefined,
	authInfo: AuthInfo | undefined,
): Promise<Transport> {
	const handler = definition.handler({ ...mcp, legacy: "reject" });
	const requestOptions = authInfo === undefined ? undefined : { authInfo };
	const transport = new StreamableHTTPClientTransport(new URL(IN_PROCESS_URL), {
		fetch: (url, init) => handler.fetch(new Request(url, init), requestOptions),
	});
	return ownServerSide(transport, () => handler.close());
}

async function openLegacyInProcessTransport(
	definition: McpInProcessServer,
	authInfo: AuthInfo | undefined,
): Promise<Transport> {
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const runtime = await definition.instantiate({
		era: "legacy",
		...(authInfo === undefined ? {} : { authInfo }),
	});
	try {
		await runtime.connect(serverSide);
	} catch (error) {
		await runtime.close().catch(() => undefined);
		throw error;
	}
	return ownServerSide(clientSide, () => runtime.close());
}

function ownServerSide<Owned extends Transport>(
	transport: Owned,
	closeServerSide: () => Promise<void>,
): Owned {
	const close = transport.close.bind(transport);
	let closing: Promise<void> | undefined;
	transport.close = () => {
		if (closing === undefined) {
			closing = (async () => {
				try {
					await close();
				} finally {
					await closeServerSide();
				}
			})();
		}
		return closing;
	};
	return transport;
}

export class McpClientSession<const Id extends string = string> implements AsyncDisposable {
	readonly id: Id;
	readonly client: Client;
	#closed = false;
	#closeTask: Promise<void> | undefined;

	constructor(id: Id, client: Client) {
		this.id = id;
		this.client = client;
	}

	/** True once `close()` has started (not merely completed). */
	get closed(): boolean {
		return this.#closed;
	}

	async close(): Promise<void> {
		if (this.#closeTask !== undefined) return this.#closeTask;
		this.#closed = true;
		const task = this.client.close();
		this.#closeTask = task;
		try {
			await task;
		} catch (error) {
			if (this.#closeTask === task) {
				this.#closeTask = undefined;
				this.#closed = false;
			}
			throw error;
		}
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}
}

export interface McpOfficialClientOverrides {
	/** Manager-injected list-changed handlers (generation-fenced), merged into the client options. */
	readonly listChanged?: ListChangedHandlers;
	/** Manager-injected observer for `notifications/resources/updated`, composed BEFORE the user handler. */
	readonly onResourceUpdated?: (
		notification: NotificationTypeMap["notifications/resources/updated"],
	) => void;
}

/** Constructs the official `Client` for a definition and installs its handlers; the single seam the manager uses. */
export function createOfficialClient(
	definition: McpConnectionDefinition,
	overrides: McpOfficialClientOverrides = {},
): Client {
	const client = new Client(definition.clientInfo, {
		...definition.clientOptions,
		...(overrides.listChanged === undefined ? {} : { listChanged: overrides.listChanged }),
	});
	definition.installHandlers(client, overrides);
	return client;
}
