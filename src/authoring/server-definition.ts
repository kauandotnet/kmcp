import {
	type CompleteRequest,
	type CompleteResult,
	createMcpHandler,
	type CreateMcpHandlerOptions,
	type Implementation,
	McpServer,
	type McpHttpHandler,
	type McpRequestContext,
	type McpServerFactory,
	mergeCapabilities,
	ProtocolError,
	ProtocolErrorCode,
	type RegisteredResourceTemplate,
	type ServerCapabilities,
	type ServerOptions,
	type Transport,
} from "@modelcontextprotocol/server";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import { deepFreeze, immutableProtocolClone, type MaybePromise } from "../internal/value.ts";
import {
	assertCanonicalCapability,
	capabilityKeys,
	installCanonicalCapability,
	type AnyMcpCapabilityDefinition,
	type AnyMcpPromptDefinition,
	type McpArgumentCompleter,
	type McpAuthVerdict,
	type McpCapabilityAuth,
	type McpCapabilityInstallWrap,
	type McpCapabilityKind,
	type McpRegistrationHandle,
} from "./capability.ts";
import { middlewareInstallWrap, type McpMiddleware } from "./middleware.ts";
import { namespaceUris, type McpUriNamespaceOptions } from "./uri-namespace.ts";
import { applyVisibility, normalizeVisibilityRules, type McpVisibilityRule } from "./visibility.ts";

export type McpSetupCleanup = () => MaybePromise<void>;

/**
 * A dynamic capability source, resolved once per materialization (per request under the official
 * per-request factory). Every returned definition must be canonical; keys must not collide with
 * the static capabilities or another provider's output. A throwing provider fails the whole
 * materialization (`PROVIDER_FAILED`) — a silently shrunken catalog is indistinguishable from an
 * authorization decision, and kmcp fails closed.
 */
export type McpCapabilityProvider = (
	context: McpRequestContext,
) => MaybePromise<readonly AnyMcpCapabilityDefinition[]>;

export interface McpCapabilityDenial {
	readonly definition: AnyMcpCapabilityDefinition;
	readonly context: McpRequestContext;
	readonly reason: string;
}

export interface McpServerDefinitionOptions {
	readonly sdk?: ServerOptions;
	/** Usage guidance advertised to clients (`ServerOptions.instructions`). */
	readonly instructions?: string;
	/**
	 * Declare the `logging` capability so `ctx.mcpReq.log` delivers messages. Off by default:
	 * logging is deprecated as of protocol revision 2026-07-28 (SEP-2577).
	 */
	readonly logging?: boolean;
	/**
	 * Declare `resources.subscribe` (default: `true` whenever the definition has a resource or
	 * template) so modern `subscriptions/listen` honours `resourceSubscriptions` and
	 * `notify.resourceUpdated(uri)` reaches clients.
	 */
	readonly resourceSubscriptions?: boolean;
	readonly capabilities?: readonly AnyMcpCapabilityDefinition[];
	/** Dynamic capability sources, resolved per materialization. Requires `declare`. */
	readonly providers?: readonly McpCapabilityProvider[];
	/**
	 * The capability kinds providers may contribute. REQUIRED when `providers` is set: the
	 * server's capability advertisement is fixed at construction, before any provider runs.
	 */
	readonly declare?: readonly McpCapabilityKind[];
	/**
	 * Capability-call middleware, composed once per capability per materialization
	 * (`middleware[0]` outermost). Runs OUTSIDE any `decorateHandlers` wrappers, which are baked
	 * into the definitions themselves.
	 */
	readonly middleware?: readonly McpMiddleware[];
	/**
	 * Visibility rules applied at materialization (left to right, last match wins). A hidden
	 * capability is simply not installed for that request.
	 */
	readonly visibility?: readonly McpVisibilityRule[];
	/** Observability seam for a provider failure (the materialization still fails closed). */
	readonly onProviderError?: (error: unknown, context: McpRequestContext) => void;
	/**
	 * Runs once per materialized instance after the capabilities are installed. It may return a
	 * cleanup function, which `McpServerRuntime.close()` awaits after the server closes. Under
	 * `serveStdio` the factory may run twice per connection (a discarded `server/discover` probe
	 * instance plus the pinned one).
	 */
	readonly setup?: (
		server: McpServer,
		context: McpRequestContext,
	) => MaybePromise<void | McpSetupCleanup>;
	/** Observability seam for capabilities withheld from a request by their `auth` check. */
	readonly onCapabilityDenied?: (denial: McpCapabilityDenial) => void;
}

