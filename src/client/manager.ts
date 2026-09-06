import {
	AuthorizationServerMismatchError,
	type CacheableRequestOptions,
	type CallToolRequestOptions,
	type CallToolResult,
	type CancelTaskResult,
	type Client,
	type CompleteRequest,
	type CompleteResult,
	type ContentBlock,
	type CreateTaskResult,
	type DiscoverResult,
	type GetPromptResult,
	type GetTaskResult,
	type Implementation,
	InsecureTokenEndpointError,
	InsufficientScopeError,
	IssuerMismatchError,
	type ListChangedHandlers,
	type ListPromptsResult,
	type ListResourceTemplatesResult,
	type ListResourcesResult,
	type ListTasksResult,
	type ListToolsResult,
	LOG_LEVEL_META_KEY,
	type LoggingLevel,
	type McpSubscription,
	MissingRequiredClientCapabilityError,
	OAuthError,
	type Prompt,
	type ProtocolEra,
	ProtocolError,
	type ReadResourceResult,
	RegistrationRejectedError,
	type RequestOptions,
	SdkError,
	SdkHttpError,
	type ServerCapabilities,
	type SubscriptionFilter,
	type Tool,
	type Transport,
	UnauthorizedError,
	UnsupportedProtocolVersionError,
	UrlElicitationRequiredError,
	specTypeSchemas,
} from "@modelcontextprotocol/client";

import { KMCP_ERROR_CODES, KmcpError, errorCode } from "../errors.ts";
import {
	immutableClone,
	isoTimestamp,
	safeClock,
	stableFingerprint,
	waitForCaller,
	type MaybePromise,
} from "../internal/value.ts";
import type { McpCatalogCapability, McpCatalogSection, McpCatalogSnapshot } from "./catalog.ts";
import {
	McpClientSession,
	McpConnectionDefinition,
	type McpOfficialClientOverrides,
	type McpResumedSession,
	type McpTransportKind,
	createOfficialClient,
} from "./connection.ts";
import {
	type McpContractMode,
	type McpContractResult,
	type McpExpectedPrompt,
	type McpExpectedTool,
	checkPromptContract,
	checkToolContract,
} from "./contract.ts";
import { type McpSkill, discoverSkills, resolveSkillUri } from "./skills.ts";
import {
	type McpCreateToolTaskOptions,
	McpTaskClient,
	type McpTaskPollOptions,
	supportsToolTasks,
} from "./tasks.ts";

export type McpConnectionPhase =
	| "authorizing"
	| "connecting"
	| "degraded"
	| "draining"
	| "failed"
	| "offline"
	| "online"
	| "quarantined";

/** A classification of the last failure that is richer than `errorCode` (which only names kmcp codes). */
export interface McpErrorDetail {
	readonly kind: "http" | "kmcp" | "network" | "oauth" | "protocol" | "sdk" | "unknown";
	readonly code: string | number;
	/** Present for HTTP-level failures (`kind: "http"` and OAuth registration rejections). */
	readonly httpStatus?: number;
}

export interface McpWatchSnapshot {
	/** Whether list-change notifications are being delivered for this generation. */
	readonly active: boolean;
	readonly honoredSections: readonly McpCatalogCapability[];
	readonly unhonoredSections: readonly McpCatalogCapability[];
	readonly reason?: "not-advertised" | "not-configured" | "refresh-cap" | "unsupported-era";
	readonly refreshes: number;
	/** How many times the modern listen stream was re-opened after an unexpected drop this generation. */
	readonly reopens: number;
}

/** Whether the connection carries server-side session state (derived from transport and session id). */
export type McpConnectionMode = "stateful" | "stateless";

/**
 * One SDK-level failure the manager observed on a connection's client or transport (a malformed
 * message, a stream error that did not close the transport, reconnect noise). Non-secret and
 * bounded: `message` is stripped of control characters and capped, and never carries headers,
 * tokens or request bodies.
 */
export interface McpConnectionDiagnostic {
	readonly at: string;
	readonly kind: McpErrorDetail["kind"];
	readonly code?: string;
	readonly message: string;
	/** The generation that was current when the error arrived (`0` before the first connect). */
	readonly generation: number;
}

export interface McpKeepaliveSnapshot {
	/** Consecutive failed probes. */
	readonly failures: number;
	readonly lastProbeAt?: string;
	readonly lastFailureAt?: string;
}

export interface McpConnectionSnapshot<Id extends string = string> {
	readonly id: Id;
	readonly label: string;
	readonly tags: Readonly<Record<string, string>>;
	readonly phase: McpConnectionPhase;
	readonly generation: number;
	readonly lastTransitionAt: string;
	readonly connectedAt?: string;
	/** Last successful exchange with the upstream (an operation result or a keepalive probe). */
	readonly lastSeenAt?: string;
	readonly transportKind?: McpTransportKind;
	/** The server-issued `Mcp-Session-Id` (Streamable HTTP), when the server keeps session state. */
	readonly sessionId?: string;
	readonly connectionMode?: McpConnectionMode;
	readonly protocolVersion?: string;
	readonly protocolEra?: ProtocolEra;
	/** Every revision the server advertised in `server/discover` (modern connections only). */
	readonly supportedVersions?: readonly string[];
	/** Self-reported by the upstream and untrusted; a modern anonymous server may have none. */
	readonly serverInfo?: Readonly<Implementation>;
	/** Free-form, model-facing text from the upstream (length-capped, untrusted). */
	readonly instructions?: string;
	readonly capabilities?: ServerCapabilities;
	readonly logLevel?: LoggingLevel;
	readonly errorCode?: string;
	readonly errorDetail?: McpErrorDetail;
	/**
	 * The most recent SDK-level failures observed on this connection's client or transport, oldest
	 * first, bounded by the manager's `diagnostics.keep` (default 20). They are diagnostics only:
	 * none of them changed the phase by itself. Absent while nothing has been recorded.
	 */
	readonly diagnostics?: readonly McpConnectionDiagnostic[];
	readonly watch?: McpWatchSnapshot;
	readonly keepalive?: McpKeepaliveSnapshot;
	/** URIs with an active `resources/subscribe` on the current generation (sorted). */
	readonly subscribedResources?: readonly string[];
	/** Present when the definition opts into reconnection and a failure has occurred. */
	readonly reconnect?: Readonly<{ attempts: number; nextAttemptAt?: string }>;
	readonly catalog?: McpCatalogSnapshot;
}

export interface McpConnectionManagerSnapshot<Id extends string = string> {
	readonly revision: number;
	readonly closed: boolean;
	readonly maxConnections: number;
	readonly connections: readonly McpConnectionSnapshot<Id>[];
}

export type McpConnectionEventType =
	| "catalog.failed"
	| "catalog.refreshed"
	| "connection.authorization.required"
	| "connection.error"
	| "connection.keepalive.failed"
	| "connection.listen.dropped"
	| "connection.listen.reopened"
	| "connection.reconnect.exhausted"
	| "connection.reconnect.scheduled"
	| "connection.registered"
	| "connection.removed"
	| "connection.session.expired"
	| "connection.state.changed"
	| "resource.updated";

export interface McpConnectionEvent<Id extends string = string> {
	readonly revision: number;
	readonly type: McpConnectionEventType;
	readonly occurredAt: string;
	readonly connection: McpConnectionSnapshot<Id>;
	/** Present only on `resource.updated`: the URI the upstream reported as changed. */
	readonly resource?: Readonly<{ uri: string }>;
	/**
	 * Present only on `connection.error`: the SDK-level failure that was observed, classified and
	 * bounded. The connection's id and generation ride on `connection`; the timestamp on
	 * `occurredAt`. The phase did not change because of it.
	 */
	readonly error?: McpConnectionDiagnostic;
}

export type McpConnectionListener<Id extends string = string> = (
	event: McpConnectionEvent<Id>,
) => MaybePromise<void>;

export interface McpConnectionManagerOptions {
	readonly maxConnections?: number;
	readonly maxCatalogItems?: number;
	readonly maxCatalogItemBytes?: number;
	readonly maxCatalogSnapshotBytes?: number;
	readonly maxCatalogDepth?: number;
	readonly maxCatalogStringBytes?: number;
	readonly maxCatalogNodes?: number;
	readonly maxCatalogPropertiesPerObject?: number;
	/** Maximum `instructions` length retained in snapshots. Default: 16 KiB. */
	readonly maxInstructionsLength?: number;
	/** Budget for the Streamable HTTP session-terminating `DELETE` on disconnect (ms). Default: 2000. */
	readonly terminateSessionTimeoutMs?: number;
	readonly now?: () => number;
	readonly onListenerError?: (error: unknown, event: McpConnectionEvent) => MaybePromise<void>;
	/**
	 * The per-connection ring of SDK-level diagnostics kept on the snapshot. `keep` bounds it
	 * (default 20); `false` keeps no ring at all — `connection.error` and `onError` still fire, so a
	 * host that streams the events into its own log pays nothing for the snapshot copy.
	 */
	readonly diagnostics?: Readonly<{ keep: number }> | false;
	/**
	 * Called for every SDK-level failure the manager observed on a connection's client or transport,
	 * with the ORIGINAL error (the snapshot and the event carry only the bounded, non-secret form).
	 * Mirrors the server's `onerror`: best-effort, never awaited, and its own failures are swallowed.
	 */
	readonly onError?: (id: string, error: unknown) => MaybePromise<void>;
}

/** Options for {@link McpConnectionManager.reconcile}. */
export interface McpReconcileOptions {
	/** Remove connections that the supplied set no longer names. Default: `true`. */
	readonly remove?: boolean;
}

/** What {@link McpConnectionManager.reconcile} did, as id lists in the order the work was applied. */
export interface McpReconcileResult<Id extends string = string> {
	/** Newly registered — and deliberately NOT connected: the caller decides when they come up. */
	readonly added: readonly Id[];
	/** Swapped through `replace`, keeping the connect state they had. */
	readonly replaced: readonly Id[];
	/** Already registered with an equivalent definition; left untouched, generation included. */
	readonly unchanged: readonly Id[];
	/** Disconnected and unregistered. Empty when `remove: false`. */
	readonly removed: readonly Id[];
}

/** Optional stale-work fences for an operation admitted to an already-online connection. */
export interface McpConnectionOperationControl {
	readonly expectedGeneration?: number;
	readonly expectedCatalogFingerprint?: string;
}

/** Caller-supplied `_meta` for the request params (trace context, custom keys). Merged with the log-level stamp. */
export interface McpMetaOptions {
	readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * A multi-round-trip retry round to forward verbatim (a gateway relaying a downstream client's
 * `inputResponses` / `requestState` to the upstream that requested them).
 */
export interface McpMrtrForwardOptions {
	readonly inputResponses?: Readonly<Record<string, unknown>>;
	readonly requestState?: string;
}

/** A tool contract to enforce before a call goes out (see `checkToolContract`). */
export interface McpToolContractOption {
	readonly expected: McpExpectedTool;
	/** Default: `"compatible"`. */
	readonly mode?: McpContractMode;
}

export interface McpContractOptions {
	/**
	 * Refuse the call with `TOOL_CONTRACT_MISMATCH` when the tool the upstream advertises now has
	 * drifted from `expected` in a way that breaks this call. The advertised tool comes from the
	 * current catalog when one is published for this generation, else from a `tools/list`.
	 */
	readonly contract?: McpToolContractOption;
}

/** A prompt contract to enforce before `prompts/get` goes out (see `checkPromptContract`). */
export interface McpPromptContractOption {
	readonly expected: McpExpectedPrompt;
	/** Default: `"compatible"`. */
	readonly mode?: McpContractMode;
}

export interface McpGetPromptOptions extends RequestOptions, McpMetaOptions {
	/** Refuse the request with `PROMPT_CONTRACT_MISMATCH` when the advertised prompt has drifted from `expected` in a way that breaks this call. */
	readonly contract?: McpPromptContractOption;
}

export type McpCallToolOptions = CallToolRequestOptions &
	McpMetaOptions &
	McpMrtrForwardOptions &
	McpContractOptions;
export type McpReadOptions = CacheableRequestOptions & McpMetaOptions;
export type McpRequestOptionsWithMeta = RequestOptions & McpMetaOptions;

export interface McpConnectAllOptions {
	/** Disconnect the connections that succeeded when any connect fails, and rethrow. */
	readonly atomic?: boolean;
	readonly signal?: AbortSignal;
}

export interface McpPingResult {
	readonly era: ProtocolEra;
	readonly roundTripMs: number;
}

/** Thrown by `throwIfToolError` for an `isError: true` tool result; carries the error content. */
export class McpToolCallError extends KmcpError {
	readonly content: readonly ContentBlock[];

	constructor(content: readonly ContentBlock[], message = "The tool reported an error.") {
		super(KMCP_ERROR_CODES.TOOL_CALL_FAILED, message);
		this.name = "McpToolCallError";
		this.content = Object.freeze([...content]);
	}
}

/** Thrown when a `contract` check refuses a call; carries the full check result. */
export class McpToolContractError extends KmcpError {
	readonly result: McpContractResult;

	constructor(toolName: string, result: McpContractResult) {
		super(
			KMCP_ERROR_CODES.TOOL_CONTRACT_MISMATCH,
			`Tool '${toolName}' no longer matches its contract: ${result.errors.join(" ")}`,
		);
		this.name = "McpToolContractError";
		this.result = result;
	}
}

/** Thrown when a prompt `contract` check refuses a request; carries the full check result. */
export class McpPromptContractError extends KmcpError {
	readonly result: McpContractResult;

	constructor(promptName: string, result: McpContractResult) {
		super(
			KMCP_ERROR_CODES.PROMPT_CONTRACT_MISMATCH,
			`Prompt '${promptName}' no longer matches its contract: ${result.errors.join(" ")}`,
		);
		this.name = "McpPromptContractError";
		this.result = result;
	}
}

/**
 * The record a later start needs to resume this connection's server-side session (see
 * `McpResumedSession` / `httpConnection({ resume })`), or `undefined` when the server issued no
 * session id. Persist it with the snapshot's `id`; a stateless connection has nothing to resume.
 */
export function resumedSessionFrom(snapshot: McpConnectionSnapshot): McpResumedSession | undefined {
	if (snapshot.sessionId === undefined) return undefined;
	return Object.freeze({
		sessionId: snapshot.sessionId,
		...(snapshot.protocolVersion === undefined
			? {}
			: { protocolVersion: snapshot.protocolVersion }),
		...(snapshot.capabilities === undefined ? {} : { capabilities: snapshot.capabilities }),
		...(snapshot.serverInfo === undefined ? {} : { serverInfo: snapshot.serverInfo }),
		...(snapshot.instructions === undefined ? {} : { instructions: snapshot.instructions }),
	});
}

/** A `CallToolResult` reduced to its stable, consumer-facing parts. */
export interface McpParsedToolResult {
	readonly content: readonly ContentBlock[];
	readonly structuredContent?: Readonly<Record<string, unknown>>;
	readonly meta?: Readonly<Record<string, unknown>>;
	readonly isError: boolean;
}

export interface McpCallToolParsedOptions extends McpCallToolOptions {
	/** Throw `McpToolCallError` on an `isError` result. Default: `true`. */
	readonly raiseOnError?: boolean;
}

/** Parses a raw `CallToolResult` (optionally raising on `isError`) into `McpParsedToolResult`. */
export function parseToolResult(result: CallToolResult, raiseOnError = true): McpParsedToolResult {
	if (raiseOnError) throwIfToolError(result);
	return Object.freeze({
		content: Object.freeze([...(result.content ?? [])]),
		...(result.structuredContent === undefined
			? {}
			: { structuredContent: result.structuredContent as Readonly<Record<string, unknown>> }),
		...(result._meta === undefined
			? {}
			: { meta: result._meta as Readonly<Record<string, unknown>> }),
		isError: result.isError === true,
	});
}

/** Unwraps a `CallToolResult`, throwing `McpToolCallError` when the tool reported an error. */
export function throwIfToolError(result: CallToolResult): CallToolResult {
	if (result.isError === true) {
		const text = result.content
			.filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		throw new McpToolCallError(result.content, text.length > 0 ? text : undefined);
	}
	return result;
}

interface PendingAuthorization {
	readonly transport: Transport;
	readonly client: Client;
}

interface AutoRefreshState {
	count: number;
	lastAt: number;
	timer?: ReturnType<typeof setTimeout>;
	inFlight: boolean;
	pending: boolean;
	capped: boolean;
}

interface KeepaliveState {
	timer?: ReturnType<typeof setTimeout>;
	inFlight: boolean;
	failures: number;
	lastProbeAt?: string;
	lastFailureAt?: string;
}

interface ListenWatchState {
	/** The subscription currently watched for an unexpected drop. */
	subscription?: McpSubscription;
	retryTimer?: ReturnType<typeof setTimeout>;
	reopening: boolean;
	attempts: number;
	reopens: number;
}

/**
 * The dedupe/staleness window one connect attempt owns. `client.onerror` and `transport.onerror`
 * see the SAME error object for a transport-raised failure (the SDK chains a pre-set handler and
 * then calls its own), so the set collapses them to one report; comparing the scope by identity
 * also silences a transport that keeps talking after its generation was abandoned.
 */
interface ErrorScope {
	readonly seen: WeakSet<object>;
}

interface ManagedConnection<Id extends string> {
	definition: McpConnectionDefinition<Id>;
	phase: McpConnectionPhase;
	generation: number;
	activeOperations: number;
	lastTransitionAt: string;
	connectedAt?: string;
	lastSeenAt?: string;
	errorCode?: string;
	errorDetail?: McpErrorDetail;
	catalog?: McpCatalogSnapshot;
	catalogRevision: number;
	session?: McpClientSession<Id>;
	transport?: Transport;
	/** True while the current session was adopted through `definition.resumed` (no handshake ran). */
	resumed: boolean;
	connectTask?: Promise<McpConnectionSnapshot<Id>>;
	disconnectTask?: Promise<McpConnectionSnapshot<Id>>;
	removeTask?: Promise<void>;
	/** Serializes `replace` on this id: a second swap queues behind the one in flight. */
	swapTask?: Promise<McpConnectionSnapshot<Id>>;
	errorScope?: ErrorScope;
	diagnostics?: McpConnectionDiagnostic[];
	quarantinedCleanup?: () => Promise<void>;
	pendingAuthorization?: PendingAuthorization;
	discover?: DiscoverResult;
	logLevel?: LoggingLevel;
	listen?: McpSubscription;
	/** Tail of the `#relisten` chain; a turn awaits it so two openers can never overlap. */
	relistenTask?: Promise<void>;
	listenWatch?: ListenWatchState;
	autoRefresh?: AutoRefreshState;
	keepalive?: KeepaliveState;
	subscribedUris?: Set<string>;
	reconnect?: ReconnectState;
	readonly drainWaiters: Set<() => void>;
}

interface ReconnectState {
	attempts: number;
	timer?: ReturnType<typeof setTimeout>;
	lastSuccessAt?: number;
	nextAttemptAt?: string;
}

interface McpCatalogBounds {
	readonly maxItems: number;
	readonly maxItemBytes: number;
	readonly maxSnapshotBytes: number;
	readonly maxDepth: number;
	readonly maxStringBytes: number;
	readonly maxNodes: number;
	readonly maxPropertiesPerObject: number;
}

const CATALOG_SECTIONS: readonly McpCatalogCapability[] = Object.freeze([
	"tools",
	"prompts",
	"resources",
	"resourceTemplates",
]);

const LISTEN_REOPEN_INITIAL_MS = 1000;
const LISTEN_REOPEN_MAX_MS = 30_000;
const MAX_SUPPORTED_VERSIONS = 32;
const DEFAULT_DIAGNOSTICS_KEEP = 20;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 512;

export class McpConnectionManager<Id extends string = string> implements AsyncDisposable {
	readonly #entries = new Map<Id, ManagedConnection<Id>>();
	readonly #listeners = new Set<McpConnectionListener<Id>>();
	readonly #maxConnections: number;
	readonly #catalogBounds: McpCatalogBounds;
	readonly #maxInstructionsLength: number;
	readonly #terminateSessionTimeoutMs: number;
	readonly #now: () => number;
	readonly #onListenerError:
		((error: unknown, event: McpConnectionEvent<Id>) => MaybePromise<void>) | undefined;
	readonly #onError: ((id: string, error: unknown) => MaybePromise<void>) | undefined;
	readonly #diagnosticsKeep: number;
	#revision = 0;
	#generationSequence = 0;
	#closed = false;
	#closeTask: Promise<void> | undefined;

	constructor(options: McpConnectionManagerOptions = {}) {
		this.#maxConnections = positiveInteger(options.maxConnections ?? 100, "maxConnections");
		this.#catalogBounds = Object.freeze({
			maxItems: positiveInteger(options.maxCatalogItems ?? 10_000, "maxCatalogItems"),
			maxItemBytes: positiveInteger(
				options.maxCatalogItemBytes ?? 256 * 1024,
				"maxCatalogItemBytes",
			),
			maxSnapshotBytes: positiveInteger(
				options.maxCatalogSnapshotBytes ?? 8 * 1024 * 1024,
				"maxCatalogSnapshotBytes",
			),
			maxDepth: positiveInteger(options.maxCatalogDepth ?? 64, "maxCatalogDepth"),
			maxStringBytes: positiveInteger(
				options.maxCatalogStringBytes ?? 64 * 1024,
				"maxCatalogStringBytes",
			),
			maxNodes: positiveInteger(options.maxCatalogNodes ?? 100_000, "maxCatalogNodes"),
			maxPropertiesPerObject: positiveInteger(
				options.maxCatalogPropertiesPerObject ?? 10_000,
				"maxCatalogPropertiesPerObject",
			),
		});
		this.#maxInstructionsLength = positiveInteger(
			options.maxInstructionsLength ?? 16 * 1024,
			"maxInstructionsLength",
		);
		this.#terminateSessionTimeoutMs = positiveInteger(
			options.terminateSessionTimeoutMs ?? 2000,
			"terminateSessionTimeoutMs",
		);
		this.#now = safeClock(options.now ?? Date.now);
		this.#onListenerError = options.onListenerError;
		this.#onError = options.onError;
		this.#diagnosticsKeep =
			options.diagnostics === false
				? 0
				: positiveInteger(
						options.diagnostics?.keep ?? DEFAULT_DIAGNOSTICS_KEEP,
						"diagnostics.keep",
					);
	}

	register(definition: McpConnectionDefinition<Id>): McpConnectionSnapshot<Id> {
		this.#assertOpen();
		if (this.#entries.has(definition.id)) {
			throw new KmcpError(
				KMCP_ERROR_CODES.CONNECTION_DUPLICATE,
				`Connection '${definition.id}' is already registered.`,
			);
		}
		if (this.#entries.size >= this.#maxConnections) {
			throw new RangeError(`Connection capacity of ${this.#maxConnections} was reached.`);
		}
		const entry: ManagedConnection<Id> = {
			definition,
			phase: "offline",
			generation: 0,
			activeOperations: 0,
			resumed: false,
			catalogRevision: 0,
			lastTransitionAt: isoTimestamp(this.#now),
			drainWaiters: new Set(),
			...(definition.logLevel === undefined ? {} : { logLevel: definition.logLevel }),
		};
		this.#entries.set(definition.id, entry);
		this.#publish("connection.registered", entry);
		return this.#snapshotEntry(entry);
	}

	/**
	 * Swaps the definition registered under `definition.id` — a host applying a config edit to one
	 * server without losing its identity, its diagnostics or its place in the snapshot.
	 *
	 * - Registered as `offline` or `failed`: swapped in place, staying down (a recorded failure
	 *   belonged to the OLD definition, so it is cleared).
	 * - Live (`online`, `degraded`, `authorizing`, or a connect/disconnect still settling):
	 *   disconnected first — draining in-flight work exactly as `disconnect` does — then swapped,
	 *   then reconnected only if it was `online`, on a NEW generation talking to the new server.
	 * - `quarantined`: refused; the failed cleanup has to be resolved (`disconnect`) first.
	 *
	 * A definition equivalent to the registered one (same `fingerprint` when the definition exposes
	 * one, else the same object) is a no-op. Concurrent swaps on one id serialize.
	 */
	replace(definition: McpConnectionDefinition<Id>): Promise<McpConnectionSnapshot<Id>> {
		this.#assertOpen();
		if (!(definition instanceof McpConnectionDefinition)) {
			throw new TypeError("replace requires an McpConnectionDefinition.");
		}
		const entry = this.#entry(definition.id);
		const previous = entry.swapTask;
		const task = (async () => {
			await previous?.catch(() => undefined);
			this.#assertOpen();
			if (this.#entries.get(definition.id) !== entry) {
				throw new KmcpError(
					KMCP_ERROR_CODES.CONNECTION_UNKNOWN,
					`Unknown connection '${definition.id}'.`,
				);
			}
			if (sameDefinition(entry.definition, definition)) return this.#snapshotEntry(entry);
			return this.#performReplace(entry, definition);
		})();
		entry.swapTask = task;
		void task
			.catch(() => undefined)
			.then(() => {
				if (entry.swapTask === task) delete entry.swapTask;
			});
		return task;
	}

	/**
	 * Applies a whole desired set of definitions at once — the operation a host performs when the
	 * user edits their server list: registers what is new (WITHOUT connecting it, so the caller
	 * decides when it comes up), `replace`s what changed (keeping the connect state), leaves
	 * equivalent entries completely untouched (generation included), and removes what the set no
	 * longer names unless `remove: false`.
	 *
	 * Reconnecting a replaced connection is best-effort: a server that is down afterwards is left in
	 * the `failed` phase with its reason on the snapshot and still counted under `replaced`, exactly
	 * as `connectAll` without `atomic` reports one bad member. Failures that leave the registry
	 * inconsistent (a quarantined entry, a close that did not complete) are collected and thrown as
	 * an `AggregateError` once every other step has been attempted.
	 */
	async reconcile(
		definitions: readonly McpConnectionDefinition<Id>[],
		options: McpReconcileOptions = {},
	): Promise<McpReconcileResult<Id>> {
		this.#assertOpen();
		const desired = new Map<Id, McpConnectionDefinition<Id>>();
		for (const definition of definitions) {
			if (!(definition instanceof McpConnectionDefinition)) {
				throw new TypeError("reconcile requires McpConnectionDefinition values.");
			}
			if (desired.has(definition.id)) {
				throw new KmcpError(
					KMCP_ERROR_CODES.CONNECTION_DUPLICATE,
					`Connection '${definition.id}' appears twice in the reconciled set.`,
				);
			}
			desired.set(definition.id, definition);
		}
		const added: Id[] = [];
		const replaced: Id[] = [];
		const unchanged: Id[] = [];
		const removed: Id[] = [];
		const failures: unknown[] = [];
		// Removals run first so the capacity they free is available to the additions below.
		if (options.remove !== false) {
			for (const id of [...this.#entries.keys()]) {
				if (desired.has(id)) continue;
				try {
					await this.remove(id);
					removed.push(id);
				} catch (error) {
					failures.push(error);
				}
			}
		}
		for (const [id, definition] of desired) {
			const entry = this.#entries.get(id);
			try {
				if (entry === undefined) {
					this.register(definition);
					added.push(id);
				} else if (sameDefinition(entry.definition, definition)) {
					unchanged.push(id);
				} else {
					await this.replace(definition).catch((error: unknown) => {
						// The swap itself landed whenever the failure is only the reconnect's verdict.
						if (!isReconnectVerdict(error)) throw error;
					});
					replaced.push(id);
				}
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, `${failures.length} connections failed to reconcile.`);
		}
		return Object.freeze({
			added: Object.freeze(added),
			replaced: Object.freeze(replaced),
			unchanged: Object.freeze(unchanged),
			removed: Object.freeze(removed),
		});
	}

	remove(id: Id): Promise<void> {
		this.#assertOpen();
		const entry = this.#entry(id);
		if (entry.removeTask !== undefined) return entry.removeTask;
		let resolveTask!: () => void;
		let rejectTask!: (error: unknown) => void;
		const task = new Promise<void>((resolve, reject) => {
			resolveTask = resolve;
			rejectTask = reject;
		});
		entry.removeTask = task;
		void this.#performRemove(entry).then(
			() => {
				if (entry.removeTask === task) delete entry.removeTask;
				resolveTask();
			},
			(error: unknown) => {
				if (entry.removeTask === task) delete entry.removeTask;
				rejectTask(error);
			},
		);
		return task;
	}

	connect(id: Id, signal?: AbortSignal): Promise<McpConnectionSnapshot<Id>> {
		this.#assertOpen();
		const entry = this.#entry(id);
		if (entry.phase === "quarantined") {
			throw new KmcpError(
				KMCP_ERROR_CODES.CONNECTION_QUARANTINED,
				`Connection '${id}' is quarantined after a cleanup failure.`,
			);
		}
		if (entry.phase === "authorizing") {
			throw new KmcpError(
				KMCP_ERROR_CODES.CONNECTION_AUTHORIZING,
				`Connection '${id}' is waiting for OAuth authorization; call completeAuthorization().`,
			);
		}
		if (entry.removeTask !== undefined) {
			throw new KmcpError(
				KMCP_ERROR_CODES.CONNECTION_NOT_ONLINE,
				`Connection '${id}' is being removed.`,
			);
		}
		if (entry.disconnectTask !== undefined) {
			return waitForCaller(
				entry.disconnectTask.then(() => this.connect(id)),
				signal,
			);
		}
		if (entry.connectTask !== undefined) return waitForCaller(entry.connectTask, signal);
		if (isUsable(entry) && entry.session !== undefined) {
			return Promise.resolve(this.#snapshotEntry(entry));
		}

		let resolveTask!: (snapshot: McpConnectionSnapshot<Id>) => void;
		let rejectTask!: (error: unknown) => void;
		const task = new Promise<McpConnectionSnapshot<Id>>((resolve, reject) => {
			resolveTask = resolve;
			rejectTask = reject;
		});
		entry.connectTask = task;
		void this.#performConnect(entry).then(
			(snapshot) => {
				if (entry.connectTask === task) delete entry.connectTask;
				resolveTask(snapshot);
			},
			(error: unknown) => {
				if (entry.connectTask === task) delete entry.connectTask;
				rejectTask(error);
			},
		);
		return waitForCaller(task, signal);
	}

	/** Connects several connections concurrently; with `atomic`, any failure rolls the others back. */
	async connectAll(
		ids: readonly Id[],
		options: McpConnectAllOptions = {},
	): Promise<readonly McpConnectionSnapshot<Id>[]> {
		this.#assertOpen();
		const results = await Promise.allSettled(ids.map((id) => this.connect(id, options.signal)));
		const failures = results.filter((result) => result.status === "rejected");
		if (failures.length === 0) {
			return results.map(
				(result) => (result as PromiseFulfilledResult<McpConnectionSnapshot<Id>>).value,
			);
		}
		if (options.atomic === true) {
			await Promise.allSettled(
				ids
					.filter((_, index) => results[index]?.status === "fulfilled")
					.map((id) => this.disconnect(id)),
			);
		}
		throw new AggregateError(
			failures.map((failure) => failure.reason),
			`${failures.length} of ${ids.length} connections failed to connect.`,
		);
	}

	disconnect(id: Id): Promise<McpConnectionSnapshot<Id>> {
		const entry = this.#entry(id);
		if (entry.disconnectTask !== undefined) return entry.disconnectTask;
		let resolveTask!: (snapshot: McpConnectionSnapshot<Id>) => void;
		let rejectTask!: (error: unknown) => void;
		const task = new Promise<McpConnectionSnapshot<Id>>((resolve, reject) => {
			resolveTask = resolve;
			rejectTask = reject;
		});
		entry.disconnectTask = task;
		void this.#performDisconnect(entry).then(
			(snapshot) => {
				if (entry.disconnectTask === task) delete entry.disconnectTask;
				resolveTask(snapshot);
			},
			(error: unknown) => {
				if (entry.disconnectTask === task) delete entry.disconnectTask;
				rejectTask(error);
			},
		);
		return task;
	}

	/**
	 * Completes an interactive OAuth round for a connection parked in the `authorizing` phase:
	 * refuses a callback that reports an OAuth `error`, verifies the callback `state` against the
	 * provider (when it issued one), hands the parameters to the SAME transport that raised the
	 * challenge (the SDK requires that), releases it, and reconnects with the freshly stored tokens.
	 * A `state` mismatch leaves the connection parked so the host can retry with the right callback.
	 */
	async completeAuthorization(
		id: Id,
		callbackParams: URLSearchParams,
	): Promise<McpConnectionSnapshot<Id>> {
		this.#assertOpen();
		const entry = this.#entry(id);
		const pending = entry.pendingAuthorization;
		if (pending === undefined) return this.#completeLiveAuthorization(entry, callbackParams);
		if (entry.phase !== "authorizing") {
			throw new KmcpError(
				KMCP_ERROR_CODES.CONNECTION_NOT_ONLINE,
				`Connection '${id}' is not waiting for authorization.`,
			);
		}
		const transport = finishingTransport(pending.transport, id);
		const oauthError = callbackParams.get("error");
		if (oauthError !== null) {
			await this.#releasePendingAuthorization(entry);
			entry.errorCode = KMCP_ERROR_CODES.AUTH_FORBIDDEN;
			entry.errorDetail = { kind: "oauth", code: oauthError.slice(0, 64) };
			this.#transition(entry, "failed");
			throw refusedAuthorization(id, oauthError);
		}
		// A state mismatch is not a failed round: the callback simply is not ours. Stay parked.
		await entry.definition.verifyAuthorizationCallback(callbackParams);
		try {
			await transport.finishAuth(callbackParams);
		} catch (error) {
			// The code is spent and the verifier with it: this round is over. Fail the connection
			// so the next connect() starts a fresh challenge instead of leaving it parked forever.
			await this.#releasePendingAuthorization(entry);
			await entry.definition.finishAuthorizationRound().catch(() => undefined);
			entry.errorCode = KMCP_ERROR_CODES.CONNECTION_CONNECT_FAILED;
			entry.errorDetail = describeError(error);
			this.#transition(entry, "failed");
			throw new KmcpError(
				KMCP_ERROR_CODES.CONNECTION_CONNECT_FAILED,
				`Authorization of '${id}' could not be completed.`,
				{ cause: error },
			);
		}
		await this.#releasePendingAuthorization(entry);
		await entry.definition.finishAuthorizationRound().catch(() => undefined);
		this.#transition(entry, "offline");
		return this.connect(id);
	}

	/**
	 * The live variant of `completeAuthorization`: a 403 `insufficient_scope` step-up (or a 401
	 * after token expiry) surfaces from an OPERATION on an online connection, as the SDK's
	 * `UnauthorizedError`, after the provider was handed the new authorization URL. The manager
	 * announces it as `connection.authorization.required` without leaving the online phase;
	 * finishing auth on the live transport stores the widened tokens and the next operation
	 * carries them. Nothing is reconnected.
	 */
	async #completeLiveAuthorization(
		entry: ManagedConnection<Id>,
		callbackParams: URLSearchParams,
	): Promise<McpConnectionSnapshot<Id>> {
		const id = entry.definition.id;
		if (!isUsable(entry) || entry.transport === undefined || !entry.definition.interactiveOAuth) {
			throw new KmcpError(
				KMCP_ERROR_CODES.CONNECTION_NOT_ONLINE,
				`Connection '${id}' is not waiting for authorization.`,
			);
		}
		const transport = finishingTransport(entry.transport, id);
		const oauthError = callbackParams.get("error");
		if (oauthError !== null) throw refusedAuthorization(id, oauthError);
		await entry.definition.verifyAuthorizationCallback(callbackParams);
		try {
			await transport.finishAuth(callbackParams);
		} catch (error) {
			throw new KmcpError(
				KMCP_ERROR_CODES.OPERATION_FAILED,
				`Authorization of '${id}' could not be completed.`,
				{ cause: error },
			);
		} finally {
			await entry.definition.finishAuthorizationRound().catch(() => undefined);
		}
		this.#publish("connection.state.changed", entry);
		return this.#snapshotEntry(entry);
	}

	async withClient<Result>(
		id: Id,
		operation: (client: Client, session: McpClientSession<Id>) => Promise<Result>,
		signal?: AbortSignal,
		control: McpConnectionOperationControl = {},
	): Promise<Result> {
		if (typeof operation !== "function") throw new TypeError("operation must be a function.");
		this.#assertOpen();
		const entry = this.#entry(id);
		const session = entry.session;
		if (!isUsable(entry) || session === undefined || entry.disconnectTask !== undefined) {
			throw new KmcpError(
				KMCP_ERROR_CODES.CONNECTION_NOT_ONLINE,
				`Connection '${id}' is not online.`,
			);
		}
		throwIfAborted(signal);
		this.#assertOperationControl(entry, control);

		entry.activeOperations += 1;
		try {
			const result = await operation(session.client, session);
			if (entry.session === session) entry.lastSeenAt = isoTimestamp(this.#now);
			return result;
		} catch (error) {
			this.#inspectOperationFailure(entry, session, error);
			throw error;
		} finally {
			entry.activeOperations -= 1;
			if (entry.activeOperations === 0) {
				for (const resolve of entry.drainWaiters) resolve();
				entry.drainWaiters.clear();
			}
		}
	}

	callTool(
		id: Id,
		name: string,
		arguments_: Readonly<Record<string, unknown>> = {},
		options?: McpCallToolOptions,
		control?: McpConnectionOperationControl,
	): Promise<CallToolResult> {
		return this.withClient(
			id,
			async (client) => {
				if (options?.contract !== undefined) {
					await this.#enforceToolContract(id, client, name, arguments_, options.contract);
				}
				const params = this.#params(
					id,
					forwardMrtrCallToolParams(name, arguments_, options),
					options,
				);
				const requestOptions = this.#requestOptions(id, "tool", options);
				// `Client.callTool` validates the result against the tool's advertised outputSchema
				// and rejects a raw `input_required` result ("did not return structured content";
				// SDK client `index.mjs`, callTool output validation). A caller that opted into
				// receiving those results therefore goes through the schema-less request path.
				if (requestOptions.allowInputRequired === true) {
					return client.request({ method: "tools/call", params }, requestOptions);
				}
				return client.callTool(params, requestOptions);
			},
			options?.signal,
			control,
		);
	}

	/**
	 * `callTool` with FastMCP-style ergonomics: raises `McpToolCallError` on an `isError` result
	 * (opt out with `raiseOnError: false`) and returns the stable parsed shape. The SDK client has
	 * already validated `structuredContent` against the tool's advertised output schema. The raw
	 * `callTool` stays the relay primitive (gateways forward MRTR rounds through it verbatim).
	 */
	async callToolParsed(
		id: Id,
		name: string,
		arguments_: Readonly<Record<string, unknown>> = {},
		options?: McpCallToolParsedOptions,
		control?: McpConnectionOperationControl,
	): Promise<McpParsedToolResult> {
		if (options?.allowInputRequired === true) {
			throw new TypeError(
				"callToolParsed cannot surface input_required results; use callTool with allowInputRequired.",
			);
		}
		const { raiseOnError, ...callOptions } = options ?? {};
		const result = await this.callTool(id, name, arguments_, callOptions, control);
		return parseToolResult(result, raiseOnError !== false);
	}

	/**
	 * Compares the tool the upstream advertises now with an expected shape (see
	 * `checkToolContract`). Reads the published catalog when it belongs to the current generation,
	 * else issues a `tools/list`. A tool that is not advertised at all is an error.
	 */
	checkToolContract(
		id: Id,
		name: string,
		expected: McpExpectedTool,
		options: {
			readonly mode?: McpContractMode;
			readonly arguments?: Readonly<Record<string, unknown>>;
			readonly signal?: AbortSignal;
		} = {},
		control?: McpConnectionOperationControl,
	): Promise<McpContractResult> {
		return this.withClient(
			id,
			async (client) => {
				const tool = await this.#advertisedTool(id, client, name, options.signal);
				if (tool === undefined) return notAdvertised("Tool", name);
				return checkToolContract(tool, expected, {
					...(options.mode === undefined ? {} : { mode: options.mode }),
					...(options.arguments === undefined ? {} : { arguments: options.arguments }),
				});
			},
			options.signal,
			control,
		);
	}

	/** Whether the upstream advertises task-augmented `tools/call` on a revision kmcp can drive. */
	supportsToolTasks(id: Id): boolean {
		const entry = this.#entry(id);
		const client = entry.session?.client;
		return client === undefined
			? false
			: supportsToolTasks({
					request: () => Promise.resolve(undefined),
					getProtocolEra: () => this.#era(entry, client),
					getNegotiatedProtocolVersion: () => client.getNegotiatedProtocolVersion(),
					getServerCapabilities: () => this.#capabilities(entry, client),
				});
	}

	/** Issues a task-augmented `tools/call` (2025-11-25); the tool keeps running after this resolves. */
	callToolTask(
		id: Id,
		name: string,
		arguments_: Readonly<Record<string, unknown>> = {},
		options?: McpCreateToolTaskOptions & McpMetaOptions & { readonly signal?: AbortSignal },
		control?: McpConnectionOperationControl,
	): Promise<CreateTaskResult> {
		return this.withClient(
			id,
			(client) =>
				this.#taskClient(this.#entry(id), client).createToolTask(name, arguments_, {
					...(options?.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
					...(options?.pollIntervalMs === undefined
						? {}
						: { pollIntervalMs: options.pollIntervalMs }),
					meta: this.#params(id, {}, options)._meta ?? {},
					request: this.#requestOptions(id, "tool", this.#taskRequest(options)),
				}),
			options?.signal,
			control,
		);
	}

	/** Polls a task until it settles and returns the tool result (see `McpTaskClient.waitForTask`). */
	waitForTask(
		id: Id,
		taskId: string,
		options?: McpTaskPollOptions,
		control?: McpConnectionOperationControl,
	): Promise<CallToolResult> {
		return this.withClient(
			id,
			(client) =>
				this.#taskClient(this.#entry(id), client).waitForTask(taskId, {
					...options,
					request: this.#requestOptions(id, "tool", options?.request),
				}),
			options?.signal,
			control,
		);
	}

	/** `callToolTask` followed by `waitForTask`, reporting every status change through `onUpdate`. */
	callToolViaTask(
		id: Id,
		name: string,
		arguments_: Readonly<Record<string, unknown>> = {},
		options?: McpCreateToolTaskOptions & McpTaskPollOptions & McpMetaOptions,
		control?: McpConnectionOperationControl,
	): Promise<CallToolResult> {
		return this.withClient(
			id,
			(client) =>
				this.#taskClient(this.#entry(id), client).callToolViaTask(name, arguments_, {
					...options,
					meta: this.#params(id, {}, options)._meta ?? {},
					request: this.#requestOptions(id, "tool", this.#taskRequest(options)),
				}),
			options?.signal,
			control,
		);
	}

	getTask(id: Id, taskId: string, options?: McpRequestOptionsWithMeta): Promise<GetTaskResult> {
		return this.withClient(
			id,
			(client) =>
				this.#taskClient(this.#entry(id), client).getTask(
					taskId,
					this.#requestOptions(id, "request", options),
				),
			options?.signal,
		);
	}

	/** Blocks on the server until the task is terminal, then returns the tool result. */
	getTaskResult(
		id: Id,
		taskId: string,
		options?: McpRequestOptionsWithMeta,
	): Promise<CallToolResult> {
		return this.withClient(
			id,
			(client) =>
				this.#taskClient(this.#entry(id), client).getTaskResult(
					taskId,
					this.#requestOptions(id, "tool", options),
				),
			options?.signal,
		);
	}

	listTasks(
		id: Id,
		options?: McpRequestOptionsWithMeta & { readonly cursor?: string },
	): Promise<ListTasksResult> {
		return this.withClient(
			id,
			(client) =>
				this.#taskClient(this.#entry(id), client).listTasks(
					options?.cursor,
					this.#requestOptions(id, "request", options),
				),
			options?.signal,
		);
	}

	cancelTask(
		id: Id,
		taskId: string,
		options?: McpRequestOptionsWithMeta,
	): Promise<CancelTaskResult> {
		return this.withClient(
			id,
			(client) =>
				this.#taskClient(this.#entry(id), client).cancelTask(
					taskId,
					this.#requestOptions(id, "request", options),
				),
			options?.signal,
		);
	}

	/**
	 * Subscribes to `notifications/resources/updated` for one URI. On the legacy era this is the
	 * `resources/subscribe` RPC; on 2026-07-28 that method no longer exists, so the subscription
	 * is expressed by re-opening the `subscriptions/listen` stream with the widened
	 * `resourceSubscriptions` filter (rolled back on failure). Updates surface as
	 * `resource.updated` events. Subscriptions are generation-scoped: they do not survive a
	 * reconnect — re-subscribe when the connection comes back online.
	 */
	subscribeResource(
		id: Id,
		uri: string,
		options?: McpRequestOptionsWithMeta,
		control?: McpConnectionOperationControl,
	): Promise<void> {
		if (typeof uri !== "string" || uri.length === 0) {
			throw new TypeError("uri must be a non-empty string.");
		}
		return this.withClient(
			id,
			async (client, session) => {
				const entry = this.#entry(id);
				if (this.#era(entry, client) === "modern") {
					// `resources/subscribe` does not exist on 2026-07-28: the subscription is
					// expressed purely through the `subscriptions/listen` filter.
					const uris = (entry.subscribedUris ??= new Set());
					const added = !uris.has(uri);
					uris.add(uri);
					let applied: boolean;
					try {
						applied = await this.#relisten(entry, session);
					} catch (error) {
						if (added) uris.delete(uri);
						throw new KmcpError(
							KMCP_ERROR_CODES.OPERATION_FAILED,
							`Updates for '${uri}' could not be honored on the modern listen stream.`,
							{ cause: error },
						);
					}
					if (!applied) {
						// The session was replaced under the call: no live listen filter carries this
						// URI, so reporting success would leave the caller believing it is subscribed.
						if (added) uris.delete(uri);
						throw new KmcpError(
							KMCP_ERROR_CODES.CONNECTION_NOT_ONLINE,
							`Connection '${id}' changed while subscribing to '${uri}'; subscribe again on the new generation.`,
						);
					}
				} else {
					await client.subscribeResource(
						this.#params(id, { uri }, options),
						this.#requestOptions(id, "request", options),
					);
					if (entry.session !== session) return;
					(entry.subscribedUris ??= new Set()).add(uri);
				}
				this.#publish("connection.state.changed", entry);
			},
			options?.signal,
			control,
		);
	}

	/** Removes a resource subscription (over-delivery until the narrowed filter lands is possible). */
	unsubscribeResource(
		id: Id,
		uri: string,
		options?: McpRequestOptionsWithMeta,
		control?: McpConnectionOperationControl,
	): Promise<void> {
		if (typeof uri !== "string" || uri.length === 0) {
			throw new TypeError("uri must be a non-empty string.");
		}
		return this.withClient(
			id,
			async (client, session) => {
				const entry = this.#entry(id);
				if (this.#era(entry, client) === "modern") {
					entry.subscribedUris?.delete(uri);
					// Narrowing is best-effort: failure means over-notification, never silence.
					await this.#relisten(entry, session).catch(() => undefined);
				} else {
					await client.unsubscribeResource(
						this.#params(id, { uri }, options),
						this.#requestOptions(id, "request", options),
					);
					if (entry.session !== session) return;
					entry.subscribedUris?.delete(uri);
				}
				this.#publish("connection.state.changed", entry);
			},
			options?.signal,
			control,
		);
	}

	/**
	 * Tells the upstream this client's roots changed (`notifications/roots/list_changed`).
	 * Legacy-era only: the 2026-07-28 wire removed the roots feature (SEP-2577), so a modern
	 * connection rejects instead of silently dropping the notification.
	 */
	notifyRootsChanged(id: Id, signal?: AbortSignal): Promise<void> {
		return this.withClient(
			id,
			async (client) => {
				if (this.#era(this.#entry(id), client) === "modern") {
					throw new KmcpError(
						KMCP_ERROR_CODES.OPERATION_FAILED,
						"Roots are a legacy-era feature; the 2026-07-28 wire has no roots/list_changed.",
					);
				}
				await client.sendRootsListChanged();
			},
			signal,
		);
	}

	readResource(
		id: Id,
		uri: string,
		options?: McpReadOptions,
		control?: McpConnectionOperationControl,
	): Promise<ReadResourceResult> {
		return this.withClient(
			id,
			(client) =>
				client.readResource(this.#params(id, { uri }, options), {
					cacheMode: "use",
					...this.#requestOptions(id, "resource", options),
				}),
			options?.signal,
			control,
		);
	}

	getPrompt(
		id: Id,
		name: string,
		arguments_: Readonly<Record<string, string>> | undefined,
		options?: McpGetPromptOptions,
		control?: McpConnectionOperationControl,
	): Promise<GetPromptResult> {
		return this.withClient(
			id,
			async (client) => {
				if (options?.contract !== undefined) {
					await this.#enforcePromptContract(id, client, name, arguments_, options.contract);
				}
				return client.getPrompt(
					this.#params(
						id,
						{ name, ...(arguments_ === undefined ? {} : { arguments: { ...arguments_ } }) },
						options,
					),
					this.#requestOptions(id, "prompt", options),
				);
			},
			options?.signal,
			control,
		);
	}

	/** The prompt counterpart of `checkToolContract`: compares the advertised prompt with an expected shape. */
	checkPromptContract(
		id: Id,
		name: string,
		expected: McpExpectedPrompt,
		options: {
			readonly mode?: McpContractMode;
			readonly arguments?: Readonly<Record<string, string>>;
			readonly signal?: AbortSignal;
		} = {},
		control?: McpConnectionOperationControl,
	): Promise<McpContractResult> {
		return this.withClient(
			id,
			async (client) => {
				const prompt = await this.#advertisedPrompt(id, client, name, options.signal);
				if (prompt === undefined) return notAdvertised("Prompt", name);
				return checkPromptContract(prompt, expected, {
					...(options.mode === undefined ? {} : { mode: options.mode }),
					...(options.arguments === undefined ? {} : { arguments: options.arguments }),
				});
			},
			options.signal,
			control,
		);
	}

	/** `completion/complete` for a prompt argument or resource-template variable. */
	complete(
		id: Id,
		params: CompleteRequest["params"],
		options?: McpRequestOptionsWithMeta,
		control?: McpConnectionOperationControl,
	): Promise<CompleteResult> {
		return this.withClient(
			id,
			async (client) => {
				const result = await client.complete(
					this.#params(id, params, options),
					this.#requestOptions(id, "request", options),
				);
				return boundedCompletion(result);
			},
			options?.signal,
			control,
		);
	}

	listTools(
		id: Id,
		options?: McpReadOptions,
		control?: McpConnectionOperationControl,
	): Promise<ListToolsResult> {
		return this.withClient(
			id,
			(client) =>
				this.#list(
					this.#entry(id),
					client,
					"tools",
					this.#params(id, {}, options),
					this.#requestOptions(id, "request", options),
				),
			options?.signal,
			control,
		);
	}

	listResources(
		id: Id,
		options?: McpReadOptions,
		control?: McpConnectionOperationControl,
	): Promise<ListResourcesResult> {
		return this.withClient(
			id,
			(client) =>
				this.#list(
					this.#entry(id),
					client,
					"resources",
					this.#params(id, {}, options),
					this.#requestOptions(id, "request", options),
				),
			options?.signal,
			control,
		);
	}

	listResourceTemplates(
		id: Id,
		options?: McpReadOptions,
		control?: McpConnectionOperationControl,
	): Promise<ListResourceTemplatesResult> {
		return this.withClient(
			id,
			(client) =>
				this.#list(
					this.#entry(id),
					client,
					"resourceTemplates",
					this.#params(id, {}, options),
					this.#requestOptions(id, "request", options),
				),
			options?.signal,
			control,
		);
	}

	listPrompts(
		id: Id,
		options?: McpReadOptions,
		control?: McpConnectionOperationControl,
	): Promise<ListPromptsResult> {
		return this.withClient(
			id,
			(client) =>
				this.#list(
					this.#entry(id),
					client,
					"prompts",
					this.#params(id, {}, options),
					this.#requestOptions(id, "request", options),
				),
			options?.signal,
			control,
		);
	}

	/**
	 * Discovers the skills the upstream exposes (SEP-2640): the `skill://index.json` index first,
	 * then a scan of the resource list for `skill://…/SKILL.md` entries.
	 */
	listSkills(
		id: Id,
		options?: McpReadOptions,
		control?: McpConnectionOperationControl,
	): Promise<readonly McpSkill[]> {
		return this.withClient(
			id,
			(client) => {
				const requestOptions = this.#requestOptions(id, "resource", options);
				return discoverSkills({
					readResource: (uri) =>
						client.readResource(this.#params(id, { uri }, options), requestOptions),
					listResources: () =>
						this.#list(
							this.#entry(id),
							client,
							"resources",
							this.#params(id, {}, options),
							requestOptions,
						),
				});
			},
			options?.signal,
			control,
		);
	}

	/** Reads a skill's `SKILL.md` by name, nested path, or full `skill://` URI (see `resolveSkillUri`). */
	readSkill(
		id: Id,
		reference: string,
		options?: McpReadOptions,
		control?: McpConnectionOperationControl,
	): Promise<ReadResourceResult> {
		return this.readResource(id, resolveSkillUri(reference), options, control);
	}

	/** Liveness: `server/discover` on the modern era, `ping` on the legacy era. */
	ping(id: Id, signal?: AbortSignal): Promise<McpPingResult> {
		return this.withClient(
			id,
			async (client) => {
				const era = this.#era(this.#entry(id), client) ?? "legacy";
				const started = performance.now();
				const options = this.#requestOptions(
					id,
					"request",
					signal === undefined ? undefined : { signal },
				);
				if (era === "modern") await client.discover(options);
				else await client.ping(options);
				return Object.freeze({ era, roundTripMs: performance.now() - started });
			},
			signal,
		);
	}

	/**
	 * A live `server/discover` (2026-07-28): every revision the server supports, its capabilities,
	 * instructions, and the `_meta` carrying its identity, as the server answers right now. The
	 * verdict is retained for the next reconnect's `prior`. Legacy connections have no such
	 * request — the handshake snapshot on the connection snapshot is their equivalent.
	 */
	discover(id: Id, signal?: AbortSignal): Promise<DiscoverResult> {
		return this.withClient(
			id,
			async (client, session) => {
				if (this.#era(this.#entry(id), client) !== "modern") {
					throw new KmcpError(
						KMCP_ERROR_CODES.OPERATION_FAILED,
						`server/discover was introduced in MCP 2026-07-28; this connection negotiated ${client.getNegotiatedProtocolVersion() ?? "a legacy revision"}, whose initialize handshake carries the same information (see the connection snapshot).`,
					);
				}
				const result = await client.discover(
					this.#requestOptions(id, "request", signal === undefined ? undefined : { signal }),
				);
				const entry = this.#entry(id);
				if (entry.session === session) {
					entry.discover = result;
					this.#publish("connection.state.changed", entry);
				}
				return result;
			},
			signal,
		);
	}

	/**
	 * Sets the upstream log level: `logging/setLevel` on a legacy connection; on the modern era the
	 * level is stamped into every subsequent request's `_meta` (the RPC no longer exists).
	 */
	async setLogLevel(id: Id, level: LoggingLevel, signal?: AbortSignal): Promise<void> {
		const entry = this.#entry(id);
		await this.withClient(
			id,
			async (client) => {
				if (this.#era(entry, client) !== "modern") {
					await client.setLoggingLevel(level, signal === undefined ? undefined : { signal });
				}
			},
			signal,
		);
		// Recorded only once the upstream accepted it: a snapshot must not claim a level the server
		// never took, and on the modern era `#params` would start stamping the failed level.
		entry.logLevel = level;
		this.#publish("connection.state.changed", entry);
	}

	refreshCatalog(
		id: Id,
		signal?: AbortSignal,
		control?: McpConnectionOperationControl,
	): Promise<McpCatalogSnapshot> {
		return this.#performRefresh(this.#entry(id), signal, control);
	}

	async #performRefresh(
		entry: ManagedConnection<Id>,
		signal?: AbortSignal,
		control?: McpConnectionOperationControl,
	): Promise<McpCatalogSnapshot> {
		const id = entry.definition.id;
		let admittedSession: McpClientSession<Id> | undefined;
		let admittedGeneration: number | undefined;
		let admittedCatalogRevision: number | undefined;
		try {
			return await this.withClient(
				id,
				async (client, session) => {
					admittedSession = session;
					admittedGeneration = entry.generation;
					admittedCatalogRevision = entry.catalogRevision;
					const generation = admittedGeneration;
					const catalogRevision = admittedCatalogRevision;
					const capabilities = this.#capabilities(entry, client);
					const previous = entry.catalog?.generation === generation ? entry.catalog : undefined;
					const listOptions = {
						...this.#requestOptions(id, "request", signal === undefined ? undefined : { signal }),
						cacheMode: "refresh" as const,
					};
					const discoveries = await Promise.allSettled([
						discoverSection(
							capabilities?.tools !== undefined,
							() =>
								this.#list(entry, client, "tools", this.#params(id, {}), listOptions).then(
									(v) => v.tools,
								),
							previous?.tools,
							this.#catalogBounds,
							signal,
						),
						discoverSection(
							capabilities?.resources !== undefined,
							() =>
								this.#list(entry, client, "resources", this.#params(id, {}), listOptions).then(
									(v) => v.resources,
								),
							previous?.resources,
							this.#catalogBounds,
							signal,
						),
						discoverSection(
							capabilities?.resources !== undefined,
							() =>
								this.#list(
									entry,
									client,
									"resourceTemplates",
									this.#params(id, {}),
									listOptions,
								).then((v) => v.resourceTemplates),
							previous?.resourceTemplates,
							this.#catalogBounds,
							signal,
						),
						discoverSection(
							capabilities?.prompts !== undefined,
							() =>
								this.#list(entry, client, "prompts", this.#params(id, {}), listOptions).then(
									(v) => v.prompts,
								),
							previous?.prompts,
							this.#catalogBounds,
							signal,
						),
					]);
					const tools = settledValue(discoveries[0]);
					const resources = settledValue(discoveries[1]);
					const resourceTemplates = settledValue(discoveries[2]);
					const prompts = settledValue(discoveries[3]);
					throwIfAborted(signal);
					this.#assertRefreshAuthority(entry, session, generation, catalogRevision);

					const totalItems =
						tools.items.length +
						resources.items.length +
						resourceTemplates.items.length +
						prompts.items.length;
					if (totalItems > this.#catalogBounds.maxItems) {
						throw new KmcpError(
							KMCP_ERROR_CODES.CATALOG_LIMIT_EXCEEDED,
							`Catalog contains ${totalItems} items; the limit is ${this.#catalogBounds.maxItems}.`,
						);
					}
					const totalBytes =
						tools.byteSize + resources.byteSize + resourceTemplates.byteSize + prompts.byteSize;
					if (totalBytes > this.#catalogBounds.maxSnapshotBytes) {
						throw catalogLimitError("The catalog snapshot exceeds its configured byte limit.");
					}
					const totalNodes =
						tools.nodeCount + resources.nodeCount + resourceTemplates.nodeCount + prompts.nodeCount;
					if (totalNodes > this.#catalogBounds.maxNodes) {
						throw catalogLimitError("The catalog snapshot exceeds its configured node limit.");
					}
					const fingerprint = stableFingerprint({
						generation,
						tools: sectionFingerprint(tools),
						resources: sectionFingerprint(resources),
						resourceTemplates: sectionFingerprint(resourceTemplates),
						prompts: sectionFingerprint(prompts),
					});

					const catalog = Object.freeze({
						generation,
						fingerprint,
						discoveredAt: isoTimestamp(this.#now),
						totalItems,
						totalBytes,
						totalNodes,
						tools,
						resources,
						resourceTemplates,
						prompts,
					});
					this.#assertRefreshAuthority(entry, session, generation, catalogRevision);
					entry.catalog = catalog;
					entry.catalogRevision += 1;
					delete entry.errorCode;
					delete entry.errorDetail;
					const degraded = [tools, resources, resourceTemplates, prompts].some(
						(section) => section.status === "failed" || section.status === "stale",
					);
					this.#transition(entry, degraded ? "degraded" : "online");
					this.#publish("catalog.refreshed", entry);
					return catalog;
				},
				signal,
				control,
			);
		} catch (error) {
			if (signal?.aborted === true) throw error;
			if (
				admittedSession !== undefined &&
				admittedGeneration !== undefined &&
				admittedCatalogRevision !== undefined &&
				entry.session === admittedSession &&
				entry.generation === admittedGeneration &&
				entry.catalogRevision === admittedCatalogRevision &&
				isUsable(entry) &&
				entry.disconnectTask === undefined
			) {
				entry.errorCode = errorCode(error);
				entry.errorDetail = describeError(error);
				this.#transition(entry, "degraded");
				this.#publish("catalog.failed", entry);
			}
			throw error;
		}
	}

	state(id: Id): McpConnectionSnapshot<Id> {
		return this.#snapshotEntry(this.#entry(id));
	}

	snapshot(): McpConnectionManagerSnapshot<Id> {
		return Object.freeze({
			revision: this.#revision,
			closed: this.#closed,
			maxConnections: this.#maxConnections,
			connections: Object.freeze(
				[...this.#entries.values()]
					.sort((left, right) => left.definition.id.localeCompare(right.definition.id))
					.map((entry) => this.#snapshotEntry(entry)),
			),
		});
	}

	subscribe(listener: McpConnectionListener<Id>): () => void {
		this.#assertOpen();
		if (typeof listener !== "function") throw new TypeError("listener must be a function.");
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	close(): Promise<void> {
		if (this.#closeTask !== undefined) return this.#closeTask;
		this.#closed = true;
		this.#closeTask = this.#closeAll();
		return this.#closeTask;
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}

	/**
	 * The connection's era. A session adopted through `definition.resumed` ran no handshake, so
	 * the SDK reports none; the resumed record's `protocolVersion` decides then.
	 */
	#era(entry: ManagedConnection<Id>, client: Client): ProtocolEra | undefined {
		return client.getProtocolEra() ?? (entry.resumed ? entry.definition.resumed?.era : undefined);
	}

	/** Server capabilities, falling back to the resumed record for a session that ran no handshake. */
	#capabilities(entry: ManagedConnection<Id>, client: Client): ServerCapabilities | undefined {
		return (
			client.getServerCapabilities() ??
			(entry.resumed ? entry.definition.resumed?.capabilities : undefined)
		);
	}

	/** The task seam over a client, with the resumed-session fallbacks applied. */
	#taskClient(entry: ManagedConnection<Id>, client: Client): McpTaskClient {
		return new McpTaskClient({
			request: (request, schema, options) =>
				client.request(request as never, schema as never, options),
			getProtocolEra: () => this.#era(entry, client),
			getNegotiatedProtocolVersion: () =>
				client.getNegotiatedProtocolVersion() ??
				(entry.resumed ? entry.definition.resumed?.protocolVersion : undefined),
			getServerCapabilities: () => this.#capabilities(entry, client),
		});
	}

	/**
	 * The four list verbs. The SDK's own verbs auto-aggregate pages and feed its response cache,
	 * but answer an empty list without a request when the server's capabilities are unknown — the
	 * state a resumed session is in. There kmcp walks the pages itself with the SDK's validators.
	 */
	#list<Kind extends McpListKind>(
		entry: ManagedConnection<Id>,
		client: Client,
		kind: Kind,
		params: Record<string, unknown>,
		options: CacheableRequestOptions,
	): Promise<McpListResult<Kind>> {
		if (!entry.resumed || client.getServerCapabilities() !== undefined) {
			switch (kind) {
				case "tools":
					return client.listTools(params, options) as Promise<McpListResult<Kind>>;
				case "resources":
					return client.listResources(params, options) as Promise<McpListResult<Kind>>;
				case "resourceTemplates":
					return client.listResourceTemplates(params, options) as Promise<McpListResult<Kind>>;
				default:
					return client.listPrompts(params, options) as Promise<McpListResult<Kind>>;
			}
		}
		return walkListPages(client, kind, params, options);
	}

	#params<Params extends Record<string, unknown>>(
		id: Id,
		params: Params,
		options?: McpMetaOptions,
	): Params & { _meta?: Record<string, unknown> } {
		const entry = this.#entries.get(id);
		const stampLevel =
			entry?.logLevel !== undefined &&
			entry.session !== undefined &&
			this.#era(entry, entry.session.client) === "modern"
				? { [LOG_LEVEL_META_KEY]: entry.logLevel }
				: {};
		const meta = { ...stampLevel, ...options?.meta };
		return Object.keys(meta).length === 0 ? params : { ...params, _meta: meta };
	}

	#requestOptions<Options extends RequestOptions>(
		id: Id,
		scope: "prompt" | "request" | "resource" | "tool",
		options: (Options & McpMetaOptions) | undefined,
	): Options {
		const defaults = this.#entries.get(id)?.definition.defaults ?? {};
		const scoped =
			scope === "tool"
				? defaults.toolTimeoutMs
				: scope === "resource"
					? defaults.resourceTimeoutMs
					: scope === "prompt"
						? defaults.promptTimeoutMs
						: undefined;
		const timeout = options?.timeout ?? scoped ?? defaults.timeoutMs;
		const {
			meta: _meta,
			inputResponses: _inputResponses,
			requestState: _requestState,
			contract: _contract,
			...rest
		} = (options ?? {}) as Options & McpMetaOptions & McpMrtrForwardOptions & McpContractOptions;
		void _meta;
		void _inputResponses;
		void _requestState;
		void _contract;
		return {
			...(rest as Options),
			...(timeout === undefined ? {} : { timeout }),
			...(options?.resetTimeoutOnProgress === undefined &&
			defaults.resetTimeoutOnProgress !== undefined
				? { resetTimeoutOnProgress: defaults.resetTimeoutOnProgress }
				: {}),
			...(options?.maxTotalTimeout === undefined && defaults.maxTotalTimeoutMs !== undefined
				? { maxTotalTimeout: defaults.maxTotalTimeoutMs }
				: {}),
			...(options?.onprogress === undefined && defaults.onprogress !== undefined
				? { onprogress: defaults.onprogress }
				: {}),
		};
	}

	/** The per-request options of a task call: the caller's `request` plus its `signal`. */
	#taskRequest(
		options: (McpCreateToolTaskOptions & { readonly signal?: AbortSignal }) | undefined,
	): RequestOptions | undefined {
		if (options === undefined) return undefined;
		return {
			...options.request,
			...(options.signal === undefined ? {} : { signal: options.signal }),
		};
	}

	async #advertisedTool(
		id: Id,
		client: Client,
		name: string,
		signal: AbortSignal | undefined,
	): Promise<Tool | undefined> {
		const entry = this.#entry(id);
		const catalog = entry.catalog;
		if (
			catalog !== undefined &&
			catalog.generation === entry.generation &&
			catalog.tools.status === "fresh"
		) {
			return catalog.tools.items.find((tool) => tool.name === name);
		}
		const listed = await this.#list(
			entry,
			client,
			"tools",
			this.#params(id, {}),
			this.#requestOptions(id, "request", signal === undefined ? undefined : { signal }),
		);
		return listed.tools.find((tool) => tool.name === name);
	}

	async #enforceToolContract(
		id: Id,
		client: Client,
		name: string,
		arguments_: Readonly<Record<string, unknown>>,
		contract: McpToolContractOption,
	): Promise<void> {
		const tool = await this.#advertisedTool(id, client, name, undefined);
		const result =
			tool === undefined
				? notAdvertised("Tool", name)
				: checkToolContract(tool, contract.expected, {
						mode: contract.mode ?? "compatible",
						arguments: arguments_,
					});
		if (!result.valid) throw new McpToolContractError(name, result);
	}

	async #advertisedPrompt(
		id: Id,
		client: Client,
		name: string,
		signal: AbortSignal | undefined,
	): Promise<Prompt | undefined> {
		const entry = this.#entry(id);
		const catalog = entry.catalog;
		if (
			catalog !== undefined &&
			catalog.generation === entry.generation &&
			catalog.prompts.status === "fresh"
		) {
			return catalog.prompts.items.find((prompt) => prompt.name === name);
		}
		const listed = await this.#list(
			entry,
			client,
			"prompts",
			this.#params(id, {}),
			this.#requestOptions(id, "request", signal === undefined ? undefined : { signal }),
		);
		return listed.prompts.find((prompt) => prompt.name === name);
	}

	async #enforcePromptContract(
		id: Id,
		client: Client,
		name: string,
		arguments_: Readonly<Record<string, string>> | undefined,
		contract: McpPromptContractOption,
	): Promise<void> {
		const prompt = await this.#advertisedPrompt(id, client, name, undefined);
		const result =
			prompt === undefined
				? notAdvertised("Prompt", name)
				: checkPromptContract(prompt, contract.expected, {
						mode: contract.mode ?? "compatible",
						...(arguments_ === undefined ? {} : { arguments: arguments_ }),
					});
		if (!result.valid) throw new McpPromptContractError(name, result);
	}

	async #performConnect(entry: ManagedConnection<Id>): Promise<McpConnectionSnapshot<Id>> {
		if (entry.activeOperations > 0) await this.#waitUntilDrained(entry);
		this.#transition(entry, "connecting");
		// A fresh dedupe/staleness window per attempt: whatever the abandoned transport of the
		// previous attempt still emits is no longer this connection's story.
		const scope: ErrorScope = { seen: new WeakSet() };
		entry.errorScope = scope;
		let transport: Transport | undefined;
		let session: McpClientSession<Id> | undefined;
		const definition = entry.definition;
		// Noted BEFORE the transport is opened: the factory only PEEKS at the one-shot resume
		// record, so this generation owns the decision to consume it (after a successful connect)
		// or to burn it (after the server declared the session gone).
		const resuming = definition.resumePending;
		try {
			transport = await definition.openTransport();
			// Armed BEFORE `client.connect`, which chains a pre-set `transport.onerror` ahead of its
			// own: that covers the probe/handshake window too, where the client is not attached yet.
			this.#watchErrors(entry, scope, transport);
			let liveSession: McpClientSession<Id> | undefined;
			const listChanged = this.#listChangedHandlers(entry, () => liveSession);
			const client = this.#createClient(entry, resuming, {
				...(listChanged === undefined ? {} : { listChanged }),
				onResourceUpdated: (notification) => {
					if (liveSession === undefined || entry.session !== liveSession) return;
					this.#publish("resource.updated", entry, {
						resource: Object.freeze({ uri: notification.params.uri }),
					});
				},
			});
			this.#watchErrors(entry, scope, client);
			session = new McpClientSession(definition.id, client);
			liveSession = session;
			const closingSession = session;
			client.onclose = () => {
				this.#handleUnexpectedClose(entry, closingSession, KMCP_ERROR_CODES.CONNECTION_NOT_ONLINE);
			};
			await client.connect(transport, this.#connectOptions(entry));
			// The one-shot resume is spent only once a connect actually succeeded with it; a failed
			// attempt leaves it pending so the retry resumes rather than handshaking blind.
			if (resuming) definition.consumeResume();
			const generation = nextGeneration(this.#generationSequence);
			this.#generationSequence = generation;
			entry.session = session;
			entry.transport = transport;
			// No negotiated revision after a successful connect means the SDK adopted the session the
			// transport carried instead of running a handshake (it skips one whenever the transport
			// already has a session id) — whatever the definition's `resumed` record says. The
			// era/capability fallbacks and the page-walking list verbs hang off this flag, so it must
			// track what the SDK actually did, not what the definition intended.
			entry.resumed = client.getProtocolEra() === undefined;
			entry.generation = generation;
			delete entry.catalog;
			delete entry.autoRefresh;
			delete entry.subscribedUris;
			// A handle from the previous generation belongs to a closed client: dropping it lets
			// `#watchListen` arm for the new session instead of guarding against a dead stream.
			delete entry.listen;
			delete entry.listenWatch;
			if (entry.reconnect !== undefined) {
				entry.reconnect.lastSuccessAt = this.#now();
				if (definition.reconnect?.resetAfterMs === undefined) entry.reconnect.attempts = 0;
				delete entry.reconnect.nextAttemptAt;
			}
			entry.connectedAt = isoTimestamp(this.#now);
			entry.lastSeenAt = entry.connectedAt;
			delete entry.errorCode;
			delete entry.errorDetail;
			const discover = client.getDiscoverResult();
			if (discover !== undefined) entry.discover = discover;
			else delete entry.discover;
			await this.#repairListen(entry, session);
			if (entry.listen === undefined) {
				this.#watchListen(entry, session, client.autoOpenedSubscription);
			}
			this.#transition(entry, "online");
			this.#startKeepalive(entry, session);
			return this.#snapshotEntry(entry);
		} catch (error) {
			// A resume the server refused as gone (404 / expired session) must not be replayed: burn
			// it here so the reconnect this failure schedules runs a fresh handshake.
			if (resuming && isSessionExpiryVerdict(error)) definition.consumeResume();
			if (
				transport !== undefined &&
				session !== undefined &&
				definition.interactiveOAuth &&
				error instanceof UnauthorizedError
			) {
				entry.pendingAuthorization = { transport, client: session.client };
				entry.errorCode = KMCP_ERROR_CODES.CONNECTION_AUTHORIZING;
				entry.errorDetail = describeError(error);
				this.#transition(entry, "authorizing");
				this.#publish("connection.authorization.required", entry);
				throw new KmcpError(
					KMCP_ERROR_CODES.CONNECTION_AUTHORIZING,
					`Connection '${definition.id}' requires OAuth authorization; complete it with completeAuthorization().`,
					{ cause: error },
				);
			}
			const cleanup = cleanupAfterFailedConnect(session, transport);
			if (cleanup !== undefined) {
				try {
					await this.#bounded(cleanup(), definition.disconnectTimeoutMs, "close");
				} catch (cleanupError) {
					entry.quarantinedCleanup = cleanup;
					entry.errorCode = KMCP_ERROR_CODES.CONNECTION_CLOSE_FAILED;
					// The reported code is the CLEANUP failure's, so the detail must describe that one
					// too; the connect error travels on as the AggregateError's first cause.
					entry.errorDetail = describeError(cleanupError);
					this.#transition(entry, "quarantined");
					throw new KmcpError(
						KMCP_ERROR_CODES.CONNECTION_CLOSE_FAILED,
						`Failed to clean up the unsuccessful connection '${definition.id}'.`,
						{
							cause: new AggregateError([error, cleanupError], "Connect and cleanup both failed."),
						},
					);
				}
			}
			entry.errorCode = KMCP_ERROR_CODES.CONNECTION_CONNECT_FAILED;
			entry.errorDetail = describeError(error);
			this.#transition(entry, "failed");
			throw new KmcpError(
				KMCP_ERROR_CODES.CONNECTION_CONNECT_FAILED,
				`Failed to connect '${definition.id}'.`,
				{ cause: error },
			);
		}
	}

	/**
	 * The official client for one generation. Strict capability enforcement is a PER-GENERATION
	 * decision: a generation that adopts a server-side session runs no handshake, so the client
	 * learns no capabilities and every verb would fail `assertCapabilityForMethod` (kmcp walks the
	 * list verbs' pages itself instead). The definition already resolves that for a resume it still
	 * holds — honoring an explicit `clientOptions.enforceStrictCapabilities` pin — and the manager
	 * adds the case only it can see: a definition whose one-shot record is already spent while its
	 * transport keeps handing back the same session id, so the SDK skips the handshake again.
	 */
	#createClient(
		entry: ManagedConnection<Id>,
		resuming: boolean,
		overrides: McpOfficialClientOverrides,
	): Client {
		const definition = entry.definition;
		const pinned = resuming && definition.enforceStrictCapabilities;
		const adopting = resuming || definition.resumed !== undefined;
		return createOfficialClient(definition, {
			...overrides,
			...(adopting && !pinned ? { enforceStrictCapabilities: false } : {}),
		});
	}

	#connectOptions(entry: ManagedConnection<Id>) {
		const base = entry.definition.connectOptions;
		if (base?.prior !== undefined || entry.discover === undefined) return base;
		// Reuse the previous modern verdict to skip the probe (same manager, same credentials).
		return { ...base, prior: { kind: "modern" as const, discover: entry.discover } };
	}

	/**
	 * The single path for a session that ended without a deliberate lifecycle transition: the
	 * transport's `onclose`, a keepalive verdict, or a server declaring the session expired. It
	 * releases the session, records why, transitions to `failed`, and hands over to the reconnect
	 * policy. Idempotent per session: only the entry's CURRENT session can fail it.
	 */
	#handleUnexpectedClose(
		entry: ManagedConnection<Id>,
		session: McpClientSession<Id>,
		code: string,
		detail?: McpErrorDetail,
		announce?: McpConnectionEventType,
	): boolean {
		if (entry.session !== session || entry.phase === "draining" || entry.phase === "offline") {
			return false;
		}
		delete entry.session;
		delete entry.transport;
		delete entry.connectedAt;
		// The generation is over: whatever the dead transport still emits is not this connection's.
		delete entry.errorScope;
		// The stream belongs to the dead client; closing it would only talk to a closed transport.
		// Dropping the handle keeps `#watchListen` free to arm for the next session.
		delete entry.listen;
		entry.resumed = false;
		entry.errorCode = code;
		if (detail === undefined) delete entry.errorDetail;
		else entry.errorDetail = detail;
		this.#transition(entry, "failed");
		// The cause is announced before any reconnect is scheduled, so a listener sees why first.
		if (announce !== undefined) this.#publish(announce, entry);
		this.#scheduleReconnect(entry);
		return true;
	}

	/**
	 * Recognizes a server that declared the Streamable HTTP session gone (HTTP 404 on a request
	 * that carried a session id). The spec requires the client to start a new session; the manager
	 * fails the generation and lets the reconnect policy open one.
	 */
	#inspectOperationFailure(
		entry: ManagedConnection<Id>,
		session: McpClientSession<Id>,
		error: unknown,
	): void {
		if (entry.session !== session) return;
		if (
			entry.definition.interactiveOAuth &&
			findCause(
				error,
				(candidate): candidate is UnauthorizedError => candidate instanceof UnauthorizedError,
			) !== undefined
		) {
			// The transport already handed the provider a new authorization URL (a 403 step-up or a
			// 401 the refresh could not fix); the host completes it on the live connection.
			this.#publish("connection.authorization.required", entry);
			return;
		}
		if (entry.transport?.sessionId === undefined) return;
		const http = findCause(
			error,
			(candidate): candidate is SdkHttpError => candidate instanceof SdkHttpError,
		);
		if (http === undefined || http.status !== 404) return;
		const failed = this.#handleUnexpectedClose(
			entry,
			session,
			KMCP_ERROR_CODES.CONNECTION_SESSION_EXPIRED,
			{ kind: "http", code: 404, httpStatus: 404 },
			"connection.session.expired",
		);
		if (failed) void session.close().catch(() => undefined);
	}

	/**
	 * Manager-owned `ClientOptions.listChanged` handlers: `autoRefresh: false` (kmcp performs its own
	 * bounded, fingerprinted refresh) and fenced on the session so a notification arriving after a
	 * reconnect can never restamp a stale catalog.
	 */
	#listChangedHandlers(
		entry: ManagedConnection<Id>,
		session: () => McpClientSession<Id> | undefined,
	): ListChangedHandlers | undefined {
		if (entry.definition.autoRefreshCatalog === undefined) return undefined;
		const policy = entry.definition.autoRefreshCatalog;
		const onChanged = () => this.#scheduleAutoRefresh(entry, session());
		const handler = {
			autoRefresh: false as const,
			onChanged,
			...(policy.debounceMs === undefined ? {} : { debounceMs: policy.debounceMs }),
		};
		return { tools: handler, prompts: handler, resources: handler };
	}

	#scheduleAutoRefresh(
		entry: ManagedConnection<Id>,
		session: McpClientSession<Id> | undefined,
	): void {
		const policy = entry.definition.autoRefreshCatalog;
		if (policy === undefined || session === undefined || entry.session !== session) return;
		if (!isUsable(entry) || entry.disconnectTask !== undefined || this.#closed) return;
		const state = (entry.autoRefresh ??= {
			count: 0,
			lastAt: 0,
			inFlight: false,
			pending: false,
			capped: false,
		});
		if (state.capped) return;
		if (state.count >= policy.maxRefreshesPerGeneration) {
			state.capped = true;
			entry.errorCode = KMCP_ERROR_CODES.CATALOG_STALE;
			entry.errorDetail = { kind: "kmcp", code: KMCP_ERROR_CODES.CATALOG_STALE };
			this.#transition(entry, "degraded");
			this.#publish("catalog.failed", entry);
			return;
		}
		if (state.inFlight) {
			// Single-flight: one refresh at a time per connection; a change observed meanwhile
			// schedules exactly one follow-up once the running refresh settles.
			state.pending = true;
			return;
		}
		if (state.timer !== undefined) return;
		const wait = Math.max(0, state.lastAt + policy.minIntervalMs - this.#now());
		const timer = setTimeout(() => {
			delete state.timer;
			if (entry.session !== session || !isUsable(entry) || entry.autoRefresh !== state) return;
			state.lastAt = this.#now();
			state.count += 1;
			state.inFlight = true;
			void this.refreshCatalog(entry.definition.id)
				.catch((error: unknown) => {
					// A refresh that never committed a catalog — the connection flapped, or a newer
					// generation/catalog fenced it — must not burn the generation's budget, or the cap
					// would report `CATALOG_STALE` for a catalog nothing ever tried to refresh.
					if (entry.autoRefresh === state && !refreshWasAttempted(error)) state.count -= 1;
				})
				.finally(() => {
					state.inFlight = false;
					if (state.pending) {
						state.pending = false;
						this.#scheduleAutoRefresh(entry, session);
					}
				});
		}, wait);
		timer.unref?.();
		state.timer = timer;
	}

	/**
	 * Schedules an automatic reconnect after an UNEXPECTED close, per the definition's `reconnect`
	 * policy. The timer callback re-enters the PUBLIC `connect()` — single-flight dedupe,
	 * queue-behind-disconnect, removal/quarantine/authorizing rejection, and the fresh-generation
	 * discipline are all inherited rather than re-implemented. Deliberate lifecycle transitions
	 * cancel the pending timer at the `#transition` chokepoint.
	 */
	#scheduleReconnect(entry: ManagedConnection<Id>): void {
		const policy = entry.definition.reconnect;
		if (policy === undefined || this.#closed) return;
		if (entry.phase !== "failed") return;
		if (entry.removeTask !== undefined || entry.disconnectTask !== undefined) return;
		if (entry.pendingAuthorization !== undefined || entry.quarantinedCleanup !== undefined) return;
		const state = (entry.reconnect ??= { attempts: 0 });
		if (state.timer !== undefined) return;
		if (
			policy.resetAfterMs !== undefined &&
			state.lastSuccessAt !== undefined &&
			this.#now() - state.lastSuccessAt >= policy.resetAfterMs
		) {
			state.attempts = 0;
		}
		if (state.attempts >= policy.maxAttempts) {
			delete state.nextAttemptAt;
			this.#publish("connection.reconnect.exhausted", entry);
			return;
		}
		let delay = Math.min(policy.maxMs, policy.initialMs * policy.factor ** state.attempts);
		if (policy.jitter) delay *= 0.5 + Math.random() * 0.5;
		state.attempts += 1;
		state.nextAttemptAt = isoTimestamp(() => this.#now() + delay);
		const timer = setTimeout(() => {
			if (entry.reconnect === state) {
				delete state.timer;
				delete state.nextAttemptAt;
			}
			if (this.#closed || entry.reconnect !== state) return;
			if (
				entry.phase !== "failed" ||
				entry.removeTask !== undefined ||
				entry.disconnectTask !== undefined
			) {
				return;
			}
			try {
				void this.connect(entry.definition.id).then(undefined, () =>
					this.#scheduleReconnect(entry),
				);
			} catch {
				this.#scheduleReconnect(entry);
			}
		}, delay);
		timer.unref?.();
		state.timer = timer;
		this.#publish("connection.reconnect.scheduled", entry);
	}

	#cancelReconnectTimer(entry: ManagedConnection<Id>): void {
		const state = entry.reconnect;
		if (state === undefined) return;
		if (state.timer !== undefined) clearTimeout(state.timer);
		delete state.timer;
		delete state.nextAttemptAt;
	}

	/**
	 * Periodic liveness probes for an online session. A probe is `ping` (legacy) or
	 * `server/discover` (modern) with the keepalive timeout; a success refreshes `lastSeenAt`, and
	 * `failureThreshold` consecutive failures close the session as an UNEXPECTED close so the
	 * definition's `reconnect` policy takes over. Probes never overlap.
	 */
	#startKeepalive(entry: ManagedConnection<Id>, session: McpClientSession<Id>): void {
		const policy = entry.definition.keepalive;
		if (policy === undefined) return;
		const state: KeepaliveState = { inFlight: false, failures: 0 };
		entry.keepalive = state;
		const schedule = (): void => {
			if (entry.session !== session || entry.keepalive !== state || this.#closed) return;
			const timer = setTimeout(() => {
				delete state.timer;
				void probe();
			}, policy.intervalMs);
			timer.unref?.();
			state.timer = timer;
		};
		const probe = async (): Promise<void> => {
			if (entry.session !== session || entry.keepalive !== state) return;
			if (!isUsable(entry) || entry.disconnectTask !== undefined || this.#closed) return;
			if (state.inFlight) {
				schedule();
				return;
			}
			state.inFlight = true;
			const client = session.client;
			try {
				if (this.#era(entry, client) === "modern") {
					await client.discover({ timeout: policy.timeoutMs });
				} else {
					await client.ping({ timeout: policy.timeoutMs });
				}
				if (entry.session === session) {
					state.failures = 0;
					state.lastProbeAt = isoTimestamp(this.#now);
					entry.lastSeenAt = state.lastProbeAt;
				}
			} catch (error) {
				if (entry.session !== session || entry.keepalive !== state) return;
				state.failures += 1;
				state.lastProbeAt = isoTimestamp(this.#now);
				state.lastFailureAt = state.lastProbeAt;
				this.#publish("connection.keepalive.failed", entry);
				if (state.failures >= policy.failureThreshold) {
					const failed = this.#handleUnexpectedClose(
						entry,
						session,
						KMCP_ERROR_CODES.CONNECTION_KEEPALIVE_FAILED,
						describeError(error),
					);
					if (failed) void session.close().catch(() => undefined);
					return;
				}
			} finally {
				state.inFlight = false;
			}
			schedule();
		};
		schedule();
	}

	/**
	 * Stops the probe timer but KEEPS the counters: the very snapshot that reports
	 * `CONNECTION_KEEPALIVE_FAILED` is published from inside the transition this call belongs to,
	 * and it must still carry the `failures`/`lastFailureAt` that explain the verdict. The next
	 * successful connect installs a fresh state; a deliberate disconnect to `offline` drops it.
	 */
	#stopKeepalive(entry: ManagedConnection<Id>): void {
		const state = entry.keepalive;
		if (state === undefined) return;
		if (state.timer !== undefined) clearTimeout(state.timer);
		delete state.timer;
	}

	/**
	 * A connect that adopted a `prior` verdict registers the list-changed handlers but does not
	 * open the modern `subscriptions/listen` stream; open it here so auto-refresh keeps working.
	 */
	async #repairListen(entry: ManagedConnection<Id>, session: McpClientSession<Id>): Promise<void> {
		const client = session.client;
		if (
			entry.definition.autoRefreshCatalog === undefined ||
			this.#era(entry, client) !== "modern" ||
			client.autoOpenedSubscription !== undefined
		) {
			return;
		}
		if (Object.keys(this.#listenFilter(entry, client)).length === 0) return;
		try {
			await this.#relisten(entry, session);
		} catch {
			delete entry.listen;
			// This is the ONLY opener for such a generation (the SDK re-listens for nobody), so a
			// failed open must arm the same backoff a mid-session drop gets; otherwise every
			// list-change and resource update is silently dead until the next reconnect.
			const state = (entry.listenWatch ??= { reopening: false, attempts: 0, reopens: 0 });
			delete state.subscription;
			this.#scheduleRelisten(entry, session, state);
		}
	}

	#listenFilter(entry: ManagedConnection<Id>, client: Client): SubscriptionFilter {
		const auto = entry.definition.autoRefreshCatalog !== undefined;
		const capabilities = this.#capabilities(entry, client);
		return {
			...(auto && capabilities?.tools?.listChanged === true ? { toolsListChanged: true } : {}),
			...(auto && capabilities?.prompts?.listChanged === true ? { promptsListChanged: true } : {}),
			...(auto && capabilities?.resources?.listChanged === true
				? { resourcesListChanged: true }
				: {}),
			...(entry.subscribedUris !== undefined && entry.subscribedUris.size > 0
				? { resourceSubscriptions: [...entry.subscribedUris].sort() }
				: {}),
		};
	}

	/**
	 * (Re-)opens the manager-owned modern listen stream so its filter matches the current
	 * list-changed policy plus the subscribed resource URIs (the SDK's bare `resources/subscribe`
	 * never widens the filter, so a modern subscription delivers nothing without this). The new
	 * stream opens BEFORE the old one closes — over-delivery in the overlap, never a gap — and
	 * the SDK's own auto-opened stream is closed so list changes are not double-delivered.
	 *
	 * SERIALIZED per connection: two overlapping calls (two `subscribeResource`s, or one racing the
	 * drop retry) would each read `entry.listen`, open a stream, and close only what they read —
	 * orphaning one open stream for the life of the generation (duplicate notifications, double
	 * auto-refresh). Resolves `true` when the filter was applied to the live session, `false` when
	 * the call was short-circuited because the session moved on (or the era is not modern).
	 */
	async #relisten(entry: ManagedConnection<Id>, session: McpClientSession<Id>): Promise<boolean> {
		const previousTurn = entry.relistenTask;
		let release!: () => void;
		const turn = new Promise<void>((resolve) => {
			release = resolve;
		});
		entry.relistenTask = turn;
		try {
			// Never rejects: each turn settles its gate in `finally`.
			if (previousTurn !== undefined) await previousTurn;
			return await this.#applyListenFilter(entry, session);
		} finally {
			release();
			if (entry.relistenTask === turn) delete entry.relistenTask;
		}
	}

	/** One serialized turn of `#relisten`; never call it outside that gate. */
	async #applyListenFilter(
		entry: ManagedConnection<Id>,
		session: McpClientSession<Id>,
	): Promise<boolean> {
		const client = session.client;
		if (this.#era(entry, client) !== "modern" || entry.session !== session) return false;
		const filter = this.#listenFilter(entry, client);
		const previous = entry.listen;
		if (Object.keys(filter).length === 0) {
			delete entry.listen;
			this.#watchListen(entry, session, undefined);
			await previous?.close().catch(() => undefined);
			return true;
		}
		const next = await client.listen(filter);
		if (entry.session !== session || entry.listen !== previous) {
			// The session was replaced (or, defensively, another opener won) while the stream was
			// opening: this one is nobody's and would deliver duplicates forever.
			await next.close().catch(() => undefined);
			return false;
		}
		entry.listen = next;
		this.#watchListen(entry, session, next);
		await previous?.close().catch(() => undefined);
		await client.autoOpenedSubscription?.close().catch(() => undefined);
		return true;
	}

	/**
	 * Watches a modern listen stream for an UNEXPECTED drop (`closed` resolving `'remote'`) and
	 * re-opens it with backoff (1 s → 30 s) for as long as the session stays current. The SDK never
	 * re-listens on its own, so without this every list-change and resource-update notification
	 * would silently stop after the first network hiccup. `'local'` and `'graceful'` closes are
	 * deliberate and ignored.
	 */
	#watchListen(
		entry: ManagedConnection<Id>,
		session: McpClientSession<Id>,
		subscription: McpSubscription | undefined,
	): void {
		const state = (entry.listenWatch ??= { reopening: false, attempts: 0, reopens: 0 });
		if (subscription === undefined) {
			delete state.subscription;
			return;
		}
		state.subscription = subscription;
		void subscription.closed.then((reason) => {
			if (reason !== "remote") return;
			if (entry.session !== session || entry.listenWatch !== state) return;
			if (state.subscription !== subscription) return;
			// The dead stream is cleared BEFORE any other verdict: the watch is armed while the
			// connect is still in its `connecting` phase, and leaving a closed stream in
			// `state.subscription` would make `#scheduleRelisten`'s guard refuse to re-open forever.
			delete state.subscription;
			if (entry.listen === subscription) delete entry.listen;
			if (this.#closed || entry.disconnectTask !== undefined) return;
			this.#publish("connection.listen.dropped", entry);
			// Scheduled even from a not-yet-`online` phase; the timer re-checks when it fires.
			this.#scheduleRelisten(entry, session, state);
		});
	}

	#scheduleRelisten(
		entry: ManagedConnection<Id>,
		session: McpClientSession<Id>,
		state: ListenWatchState,
	): void {
		if (state.retryTimer !== undefined || state.reopening) return;
		const delay = Math.min(
			LISTEN_REOPEN_MAX_MS,
			LISTEN_REOPEN_INITIAL_MS * 2 ** Math.min(state.attempts, 16),
		);
		state.attempts += 1;
		const timer = setTimeout(() => {
			delete state.retryTimer;
			if (entry.session !== session || entry.listenWatch !== state) return;
			if (entry.disconnectTask !== undefined || this.#closed) return;
			if (state.subscription !== undefined) return;
			if (!isUsable(entry)) {
				// The session is still current but its connect has not reached `online` yet: keep the
				// backoff alive rather than abandoning the stream for the rest of the generation.
				this.#scheduleRelisten(entry, session, state);
				return;
			}
			state.reopening = true;
			void this.#relisten(entry, session)
				.then((applied) => {
					if (entry.session !== session || entry.listenWatch !== state) return;
					if (!applied) return;
					if (state.subscription === undefined) {
						// Nothing to listen for any more (filter emptied); stop retrying.
						state.attempts = 0;
						return;
					}
					state.attempts = 0;
					state.reopens += 1;
					this.#publish("connection.listen.reopened", entry);
				})
				.catch(() => {
					if (entry.session !== session || entry.listenWatch !== state) return;
					this.#scheduleRelisten(entry, session, state);
				})
				.finally(() => {
					state.reopening = false;
				});
		}, delay);
		timer.unref?.();
		state.retryTimer = timer;
	}

	#stopListenWatch(entry: ManagedConnection<Id>): void {
		const state = entry.listenWatch;
		if (state === undefined) return;
		if (state.retryTimer !== undefined) clearTimeout(state.retryTimer);
		delete state.retryTimer;
		delete state.subscription;
		delete entry.listenWatch;
	}

	/**
	 * Routes every SDK-level failure of one generation's transport or client into `#reportError`,
	 * chaining any handler already installed (a definition's `configureClient` may set one; the SDK
	 * chains the transport's own inside `Protocol.connect`). Reporting runs FIRST so a throwing
	 * downstream handler cannot swallow the diagnostic, and behaves exactly as it did before
	 * otherwise.
	 */
	#watchErrors(
		entry: ManagedConnection<Id>,
		scope: ErrorScope,
		target: { onerror?: ((error: Error) => void) | undefined },
	): void {
		const existing = target.onerror;
		target.onerror = (error: Error) => {
			this.#reportError(entry, scope, error);
			existing?.(error);
		};
	}

	/**
	 * The one path every observed SDK-level error takes. It announces `connection.error`, keeps the
	 * bounded ring the snapshot exposes, and calls `onError` with the original error — and it never
	 * throws, never changes the phase and never schedules anything. A transport that goes on to
	 * close still reaches `#handleUnexpectedClose` through its own `onclose`, which is what actually
	 * fails the connection.
	 */
	#reportError(entry: ManagedConnection<Id>, scope: ErrorScope, error: unknown): void {
		// A generation whose window is closed no longer speaks for this connection.
		if (entry.errorScope !== scope) return;
		if (typeof error === "object" && error !== null) {
			if (scope.seen.has(error)) return;
			scope.seen.add(error);
		}
		try {
			const detail = describeError(error);
			const diagnostic: McpConnectionDiagnostic = Object.freeze({
				at: isoTimestamp(this.#now),
				kind: detail.kind,
				code: String(detail.code).slice(0, 64),
				message: diagnosticMessage(error),
				generation: entry.generation,
			});
			if (this.#diagnosticsKeep > 0) {
				const ring = entry.diagnostics ?? (entry.diagnostics = []);
				ring.push(diagnostic);
				if (ring.length > this.#diagnosticsKeep) {
					ring.splice(0, ring.length - this.#diagnosticsKeep);
				}
			}
			this.#publish("connection.error", entry, { error: diagnostic });
		} catch {
			// A diagnostic is never the reason a connection breaks.
		}
		try {
			void Promise.resolve(this.#onError?.(entry.definition.id, error)).catch(() => undefined);
		} catch {
			// The host's error hook is deliberately best-effort, like `onListenerError`.
		}
	}

	async #performReplace(
		entry: ManagedConnection<Id>,
		definition: McpConnectionDefinition<Id>,
	): Promise<McpConnectionSnapshot<Id>> {
		const id = definition.id;
		if (entry.phase === "quarantined") {
			throw new KmcpError(
				KMCP_ERROR_CODES.CONNECTION_QUARANTINED,
				`Connection '${id}' is quarantined after a cleanup failure; disconnect it before replacing it.`,
			);
		}
		if (entry.removeTask !== undefined) {
			throw new KmcpError(
				KMCP_ERROR_CODES.CONNECTION_NOT_ONLINE,
				`Connection '${id}' is being removed.`,
			);
		}
		// Let a connect already in flight settle: the state this swap preserves must be the real one.
		if (entry.connectTask !== undefined) await entry.connectTask.catch(() => undefined);
		const wasOnline = entry.phase === "online";
		if (entry.phase !== "offline" && entry.phase !== "failed") await this.disconnect(id);
		if (this.#entries.get(id) !== entry) {
			throw new KmcpError(KMCP_ERROR_CODES.CONNECTION_UNKNOWN, `Unknown connection '${id}'.`);
		}
		entry.definition = definition;
		// Everything derived from the OLD definition goes with it: the cached era verdict belongs to
		// the previous endpoint, the recorded failure to the previous server, and so do the
		// diagnostics a host renders under this id.
		delete entry.discover;
		delete entry.errorCode;
		delete entry.errorDetail;
		delete entry.diagnostics;
		delete entry.errorScope;
		if (definition.logLevel === undefined) delete entry.logLevel;
		else entry.logLevel = definition.logLevel;
		this.#cancelReconnectTimer(entry);
		delete entry.reconnect;
		if (entry.phase === "failed") this.#transition(entry, "offline");
		this.#publish("connection.registered", entry);
		if (!wasOnline) return this.#snapshotEntry(entry);
		return this.connect(id);
	}

	async #performRemove(entry: ManagedConnection<Id>): Promise<void> {
		await this.disconnect(entry.definition.id);
		if (this.#entries.get(entry.definition.id) !== entry) return;
		this.#entries.delete(entry.definition.id);
		this.#publish("connection.removed", entry);
	}

	async #releasePendingAuthorization(entry: ManagedConnection<Id>): Promise<void> {
		const pending = entry.pendingAuthorization;
		if (pending === undefined) return;
		delete entry.pendingAuthorization;
		await pending.client.close().catch(() => undefined);
		await pending.transport.close().catch(() => undefined);
	}

	async #performDisconnect(entry: ManagedConnection<Id>): Promise<McpConnectionSnapshot<Id>> {
		if (entry.connectTask !== undefined) await entry.connectTask.catch(() => undefined);
		if (entry.pendingAuthorization !== undefined) {
			this.#transition(entry, "draining");
			await this.#releasePendingAuthorization(entry);
			delete entry.errorCode;
			delete entry.errorDetail;
			this.#transition(entry, "offline");
			return this.#snapshotEntry(entry);
		}
		const quarantinedCleanup = entry.quarantinedCleanup;
		if (quarantinedCleanup !== undefined) {
			this.#transition(entry, "draining");
			try {
				// Same bound as the connect path: a hung close must not hang disconnect() or close().
				await this.#bounded(quarantinedCleanup(), entry.definition.disconnectTimeoutMs, "close");
				delete entry.quarantinedCleanup;
				delete entry.errorCode;
				delete entry.errorDetail;
				this.#transition(entry, "offline");
				return this.#snapshotEntry(entry);
			} catch (error) {
				entry.errorCode = KMCP_ERROR_CODES.CONNECTION_CLOSE_FAILED;
				entry.errorDetail = describeError(error);
				this.#transition(entry, "quarantined");
				throw new KmcpError(
					KMCP_ERROR_CODES.CONNECTION_CLOSE_FAILED,
					`Failed to clean up '${entry.definition.id}'.`,
					{ cause: error },
				);
			}
		}
		const session = entry.session;
		if (session === undefined) {
			if (entry.activeOperations > 0) {
				this.#transition(entry, "draining");
				await this.#waitUntilDrained(entry);
			}
			delete entry.errorCode;
			delete entry.errorDetail;
			this.#transition(entry, "offline");
			return this.#snapshotEntry(entry);
		}

		this.#transition(entry, "draining");
		await this.#waitUntilDrained(entry);
		this.#cancelAutoRefresh(entry);
		try {
			// Close subscriptions before the client so kmcp's own teardown reads as 'local'.
			await entry.listen?.close().catch(() => undefined);
			delete entry.listen;
			delete entry.subscribedUris;
			await session.client.autoOpenedSubscription?.close().catch(() => undefined);
			await this.#terminateSession(entry);
			await this.#bounded(session.close(), entry.definition.disconnectTimeoutMs, "close");
			delete entry.session;
			delete entry.transport;
			delete entry.errorScope;
			entry.resumed = false;
			delete entry.connectedAt;
			delete entry.errorCode;
			delete entry.errorDetail;
			this.#transition(entry, "offline");
			return this.#snapshotEntry(entry);
		} catch (error) {
			entry.errorCode = KMCP_ERROR_CODES.CONNECTION_CLOSE_FAILED;
			entry.errorDetail = describeError(error);
			this.#transition(entry, "quarantined");
			throw new KmcpError(
				KMCP_ERROR_CODES.CONNECTION_CLOSE_FAILED,
				`Failed to close '${entry.definition.id}'.`,
				{ cause: error },
			);
		}
	}

	/**
	 * Sends the Streamable HTTP `DELETE` that lets the server release the session. Separate from
	 * `Client.close()`, which only tears the client down. Best-effort and time-boxed: a server MAY
	 * answer 405, and a hung DELETE must not turn a clean disconnect into a quarantine.
	 */
	async #terminateSession(entry: ManagedConnection<Id>): Promise<void> {
		if (!entry.definition.terminateSession) return;
		const transport = entry.transport as
			(Transport & { terminateSession?: () => Promise<void> }) | undefined;
		if (transport === undefined || typeof transport.terminateSession !== "function") return;
		if (transport.sessionId === undefined) return;
		try {
			await this.#bounded(transport.terminateSession(), this.#terminateSessionTimeoutMs, "DELETE");
		} catch {
			// Best-effort by design.
		}
	}

	async #bounded<Value>(
		task: Promise<Value>,
		timeoutMs: number | undefined,
		label: string,
	): Promise<Value> {
		if (timeoutMs === undefined) return task;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				reject(
					new KmcpError(
						KMCP_ERROR_CODES.HANDLER_TIMEOUT,
						`The ${label} did not complete within ${timeoutMs}ms.`,
					),
				);
			}, timeoutMs);
			timer.unref?.();
		});
		try {
			return await Promise.race([task, timeout]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	#cancelAutoRefresh(entry: ManagedConnection<Id>): void {
		const timer = entry.autoRefresh?.timer;
		if (timer !== undefined) clearTimeout(timer);
		delete entry.autoRefresh;
	}

	#waitUntilDrained(entry: ManagedConnection<Id>): Promise<void> {
		if (entry.activeOperations === 0) return Promise.resolve();
		return new Promise((resolve) => entry.drainWaiters.add(resolve));
	}

	#assertOperationControl(
		entry: ManagedConnection<Id>,
		control: McpConnectionOperationControl,
	): void {
		if (
			control.expectedGeneration !== undefined &&
			control.expectedGeneration !== entry.generation
		) {
			throw new KmcpError(
				KMCP_ERROR_CODES.CONNECTION_GENERATION_STALE,
				"The requested MCP connection generation is no longer active.",
			);
		}
		if (
			control.expectedCatalogFingerprint !== undefined &&
			control.expectedCatalogFingerprint !== entry.catalog?.fingerprint
		) {
			throw new KmcpError(
				KMCP_ERROR_CODES.CATALOG_STALE,
				"The requested MCP catalog is no longer active.",
			);
		}
	}

	#assertRefreshAuthority(
		entry: ManagedConnection<Id>,
		session: McpClientSession<Id>,
		generation: number,
		catalogRevision: number,
	): void {
		if (
			entry.session !== session ||
			entry.generation !== generation ||
			!isUsable(entry) ||
			entry.disconnectTask !== undefined
		) {
			throw new KmcpError(
				KMCP_ERROR_CODES.CONNECTION_NOT_ONLINE,
				"The MCP connection changed while its catalog was being refreshed.",
			);
		}
		if (entry.catalogRevision !== catalogRevision) {
			throw new KmcpError(
				KMCP_ERROR_CODES.CATALOG_STALE,
				"A newer MCP catalog was committed while this refresh was in flight.",
			);
		}
	}

	#transition(entry: ManagedConnection<Id>, phase: McpConnectionPhase): void {
		if (phase !== "online" && phase !== "degraded" && entry.catalog !== undefined) {
			delete entry.catalog;
			entry.catalogRevision += 1;
		}
		if (phase !== "online" && phase !== "degraded") {
			this.#cancelAutoRefresh(entry);
			this.#stopKeepalive(entry);
			this.#stopListenWatch(entry);
		}
		// A deliberate disconnect ends the story the keepalive counters were telling; an unexpected
		// close (`failed`) keeps them so the snapshot explains why the connection went down.
		if (phase === "offline") delete entry.keepalive;
		if (phase !== "failed") this.#cancelReconnectTimer(entry);
		entry.phase = phase;
		entry.lastTransitionAt = isoTimestamp(this.#now);
		this.#publish("connection.state.changed", entry);
	}

	#publish(
		type: McpConnectionEventType,
		entry: ManagedConnection<Id>,
		extra: Pick<McpConnectionEvent<Id>, "error" | "resource"> = {},
	): void {
		this.#revision += 1;
		const event: McpConnectionEvent<Id> = Object.freeze({
			revision: this.#revision,
			type,
			occurredAt: isoTimestamp(this.#now),
			connection: this.#snapshotEntry(entry),
			...(extra.resource === undefined ? {} : { resource: extra.resource }),
			...(extra.error === undefined ? {} : { error: extra.error }),
		});
		for (const listener of this.#listeners) {
			try {
				void Promise.resolve(listener(event)).catch((error: unknown) =>
					this.#reportListenerError(error, event),
				);
			} catch (error) {
				this.#reportListenerError(error, event);
			}
		}
	}

	#reportListenerError(error: unknown, event: McpConnectionEvent<Id>): void {
		try {
			void Promise.resolve(this.#onListenerError?.(error, event)).catch(() => undefined);
		} catch {
			// Listener error reporting is deliberately best-effort.
		}
	}

	#snapshotEntry(entry: ManagedConnection<Id>): McpConnectionSnapshot<Id> {
		const client = entry.session?.client;
		const resumed = entry.resumed ? entry.definition.resumed : undefined;
		const serverInfo = client?.getServerVersion() ?? resumed?.serverInfo;
		const protocolVersion = client?.getNegotiatedProtocolVersion() ?? resumed?.protocolVersion;
		const protocolEra = client === undefined ? undefined : this.#era(entry, client);
		const capabilities = client === undefined ? undefined : this.#capabilities(entry, client);
		const instructions = client?.getInstructions() ?? resumed?.instructions;
		const watch = client === undefined ? undefined : this.#watchSnapshot(entry, client);
		const transportKind = this.#transportKind(entry);
		const sessionId = client === undefined ? undefined : entry.transport?.sessionId;
		const connectionMode =
			client === undefined ? undefined : connectionModeOf(transportKind, sessionId, protocolEra);
		const supportedVersions =
			client === undefined || entry.discover?.supportedVersions === undefined
				? undefined
				: Object.freeze(
						entry.discover.supportedVersions
							.filter((version): version is string => typeof version === "string")
							.slice(0, MAX_SUPPORTED_VERSIONS),
					);
		const keepalive = entry.keepalive;
		return Object.freeze({
			id: entry.definition.id,
			label: entry.definition.label,
			tags: entry.definition.tags,
			phase: entry.phase,
			generation: entry.generation,
			lastTransitionAt: entry.lastTransitionAt,
			...(entry.connectedAt === undefined ? {} : { connectedAt: entry.connectedAt }),
			...(entry.lastSeenAt === undefined ? {} : { lastSeenAt: entry.lastSeenAt }),
			...(transportKind === undefined ? {} : { transportKind }),
			...(sessionId === undefined ? {} : { sessionId }),
			...(connectionMode === undefined ? {} : { connectionMode }),
			...(protocolVersion === undefined ? {} : { protocolVersion }),
			...(protocolEra === undefined ? {} : { protocolEra }),
			...(supportedVersions === undefined ? {} : { supportedVersions }),
			...(serverInfo === undefined ? {} : { serverInfo: immutableClone(serverInfo) }),
			...(instructions === undefined
				? {}
				: { instructions: instructions.slice(0, this.#maxInstructionsLength) }),
			...(capabilities === undefined ? {} : { capabilities: immutableClone(capabilities) }),
			...(entry.logLevel === undefined ? {} : { logLevel: entry.logLevel }),
			...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
			...(entry.errorDetail === undefined ? {} : { errorDetail: entry.errorDetail }),
			...(entry.diagnostics === undefined || entry.diagnostics.length === 0
				? {}
				: { diagnostics: Object.freeze([...entry.diagnostics]) }),
			...(watch === undefined ? {} : { watch }),
			...(keepalive === undefined
				? {}
				: {
						keepalive: Object.freeze({
							failures: keepalive.failures,
							...(keepalive.lastProbeAt === undefined
								? {}
								: { lastProbeAt: keepalive.lastProbeAt }),
							...(keepalive.lastFailureAt === undefined
								? {}
								: { lastFailureAt: keepalive.lastFailureAt }),
						}),
					}),
			...(entry.subscribedUris === undefined || entry.subscribedUris.size === 0
				? {}
				: { subscribedResources: Object.freeze([...entry.subscribedUris].sort()) }),
			...(entry.reconnect === undefined || entry.definition.reconnect === undefined
				? {}
				: {
						reconnect: Object.freeze({
							attempts: entry.reconnect.attempts,
							...(entry.reconnect.nextAttemptAt === undefined
								? {}
								: { nextAttemptAt: entry.reconnect.nextAttemptAt }),
						}),
					}),
			...(entry.catalog === undefined ? {} : { catalog: entry.catalog }),
		});
	}

	#transportKind(entry: ManagedConnection<Id>): McpTransportKind | undefined {
		const declared = entry.definition.transportKind;
		if (declared !== "custom") return declared;
		const transport = entry.transport as
			(Transport & { terminateSession?: unknown; stderr?: unknown }) | undefined;
		if (transport === undefined) return "custom";
		if (typeof transport.terminateSession === "function") return "streamable-http";
		return "custom";
	}

	#watchSnapshot(entry: ManagedConnection<Id>, client: Client): McpWatchSnapshot {
		const refreshes = entry.autoRefresh?.count ?? 0;
		const reopens = entry.listenWatch?.reopens ?? 0;
		const configured = entry.definition.autoRefreshCatalog !== undefined;
		const base = { refreshes, reopens };
		if (!configured) {
			return Object.freeze({
				...base,
				active: false,
				honoredSections: [],
				unhonoredSections: [],
				reason: "not-configured" as const,
			});
		}
		const capabilities = this.#capabilities(entry, client);
		const advertised: McpCatalogCapability[] = [];
		if (capabilities?.tools?.listChanged === true) advertised.push("tools");
		if (capabilities?.prompts?.listChanged === true) advertised.push("prompts");
		if (capabilities?.resources?.listChanged === true)
			advertised.push("resources", "resourceTemplates");
		const era = this.#era(entry, client);
		let honored: readonly McpCatalogCapability[];
		if (era === "modern") {
			// The watched stream is the single source of truth: it is set when a stream is armed and
			// cleared the moment one drops. `client.autoOpenedSubscription` keeps answering with its
			// handle (and its `honoredFilter`) long after the manager replaced and closed it, which
			// would report a dead subscription as live.
			const filter = entry.listenWatch?.subscription?.honoredFilter;
			honored =
				filter === undefined
					? []
					: [
							...(filter.toolsListChanged === true ? (["tools"] as const) : []),
							...(filter.promptsListChanged === true ? (["prompts"] as const) : []),
							...(filter.resourcesListChanged === true
								? (["resources", "resourceTemplates"] as const)
								: []),
						];
		} else {
			honored = advertised;
		}
		const unhonored = CATALOG_SECTIONS.filter((section) => !honored.includes(section));
		const reason =
			entry.autoRefresh?.capped === true
				? ("refresh-cap" as const)
				: honored.length === 0
					? advertised.length === 0
						? ("not-advertised" as const)
						: ("unsupported-era" as const)
					: undefined;
		return Object.freeze({
			...base,
			active: honored.length > 0 && entry.autoRefresh?.capped !== true,
			honoredSections: Object.freeze([...honored]),
			unhonoredSections: Object.freeze(unhonored),
			...(reason === undefined ? {} : { reason }),
		});
	}

	#entry(id: Id): ManagedConnection<Id> {
		const entry = this.#entries.get(id);
		if (entry === undefined) {
			throw new KmcpError(KMCP_ERROR_CODES.CONNECTION_UNKNOWN, `Unknown connection '${id}'.`);
		}
		return entry;
	}

	#assertOpen(): void {
		if (this.#closed) {
			throw new KmcpError(KMCP_ERROR_CODES.MANAGER_CLOSED, "Connection manager is closed.");
		}
	}

	async #closeAll(): Promise<void> {
		const results = await Promise.allSettled(
			[...this.#entries.keys()].map((id) => this.disconnect(id)),
		);
		this.#listeners.clear();
		const failures = results.filter((result) => result.status === "rejected");
		if (failures.length > 0) {
			throw new AggregateError(
				failures.map((failure) => failure.reason),
				"One or more MCP connections failed to close.",
			);
		}
	}
}