export interface McpMountOptions {
	/** Name prefix for the mounted capabilities (URIs are untouched unless `uriNamespace` is set). */
	readonly prefix?: string;
	/** Separator between prefix and name. Default: `"."`. */
	readonly separator?: string;
	/** Permit a mounted child that declares a `setup` hook. */
	readonly allowSetup?: boolean;
	/**
	 * Also namespace the child's resource/template URIs (first path segment, allowlisted schemes —
	 * see `namespaceUris`). Requires `prefix`, which becomes the URI namespace.
	 */
	readonly uriNamespace?: McpUriNamespaceOptions;
}

export interface McpInstalledCapability {
	readonly definition: AnyMcpCapabilityDefinition;
	readonly handle: McpRegistrationHandle;
}

export class McpServerRuntime implements AsyncDisposable {
	readonly server: McpServer;
	readonly registrations: readonly McpInstalledCapability[];
	readonly #cleanup: McpSetupCleanup | undefined;
	#closeTask: Promise<void> | undefined;

	constructor(
		server: McpServer,
		registrations: readonly McpInstalledCapability[],
		cleanup?: McpSetupCleanup,
	) {
		this.server = server;
		this.registrations = Object.freeze([...registrations]);
		this.#cleanup = cleanup;
		Object.freeze(this);
	}

	connect(transport: Transport): Promise<void> {
		return this.server.connect(transport);
	}

	close(): Promise<void> {
		if (this.#closeTask === undefined) this.#closeTask = closeRuntime(this.server, this.#cleanup);
		return this.#closeTask;
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}
}

async function closeRuntime(
	server: McpServer,
	cleanup: McpSetupCleanup | undefined,
): Promise<void> {
	let closeError: unknown;
	let closeFailed = false;
	try {
		await server.close();
	} catch (error) {
		closeError = error;
		closeFailed = true;
	}
	if (cleanup !== undefined) {
		try {
			await cleanup();
		} catch (cleanupError) {
			if (closeFailed) {
				throw new AggregateError(
					[closeError, cleanupError],
					"MCP server close and setup cleanup both failed.",
				);
			}
			throw cleanupError;
		}
	}
	if (closeFailed) throw closeError;
}

/** Either a definition or a getter read per materialization, so a new frozen definition can be published without restarting. */
/**
 * Anything the serving entries (`handler()`, `createNodeMcpHandler`, `serveMcpHttp`,
 * `serveMcpStdio`, `inProcessConnection`) can materialize: a definition, or a gateway that
 * projects one per request.
 */
export interface McpServable {
	readonly serverInfo: Readonly<Implementation>;
	/** True when some capability declares `auth.anonymous: "deny"`. */
	readonly requiresAuthenticatedPrincipal: boolean;
	create(context: McpRequestContext): Promise<McpServer>;
	instantiate(context: McpRequestContext): Promise<McpServerRuntime>;
}

export type McpServerSource = McpServable | (() => McpServable);

export function resolveServerSource(source: McpServerSource): McpServable {
	const definition = typeof source === "function" ? source() : source;
	if (
		!(definition instanceof McpServerDefinition) &&
		(typeof definition !== "object" ||
			definition === null ||
			typeof definition.create !== "function" ||
			typeof definition.instantiate !== "function")
	) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			"A server source must yield an McpServerDefinition or another servable (e.g. a gateway).",
		);
	}
	return definition;
}