/** Classifies an error (walking `cause`) into a stable kind/code pair for snapshots. */
export function describeError(error: unknown): McpErrorDetail {
	// A transport-level cause is the most actionable classification, wherever it sits in the chain.
	const network = deepNetworkErrorCode(error);
	let current: unknown = error;
	for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
		if (current instanceof KmcpError) {
			if (
				current.code !== KMCP_ERROR_CODES.CONNECTION_CONNECT_FAILED &&
				current.code !== KMCP_ERROR_CODES.OPERATION_FAILED
			) {
				return { kind: "kmcp", code: current.code };
			}
		} else if (current instanceof UnauthorizedError) {
			return { kind: "oauth", code: "unauthorized" };
		} else if (current instanceof InsufficientScopeError) {
			return { kind: "oauth", code: "insufficient_scope" };
		} else if (current instanceof RegistrationRejectedError) {
			return { kind: "oauth", code: "registration_rejected", httpStatus: current.status };
		} else if (current instanceof IssuerMismatchError) {
			return { kind: "oauth", code: "issuer_mismatch" };
		} else if (current instanceof AuthorizationServerMismatchError) {
			return { kind: "oauth", code: "authorization_server_mismatch" };
		} else if (current instanceof InsecureTokenEndpointError) {
			return { kind: "oauth", code: "insecure_token_endpoint" };
		} else if (current instanceof OAuthError) {
			return { kind: "oauth", code: String(current.code).slice(0, 64) };
		} else if (current instanceof UnsupportedProtocolVersionError) {
			return { kind: "protocol", code: "unsupported_protocol_version" };
		} else if (current instanceof MissingRequiredClientCapabilityError) {
			return { kind: "protocol", code: "missing_required_client_capability" };
		} else if (current instanceof UrlElicitationRequiredError) {
			return { kind: "protocol", code: "url_elicitation_required" };
		} else if (current instanceof SdkHttpError) {
			return { kind: "http", code: current.status, httpStatus: current.status };
		} else if (current instanceof SdkError) {
			return network === undefined
				? { kind: "sdk", code: current.code }
				: { kind: "network", code: network };
		} else if (current instanceof ProtocolError) {
			return { kind: "protocol", code: current.code };
		} else if (network !== undefined) {
			return { kind: "network", code: network };
		}
		current = current instanceof Error ? current.cause : undefined;
	}
	if (network !== undefined) return { kind: "network", code: network };
	if (error instanceof KmcpError) return { kind: "kmcp", code: error.code };
	return { kind: "unknown", code: error instanceof Error ? error.name : typeof error };
}

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]+/g;

/**
 * The bounded, non-secret summary a diagnostic carries. Upstream text reaches this unfiltered, so
 * control characters are collapsed (no terminal escapes in a host's log) and the result is capped.
 */
function diagnosticMessage(error: unknown): string {
	let raw: string;
	try {
		raw =
			error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
	} catch {
		raw = "";
	}
	const cleaned = raw.replace(CONTROL_CHARACTERS, " ").trim();
	if (cleaned.length === 0) return error instanceof Error ? error.name : "Unknown error.";
	return cleaned.length > MAX_DIAGNOSTIC_MESSAGE_LENGTH
		? `${cleaned.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH - 1)}…`
		: cleaned;
}

/**
 * Whether two definitions describe the same connection for `replace`/`reconcile`: the same object,
 * or the same `fingerprint` when a definition exposes one. Definitions carry live closures
 * (transport factories, request handlers), so there is no structural comparison to fall back on.
 */
function sameDefinition(
	left: McpConnectionDefinition<string>,
	right: McpConnectionDefinition<string>,
): boolean {
	if (left === right) return true;
	const leftPrint = definitionFingerprint(left);
	return leftPrint !== undefined && leftPrint === definitionFingerprint(right);
}

function definitionFingerprint(definition: McpConnectionDefinition<string>): string | undefined {
	const value = (definition as { readonly fingerprint?: unknown }).fingerprint;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Whether a failure is only the reconnect's verdict — the swap itself landed and the entry now
 * holds the new definition. A close that failed (`CONNECTION_CLOSE_FAILED`, i.e. a quarantine) is
 * deliberately NOT one of these: it happens before the swap, so nothing was replaced.
 */
function isReconnectVerdict(error: unknown): boolean {
	const code = errorCode(error);
	return (
		code === KMCP_ERROR_CODES.CONNECTION_CONNECT_FAILED ||
		code === KMCP_ERROR_CODES.CONNECTION_AUTHORIZING
	);
}

function deepNetworkErrorCode(error: unknown): string | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
		const code = networkErrorCode(current);
		if (code !== undefined) return code;
		// The SDK attaches the underlying failure to `data.cause` on its typed errors.
		const data = current instanceof SdkError ? current.data : undefined;
		const dataCause =
			typeof data === "object" && data !== null ? (data as { cause?: unknown }).cause : undefined;
		current = current instanceof Error && current.cause !== undefined ? current.cause : dataCause;
	}
	return undefined;
}