/** An official `McpServerFactory` that reads `source` for every materialization. */
export function serverSourceFactory(source: McpServerSource): McpServerFactory {
	if (typeof source !== "function") resolveServerSource(source);
	return (context) => resolveServerSource(source).create(context);
}

export class McpServerDefinition implements McpServable {
	readonly serverInfo: Readonly<Implementation>;
	readonly sdkOptions: ServerOptions | undefined;
	readonly capabilities: readonly AnyMcpCapabilityDefinition[];
	readonly providers: readonly McpCapabilityProvider[];
	readonly declaredKinds: readonly McpCapabilityKind[];
	readonly middleware: readonly McpMiddleware[];
	readonly visibility: readonly McpVisibilityRule[];
	readonly #setup: McpServerDefinitionOptions["setup"];
	readonly #onCapabilityDenied: McpServerDefinitionOptions["onCapabilityDenied"];
	readonly #onProviderError: McpServerDefinitionOptions["onProviderError"];
	readonly #serverOptions: ServerOptions;
	readonly #promptCompleters: ReadonlyMap<string, Readonly<Record<string, McpArgumentCompleter>>>;

	constructor(serverInfo: Implementation, options: McpServerDefinitionOptions = {}) {
		this.serverInfo = immutableProtocolClone(serverInfo, "server info");
		this.sdkOptions = options.sdk === undefined ? undefined : deepFreeze({ ...options.sdk });
		this.capabilities = Object.freeze([...(options.capabilities ?? [])]);
		this.providers = Object.freeze([...(options.providers ?? [])]);
		for (const provider of this.providers) {
			if (typeof provider !== "function") throw new TypeError("providers must be functions.");
		}
		this.declaredKinds = normalizeDeclaredKinds(options.declare);
		if (this.providers.length > 0 && this.declaredKinds.length === 0) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				"A definition with providers must declare the capability kinds they may contribute.",
			);
		}
		this.middleware = Object.freeze([...(options.middleware ?? [])]);
		for (const entry of this.middleware) {
			if (typeof entry !== "function") throw new TypeError("middleware must be functions.");
		}
		this.visibility = normalizeVisibilityRules(options.visibility);
		this.#setup = options.setup;
		this.#onCapabilityDenied = options.onCapabilityDenied;
		this.#onProviderError = options.onProviderError;
		for (const capability of this.capabilities) assertCanonicalCapability(capability);
		assertUniqueCapabilities(this.capabilities);
		this.#promptCompleters = promptCompleters(this.capabilities);
		this.#serverOptions = deepFreeze(
			buildServerOptions(
				this.sdkOptions,
				options,
				this.capabilities,
				this.#promptCompleters,
				this.declaredKinds,
			),
		);
		Object.freeze(this);
	}

	/** The `ServerOptions` every materialized instance receives, including the pre-declared capability kinds. */
	get serverOptions(): ServerOptions {
		return this.#serverOptions;
	}

	/** True when a capability declares `auth.anonymous: "deny"` — such a definition cannot serve an entry that never supplies `authInfo`. */
	get requiresAuthenticatedPrincipal(): boolean {
		return this.capabilities.some((capability) => capability.auth?.anonymous === "deny");
	}

	async create(context: McpRequestContext): Promise<McpServer> {
		return (await this.instantiate(context)).server;
	}

	async instantiate(context: McpRequestContext): Promise<McpServerRuntime> {
		const admitted = await this.admit(context);
		const wrap = this.#installWrap(context);
		const server = new McpServer(this.serverInfo, this.#serverOptions);
		try {
			const registrations = admitted.map((definition) =>
				Object.freeze({
					definition,
					handle: installCanonicalCapability(definition, server, wrap),
				}),
			);
			const completers =
				this.providers.length === 0 ? this.#promptCompleters : promptCompleters(admitted);
			if (completers.size > 0 && this.#serverOptions.capabilities?.completions !== undefined) {
				installCompletionHandler(server, admitted, registrations, completers);
			}
			if (
				context.era === "legacy" &&
				this.#serverOptions.capabilities?.resources?.subscribe === true
			) {
				installLegacySubscribeHandlers(server);
			}
			const cleanup = await this.#setup?.(server, context);
			return new McpServerRuntime(server, registrations, cleanup ?? undefined);
		} catch (error) {
			try {
				await server.close();
			} catch (closeError) {
				throw new AggregateError(
					[error, closeError],
					"MCP server initialization and cleanup both failed.",
				);
			}
			throw error;
		}
	}

	factory(): McpServerFactory {
		return (context) => this.create(context);
	}

	handler(options?: CreateMcpHandlerOptions): McpHttpHandler {
		return createMcpHandler(this.factory(), options);
	}

	with(...capabilities: readonly AnyMcpCapabilityDefinition[]): McpServerDefinition {
		return this.withCapabilities([...this.capabilities, ...capabilities]);
	}

	/** A copy of this definition with its capability list replaced (same options and setup). */
	withCapabilities(capabilities: readonly AnyMcpCapabilityDefinition[]): McpServerDefinition {
		return new McpServerDefinition(this.serverInfo, { ...this.#options(), capabilities });
	}

	/** Applies definition transforms left to right (see `mapCapabilities`, `filterCapabilities`, `prefixNames`, `decorateHandlers`). */
	transform(
		...transforms: readonly ((definition: McpServerDefinition) => McpServerDefinition)[]
	): McpServerDefinition {
		let current: McpServerDefinition = this;
		for (const transform of transforms) {
			if (typeof transform !== "function") throw new TypeError("transform must be a function.");
			current = transform(current);
			if (!(current instanceof McpServerDefinition)) {
				throw new KmcpError(
					KMCP_ERROR_CODES.INVALID_DEFINITION,
					"A definition transform must return an McpServerDefinition.",
				);
			}
		}
		return current;
	}

	/**
	 * Composes `child`'s capabilities into this definition, optionally prefixing their names
	 * (URIs are never rewritten). The result is a new frozen definition — there is no live
	 * mirroring. A child with a `setup` hook is rejected unless `allowSetup` is set, because a
	 * setup hook can register unprefixed capabilities on the raw server; with `allowSetup` the two
	 * hooks run in order (parent first) and their cleanups run in reverse.
	 */
	mount(child: McpServerDefinition, options: McpMountOptions = {}): McpServerDefinition {
		if (!(child instanceof McpServerDefinition)) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				"mount() requires an McpServerDefinition.",
			);
		}
		const childSetup = child.#setup;
		if (childSetup !== undefined && options.allowSetup !== true) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				"The mounted definition has a setup hook; pass { allowSetup: true } to chain it knowingly.",
			);
		}
		if (child.providers.length > 0) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				"Cannot mount a provider-backed definition; add its providers to the parent instead.",
			);
		}
		if (child.middleware.length > 0) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				"Cannot mount a definition with middleware; compose middleware on the parent instead.",
			);
		}
		if (options.uriNamespace !== undefined && options.prefix === undefined) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				"mount({ uriNamespace }) requires a prefix — it becomes the URI namespace.",
			);
		}
		const separator = options.separator ?? ".";
		// The child's own visibility rules are static; bake them in before merging.
		let mounted = applyVisibility(child.capabilities, child.visibility);
		if (options.uriNamespace !== undefined && options.prefix !== undefined) {
			const namespaced = child
				.withCapabilities(mounted)
				.transform(namespaceUris(options.prefix, options.uriNamespace));
			mounted = namespaced.capabilities;
		}
		const capabilities =
			options.prefix === undefined
				? mounted
				: mounted.map((capability) =>
						capability.withName(`${options.prefix}${separator}${capability.name}`),
					);
		const parentSetup = this.#setup;
		const setup = childSetup === undefined ? parentSetup : composeSetup(parentSetup, childSetup);
		return new McpServerDefinition(this.serverInfo, {
			...this.#options(),
			...(setup === undefined ? {} : { setup }),
			capabilities: [...this.capabilities, ...capabilities],
		});
	}

	/** The construction options of this definition (for derived definitions). */
	#options(): McpServerDefinitionOptions {
		const sdk = this.sdkOptions;
		return {
			...(sdk === undefined ? {} : { sdk }),
			...(this.#serverOptions.instructions === undefined
				? {}
				: { instructions: this.#serverOptions.instructions }),
			...(this.#serverOptions.capabilities?.logging === undefined ? {} : { logging: true }),
			...(this.#serverOptions.capabilities?.resources?.subscribe === false
				? { resourceSubscriptions: false }
				: {}),
			...(this.providers.length === 0 ? {} : { providers: this.providers }),
			...(this.declaredKinds.length === 0 ? {} : { declare: this.declaredKinds }),
			...(this.middleware.length === 0 ? {} : { middleware: this.middleware }),
			...(this.visibility.length === 0 ? {} : { visibility: this.visibility }),
			...(this.#setup === undefined ? {} : { setup: this.#setup }),
			...(this.#onCapabilityDenied === undefined
				? {}
				: { onCapabilityDenied: this.#onCapabilityDenied }),
			...(this.#onProviderError === undefined ? {} : { onProviderError: this.#onProviderError }),
		};
	}

	/** The construction options of this definition, without `capabilities` (for derivations). */
	configuration(): McpServerDefinitionOptions {
		return this.#options();
	}

	#installWrap(context: McpRequestContext): McpCapabilityInstallWrap | undefined {
		if (this.middleware.length === 0) return undefined;
		return middlewareInstallWrap(this.middleware, context);
	}

	/** The static capabilities plus every provider's contribution, validated and duplicate-checked. */
	async #resolve(context: McpRequestContext): Promise<readonly AnyMcpCapabilityDefinition[]> {
		if (this.providers.length === 0) return this.capabilities;
		const provided: AnyMcpCapabilityDefinition[] = [];
		for (const provider of this.providers) {
			let contribution: readonly AnyMcpCapabilityDefinition[];
			try {
				contribution = await provider(context);
			} catch (error) {
				this.#reportProviderError(error, context);
				throw new KmcpError(
					KMCP_ERROR_CODES.PROVIDER_FAILED,
					"A capability provider failed; the materialization fails closed.",
					{ cause: error },
				);
			}
			if (!Array.isArray(contribution)) {
				throw new KmcpError(
					KMCP_ERROR_CODES.PROVIDER_FAILED,
					"A capability provider must return an array of canonical definitions.",
				);
			}
			for (const capability of contribution) {
				assertCanonicalCapability(capability);
				if (!this.declaredKinds.includes(capability.kind)) {
					throw new KmcpError(
						KMCP_ERROR_CODES.PROVIDER_FAILED,
						`A provider contributed a '${capability.kind}' but the definition declares only: ${this.declaredKinds.join(", ")}.`,
					);
				}
			}
			provided.push(...contribution);
		}
		const merged = Object.freeze([...this.capabilities, ...provided]);
		assertUniqueCapabilities(merged);
		return merged;
	}

	#reportProviderError(error: unknown, context: McpRequestContext): void {
		try {
			this.#onProviderError?.(error, context);
		} catch {
			// The observability seam cannot alter the fail-closed outcome.
		}
	}

	/**
	 * The capabilities a request may see: the static capabilities plus every provider's
	 * contribution, filtered by the visibility rules, minus every capability whose `auth` check
	 * fails for `context.authInfo` (denials go to `onCapabilityDenied`). `instantiate()` installs
	 * exactly this set; gateways reuse it to reconcile long-lived instances.
	 */
	async admit(context: McpRequestContext): Promise<readonly AnyMcpCapabilityDefinition[]> {
		const visible = applyVisibility(await this.#resolve(context), this.visibility);
		const admitted: AnyMcpCapabilityDefinition[] = [];
		for (const capability of visible) {
			const auth = capability.auth;
			if (auth === undefined) {
				admitted.push(capability);
				continue;
			}
			const verdict = await evaluateAuth(auth, context);
			if (verdict.allowed) {
				admitted.push(capability);
			} else {
				this.#onCapabilityDenied?.(
					Object.freeze({ definition: capability, context, reason: verdict.reason }),
				);
			}
		}
		return admitted;
	}
}

function composeSetup(
	first: McpServerDefinitionOptions["setup"],
	second: NonNullable<McpServerDefinitionOptions["setup"]>,
): NonNullable<McpServerDefinitionOptions["setup"]> {
	return async (server, context) => {
		const firstCleanup = (await first?.(server, context)) ?? undefined;
		let secondCleanup: McpSetupCleanup | undefined;
		try {
			secondCleanup = (await second(server, context)) ?? undefined;
		} catch (error) {
			await firstCleanup?.();
			throw error;
		}
		if (firstCleanup === undefined && secondCleanup === undefined) return undefined;
		return async () => {
			try {
				await secondCleanup?.();
			} finally {
				await firstCleanup?.();
			}
		};
	};
}

async function evaluateAuth(
	auth: McpCapabilityAuth,
	context: McpRequestContext,
): Promise<McpAuthVerdict> {
	const authInfo = context.authInfo;
	if (authInfo === undefined) {
		return auth.anonymous === "allow"
			? { allowed: true }
			: { allowed: false, reason: "anonymous request" };
	}
	try {
		const verdict = await auth.check(authInfo, context);
		if (verdict === true) return { allowed: true };
		if (verdict === false) return { allowed: false, reason: "denied" };
		return verdict;
	} catch (error) {
		return {
			allowed: false,
			reason: `auth check threw: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function defineServer(
	serverInfo: Implementation,
	options: McpServerDefinitionOptions = {},
): McpServerDefinition {
	return new McpServerDefinition(serverInfo, options);
}

function buildServerOptions(
	sdk: ServerOptions | undefined,
	options: McpServerDefinitionOptions,
	capabilities: readonly AnyMcpCapabilityDefinition[],
	completers: ReadonlyMap<string, unknown>,
	declaredKinds: readonly McpCapabilityKind[],
): ServerOptions {
	const kinds = new Set([...capabilities.map((capability) => capability.kind), ...declaredKinds]);
	const hasResources = kinds.has("resource") || kinds.has("resource-template");
	const declared: Partial<ServerCapabilities> = {
		...(kinds.has("tool") ? { tools: { listChanged: true } } : {}),
		...(kinds.has("prompt") ? { prompts: { listChanged: true } } : {}),
		...(hasResources
			? { resources: { listChanged: true, subscribe: options.resourceSubscriptions !== false } }
			: {}),
		...(options.logging === true ? { logging: {} } : {}),
		...(completers.size > 0 ? { completions: {} } : {}),
	};
	return {
		enforceStrictCapabilities: true,
		...sdk,
		capabilities: mergeCapabilities(sdk?.capabilities ?? {}, declared),
		...(options.instructions === undefined
			? sdk?.instructions === undefined
				? {}
				: { instructions: sdk.instructions }
			: { instructions: options.instructions }),
	};
}

function promptCompleters(
	capabilities: readonly AnyMcpCapabilityDefinition[],
): ReadonlyMap<string, Readonly<Record<string, McpArgumentCompleter>>> {
	const completers = new Map<string, Readonly<Record<string, McpArgumentCompleter>>>();
	for (const capability of capabilities) {
		if (capability.kind !== "prompt") continue;
		const complete = (capability as AnyMcpPromptDefinition).options.complete;
		if (complete !== undefined) completers.set(capability.name, complete);
	}
	return completers;
}

const EMPTY_COMPLETION: CompleteResult = { completion: { values: [] } };

function completionResult(values: readonly string[]): CompleteResult {
	return {
		completion: {
			values: values.slice(0, 100),
			total: values.length,
			hasMore: values.length > 100,
		},
	};
}

/**
 * kmcp's own `completion/complete` handler. The SDK's is Zod-only (it looks up `completable()`
 * fields through Zod's `.shape`), so a definition that declares `complete` maps gets a handler that
 * serves prompt arguments from those maps and template variables from the SDK `ResourceTemplate`.
 */
function installCompletionHandler(
	server: McpServer,
	admitted: readonly AnyMcpCapabilityDefinition[],
	registrations: readonly McpInstalledCapability[],
	completers: ReadonlyMap<string, Readonly<Record<string, McpArgumentCompleter>>>,
): void {
	const prompts = new Set(
		admitted.filter((capability) => capability.kind === "prompt").map((c) => c.name),
	);
	const templates = registrations
		.filter((registration) => registration.definition.kind === "resource-template")
		.map((registration) => registration.handle as RegisteredResourceTemplate);
	server.server.setRequestHandler("completion/complete", async (request: CompleteRequest) => {
		const { ref, argument, context } = request.params;
		if (ref.type === "ref/prompt") {
			if (!prompts.has(ref.name)) {
				throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Prompt ${ref.name} not found`);
			}
			const completer = completers.get(ref.name)?.[argument.name];
			if (completer === undefined) return EMPTY_COMPLETION;
			return completionResult(await completer(argument.value, completionContext(context)));
		}
		const template = templates.find(
			(candidate) => candidate.resourceTemplate.uriTemplate.toString() === ref.uri,
		);
		if (template === undefined) {
			throw new ProtocolError(
				ProtocolErrorCode.InvalidParams,
				`Resource template ${ref.uri} not found`,
			);
		}
		const completer = template.resourceTemplate.completeCallback(argument.name);
		if (completer === undefined) return EMPTY_COMPLETION;
		return completionResult(await completer(argument.value, completionContext(context)));
	});
}