type McpListKind = "prompts" | "resourceTemplates" | "resources" | "tools";

type McpListResult<Kind extends McpListKind> = Kind extends "tools"
	? ListToolsResult
	: Kind extends "resources"
		? ListResourcesResult
		: Kind extends "resourceTemplates"
			? ListResourceTemplatesResult
			: ListPromptsResult;

const LIST_METHODS = Object.freeze({
	tools: "tools/list",
	resources: "resources/list",
	resourceTemplates: "resources/templates/list",
	prompts: "prompts/list",
} as const);

const LIST_SCHEMAS = Object.freeze({
	tools: specTypeSchemas.ListToolsResult,
	resources: specTypeSchemas.ListResourcesResult,
	resourceTemplates: specTypeSchemas.ListResourceTemplatesResult,
	prompts: specTypeSchemas.ListPromptsResult,
} as const);

const LIST_MAX_PAGES = 64;

/** Walks every page of a list verb through `Client.request()` (mirrors the SDK's aggregate walk). */
async function walkListPages<Kind extends McpListKind>(
	client: Client,
	kind: Kind,
	params: Record<string, unknown>,
	options: RequestOptions,
): Promise<McpListResult<Kind>> {
	const method = LIST_METHODS[kind];
	const schema = LIST_SCHEMAS[kind];
	const items: unknown[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	let first: Record<string, unknown> | undefined;
	for (let page = 0; ; page += 1) {
		if (page >= LIST_MAX_PAGES) {
			throw new KmcpError(
				KMCP_ERROR_CODES.OPERATION_FAILED,
				`${method} exceeded ${LIST_MAX_PAGES} pages without a final cursor.`,
			);
		}
		const result = (await client.request(
			{ method, params: cursor === undefined ? params : { ...params, cursor } },
			schema,
			options,
		)) as Record<string, unknown>;
		first ??= result;
		const pageItems = result[kind];
		if (Array.isArray(pageItems)) items.push(...pageItems);
		const next = result.nextCursor;
		if (typeof next !== "string" || next.length === 0) break;
		if (seen.has(next)) break;
		seen.add(next);
		cursor = next;
	}
	const { nextCursor: _nextCursor, ...rest } = first ?? {};
	void _nextCursor;
	return { ...rest, [kind]: items } as McpListResult<Kind>;
}

const NETWORK_ERROR_CODE =
	/^(E[A-Z]{2,}|EAI_[A-Z]+|UND_ERR_[A-Z_]+|CERT_[A-Z_]+|ERR_TLS_[A-Z_]+|ERR_SSL_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_[A-Z_]+)$/;

/**
 * A stable code for a transport-level failure: Node system errors (`ECONNREFUSED`, `ENOTFOUND`,
 * `ETIMEDOUT`, ...), undici errors, TLS/certificate errors, and aborts / timeouts raised as
 * `DOMException`s. `undefined` for anything else.
 */
function networkErrorCode(error: unknown): string | undefined {
	if (error instanceof DOMException) {
		return error.name === "AbortError" || error.name === "TimeoutError" ? error.name : undefined;
	}
	if (!(error instanceof Error)) return undefined;
	// kmcp's and the SDK's own typed errors carry codes of their own vocabulary.
	if (error instanceof KmcpError || error instanceof SdkError || error instanceof ProtocolError) {
		return undefined;
	}
	const code = (error as { readonly code?: unknown }).code;
	if (typeof code === "string" && NETWORK_ERROR_CODE.test(code)) return code;
	return undefined;
}

function finishingTransport(
	transport: Transport,
	id: string,
): Transport & { finishAuth: (params: URLSearchParams) => Promise<void> } {
	const candidate = transport as Transport & {
		finishAuth?: (params: URLSearchParams) => Promise<void>;
	};
	if (typeof candidate.finishAuth !== "function") {
		throw new KmcpError(
			KMCP_ERROR_CODES.OPERATION_FAILED,
			`The transport of '${id}' cannot finish an authorization flow.`,
		);
	}
	return candidate as Transport & { finishAuth: (params: URLSearchParams) => Promise<void> };
}

function refusedAuthorization(id: string, oauthError: string): KmcpError {
	return new KmcpError(
		KMCP_ERROR_CODES.AUTH_FORBIDDEN,
		`Authorization of '${id}' was refused by the authorization server (${oauthError.slice(0, 64)}).`,
	);
}

function notAdvertised(kind: "Prompt" | "Tool", name: string): McpContractResult {
	return Object.freeze({
		valid: false,
		errors: Object.freeze([`${kind} '${name}' is not advertised by the upstream.`]),
		warnings: Object.freeze([]),
	});
}

function findCause<Found>(
	error: unknown,
	predicate: (candidate: unknown) => candidate is Found,
): Found | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
		if (predicate(current)) return current;
		current = current instanceof Error ? current.cause : undefined;
	}
	return undefined;
}

function connectionModeOf(
	transportKind: McpTransportKind | undefined,
	sessionId: string | undefined,
	era: ProtocolEra | undefined,
): McpConnectionMode {
	if (sessionId !== undefined) return "stateful";
	if (transportKind === "streamable-http") return "stateless";
	if (transportKind === "in-process") return era === "modern" ? "stateless" : "stateful";
	return "stateful";
}

function boundedCompletion(result: CompleteResult): CompleteResult {
	const values = result.completion.values
		.filter((value): value is string => typeof value === "string")
		.slice(0, 100)
		.map((value) => value.slice(0, 4096));
	return {
		...result,
		completion: {
			...result.completion,
			values,
			...(typeof result.completion.total === "number" ? { total: result.completion.total } : {}),
			...(typeof result.completion.hasMore === "boolean"
				? { hasMore: result.completion.hasMore }
				: {}),
		},
	};
}

async function discoverSection<Item>(
	supported: boolean,
	load: () => Promise<readonly Item[]>,
	previous?: McpCatalogSection<Item>,
	bounds?: McpCatalogBounds,
	signal?: AbortSignal,
): Promise<McpCatalogSection<Item>> {
	if (!supported) {
		return Object.freeze({
			status: "unsupported",
			items: Object.freeze([]),
			byteSize: 0,
			nodeCount: 0,
		});
	}
	try {
		throwIfAborted(signal);
		const loaded = await load();
		throwIfAborted(signal);
		const { items, byteSize, nodeCount } = cloneCatalogItems(
			loaded,
			bounds ?? DEFAULT_CATALOG_BOUNDS,
		);
		return Object.freeze({
			status: "fresh",
			items,
			byteSize,
			nodeCount,
			fingerprint: stableFingerprint(items),
		});
	} catch (error) {
		if (signal?.aborted === true || isCatalogLimitError(error)) throw error;
		if (previous !== undefined && previous.items.length > 0) {
			return Object.freeze({
				status: "stale",
				items: previous.items,
				byteSize: previous.byteSize,
				nodeCount: previous.nodeCount,
				...(previous.fingerprint === undefined ? {} : { fingerprint: previous.fingerprint }),
				errorCode: errorCode(error),
			});
		}
		return Object.freeze({
			status: "failed",
			items: Object.freeze([]),
			byteSize: 0,
			nodeCount: 0,
			errorCode: errorCode(error),
		});
	}
}