function completionContext(
	context: CompleteRequest["params"]["context"],
): { arguments?: Record<string, string> } | undefined {
	if (context?.arguments === undefined) return undefined;
	return { arguments: { ...context.arguments } };
}

/**
 * `resources.subscribe` is advertised so the modern `subscriptions/listen` router honours
 * `resourceSubscriptions`. `McpServer` has no legacy `resources/subscribe` RPC handler, so a
 * 2025-era client would otherwise get `-32601`; accept the RPCs and rely on the instance-wide
 * `notifications/resources/updated` fan-out (over-notification, never silence).
 */
function installLegacySubscribeHandlers(server: McpServer): void {
	server.server.setRequestHandler("resources/subscribe", () => ({}));
	server.server.setRequestHandler("resources/unsubscribe", () => ({}));
}

const CAPABILITY_KINDS: readonly McpCapabilityKind[] = Object.freeze([
	"prompt",
	"resource",
	"resource-template",
	"tool",
]);

function normalizeDeclaredKinds(
	declare: readonly McpCapabilityKind[] | undefined,
): readonly McpCapabilityKind[] {
	if (declare === undefined) return Object.freeze([]);
	const kinds = [...new Set(declare)];
	for (const kind of kinds) {
		if (!CAPABILITY_KINDS.includes(kind)) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				`Unknown capability kind in declare: '${String(kind)}'.`,
			);
		}
	}
	return Object.freeze(kinds);
}

function assertUniqueCapabilities(capabilities: readonly AnyMcpCapabilityDefinition[]): void {
	const keys = new Set<string>();
	for (const capability of capabilities) {
		for (const key of capabilityKeys(capability)) {
			if (keys.has(key)) {
				throw new KmcpError(
					KMCP_ERROR_CODES.CAPABILITY_DUPLICATE,
					`Duplicate MCP capability: ${key}.`,
				);
			}
			keys.add(key);
		}
	}
}