function settledValue<Value>(result: PromiseSettledResult<Value>): Value {
	if (result.status === "rejected") throw result.reason;
	return result.value;
}

const DEFAULT_CATALOG_BOUNDS: McpCatalogBounds = Object.freeze({
	maxItems: 10_000,
	maxItemBytes: 256 * 1024,
	maxSnapshotBytes: 8 * 1024 * 1024,
	maxDepth: 64,
	maxStringBytes: 64 * 1024,
	maxNodes: 100_000,
	maxPropertiesPerObject: 10_000,
});

const UTF8_ENCODER = new TextEncoder();

/** Bounded, detached, deeply frozen JSON normalization shared by catalogs and other upstream-controlled values. */
export function cloneCatalogItems<Item>(
	loaded: readonly Item[],
	bounds: McpCatalogBounds,
): { readonly items: readonly Item[]; readonly byteSize: number; readonly nodeCount: number } {
	try {
		assertCatalogArrayShape(loaded, bounds.maxItems, "catalog capability");
		let byteSize = 2 + Math.max(0, loaded.length - 1);
		const budget: McpCatalogCaptureBudget = { nodeCount: 1 };
		const items: Item[] = [];
		for (const item of loaded) {
			const captured = captureCatalogValue(item, bounds, budget, 0, false);
			if (captured === OMITTED_CATALOG_VALUE) {
				throw catalogLimitError("Catalog capability entries must not be undefined.");
			}
			assertCatalogItemBytes(captured.byteSize, bounds);
			byteSize += captured.byteSize;
			if (byteSize > bounds.maxSnapshotBytes) {
				throw catalogLimitError("A catalog capability exceeds the snapshot byte limit.");
			}
			items.push(captured.value as Item);
		}
		// Structured clone rejects proxies and other host/exotic values that can masquerade as
		// ordinary objects through reflection. The result is deliberately discarded: the bounded
		// capture above is the authoritative normalized clone.
		structuredClone(loaded);
		return Object.freeze({
			items: Object.freeze(items),
			byteSize,
			nodeCount: budget.nodeCount,
		});
	} catch (error) {
		if (isCatalogLimitError(error)) throw error;
		throw catalogLimitError("Catalog items must be bounded, plain JSON data.");
	}
}

const OMITTED_CATALOG_VALUE = Symbol("omitted catalog value");

interface McpCatalogCaptureBudget {
	nodeCount: number;
}

interface McpCapturedCatalogValue {
	readonly value: unknown;
	readonly byteSize: number;
}

function captureCatalogValue(
	value: unknown,
	bounds: McpCatalogBounds,
	budget: McpCatalogCaptureBudget,
	depth: number,
	omitUndefined: boolean,
	ancestors: Set<object> = new Set(),
): McpCapturedCatalogValue | typeof OMITTED_CATALOG_VALUE {
	budget.nodeCount += 1;
	if (budget.nodeCount > bounds.maxNodes) {
		throw catalogLimitError("A catalog capability exceeds its configured node limit.");
	}
	if (depth > bounds.maxDepth) {
		throw catalogLimitError("A catalog item exceeds its configured nesting-depth limit.");
	}
	if (value === undefined) {
		if (omitUndefined) return OMITTED_CATALOG_VALUE;
		throw catalogLimitError("Catalog arrays and capability entries must not contain undefined.");
	}
	if (value === null) return Object.freeze({ value: null, byteSize: 4 });
	if (typeof value === "string") {
		return Object.freeze({ value, byteSize: measureJsonString(value, bounds) });
	}
	if (typeof value === "boolean") {
		return Object.freeze({ value, byteSize: value ? 4 : 5 });
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw catalogLimitError("Catalog items must contain finite JSON numbers.");
		}
		return Object.freeze({ value, byteSize: String(value).length });
	}
	if (typeof value !== "object") {
		throw catalogLimitError("Catalog items must contain only JSON-compatible values.");
	}
	if (ancestors.has(value)) {
		throw catalogLimitError("Catalog items must be acyclic JSON data.");
	}

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			assertCatalogArrayShape(value, bounds.maxPropertiesPerObject, "catalog array");
			let byteSize = 2 + Math.max(0, value.length - 1);
			const capturedArray: unknown[] = [];
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
					throw catalogLimitError("Catalog arrays must be dense data-property arrays.");
				}
				const captured = captureCatalogValue(
					descriptor.value,
					bounds,
					budget,
					depth + 1,
					false,
					ancestors,
				);
				if (captured === OMITTED_CATALOG_VALUE) {
					throw catalogLimitError("Catalog arrays must not contain undefined values.");
				}
				byteSize += captured.byteSize;
				assertCatalogItemBytes(byteSize, bounds);
				capturedArray.push(captured.value);
			}
			return Object.freeze({ value: Object.freeze(capturedArray), byteSize });
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw catalogLimitError("Catalog items must contain only plain JSON objects.");
		}
		const keys = Reflect.ownKeys(value);
		if (keys.length > bounds.maxPropertiesPerObject) {
			throw catalogLimitError("A catalog object exceeds its configured property limit.");
		}
		let byteSize = 2;
		let propertyCount = 0;
		const capturedObject: Record<string, unknown> = {};
		for (const key of keys) {
			if (typeof key !== "string") {
				throw catalogLimitError("Catalog objects must not contain symbol properties.");
			}
			const keyBytes = measureJsonString(key, bounds);
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
				throw catalogLimitError("Catalog objects must contain only enumerable data properties.");
			}
			const captured = captureCatalogValue(
				descriptor.value,
				bounds,
				budget,
				depth + 1,
				true,
				ancestors,
			);
			if (captured === OMITTED_CATALOG_VALUE) continue;
			byteSize += (propertyCount === 0 ? 0 : 1) + keyBytes + 1 + captured.byteSize;
			assertCatalogItemBytes(byteSize, bounds);
			Object.defineProperty(capturedObject, key, {
				value: captured.value,
				enumerable: true,
				configurable: true,
				writable: true,
			});
			propertyCount += 1;
		}
		return Object.freeze({ value: Object.freeze(capturedObject), byteSize });
	} finally {
		ancestors.delete(value);
	}
}

function assertCatalogItemBytes(byteSize: number, bounds: McpCatalogBounds): void {
	if (byteSize > bounds.maxItemBytes) {
		throw catalogLimitError("A catalog item exceeds its configured byte limit.");
	}
}

function assertCatalogArrayShape(
	value: readonly unknown[],
	maxLength: number,
	label: string,
): void {
	if (Object.getPrototypeOf(value) !== Array.prototype) {
		throw catalogLimitError(`The ${label} must be a plain array.`);
	}
	if (value.length > maxLength) {
		throw catalogLimitError(`The ${label} exceeds its configured element limit.`);
	}
	const keys = Reflect.ownKeys(value);
	if (keys.length !== value.length + 1 || !keys.includes("length")) {
		throw catalogLimitError(`The ${label} must not be sparse or contain extra properties.`);
	}
	for (const key of keys) {
		if (typeof key !== "string") {
			throw catalogLimitError(`The ${label} must not contain symbol properties.`);
		}
		if (key === "length") continue;
		const index = Number(key);
		if (
			!Number.isSafeInteger(index) ||
			index < 0 ||
			index >= value.length ||
			String(index) !== key
		) {
			throw catalogLimitError(`The ${label} must not contain non-index properties.`);
		}
	}
}

function measureJsonString(value: string, bounds: McpCatalogBounds): number {
	const rawBytes = UTF8_ENCODER.encode(value).byteLength;
	if (rawBytes > bounds.maxStringBytes) {
		throw catalogLimitError("A catalog string exceeds its configured byte limit.");
	}
	return UTF8_ENCODER.encode(JSON.stringify(value)).byteLength;
}

function sectionFingerprint(section: McpCatalogSection<unknown>): object {
	return Object.freeze({
		status: section.status,
		fingerprint: section.fingerprint ?? null,
	});
}

function isCatalogLimitError(error: unknown): boolean {
	return error instanceof KmcpError && error.code === KMCP_ERROR_CODES.CATALOG_LIMIT_EXCEEDED;
}

function catalogLimitError(message: string): KmcpError {
	return new KmcpError(KMCP_ERROR_CODES.CATALOG_LIMIT_EXCEEDED, message);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted === true) {
		throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
	}
}

function cleanupAfterFailedConnect<Id extends string>(
	session: McpClientSession<Id> | undefined,
	transport: Transport | undefined,
): (() => Promise<void>) | undefined {
	if (session !== undefined) {
		const failedSession = session;
		return () => failedSession.close();
	}
	if (transport !== undefined) {
		const failedTransport = transport;
		return () => failedTransport.close();
	}
	return undefined;
}

function isUsable(entry: ManagedConnection<string>): boolean {
	return entry.phase === "online" || entry.phase === "degraded";
}

/**
 * Whether a failure is the server declaring a Streamable HTTP session gone (HTTP 404 on a request
 * that carried a session id, or the manager's own verdict for one).
 */
function isSessionExpiryVerdict(error: unknown): boolean {
	const expired = findCause(
		error,
		(candidate): candidate is KmcpError =>
			candidate instanceof KmcpError &&
			candidate.code === KMCP_ERROR_CODES.CONNECTION_SESSION_EXPIRED,
	);
	if (expired !== undefined) return true;
	const http = findCause(
		error,
		(candidate): candidate is SdkHttpError => candidate instanceof SdkHttpError,
	);
	return http?.status === 404;
}

/**
 * Whether a rejected catalog refresh actually reached the upstream. A refresh fenced out by a
 * newer generation/catalog, or refused because the connection is no longer online, never ran —
 * it must not spend the generation's refresh budget.
 */
function refreshWasAttempted(error: unknown): boolean {
	switch (errorCode(error)) {
		case KMCP_ERROR_CODES.CONNECTION_NOT_ONLINE:
		case KMCP_ERROR_CODES.CONNECTION_GENERATION_STALE:
		case KMCP_ERROR_CODES.CATALOG_STALE:
		case KMCP_ERROR_CODES.MANAGER_CLOSED:
		case KMCP_ERROR_CODES.CONNECTION_UNKNOWN:
			return false;
		default:
			return true;
	}
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive safe integer.`);
	}
	return value;
}

function nextGeneration(current: number): number {
	if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER) {
		throw new RangeError("MCP connection generation space is exhausted.");
	}
	return current + 1;
}

/**
 * Builds `tools/call` params for a forwarded multi-round-trip round. The public
 * `CallToolRequest['params']` type is `{ name, arguments, _meta }`, but the 2026-07-28 wire codec
 * accepts `inputResponses` and `requestState` on the request at runtime (SDK `src-*.mjs`, the
 * `tools/call` params codec) and the server seam exposes them through `ctx.mcpReq`. This is the
 * one place kmcp relies on that; `test/gateway.test.ts` fails loudly if a future SDK strips them.
 */
function forwardMrtrCallToolParams(
	name: string,
	arguments_: Readonly<Record<string, unknown>>,
	options: McpMrtrForwardOptions | undefined,
): { name: string; arguments: Record<string, unknown> } {
	const params: Record<string, unknown> = { name, arguments: { ...arguments_ } };
	if (options?.inputResponses !== undefined) params.inputResponses = { ...options.inputResponses };
	if (options?.requestState !== undefined) params.requestState = options.requestState;
	return params as { name: string; arguments: Record<string, unknown> };
}
