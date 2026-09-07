import {
	type AuthInfo,
	CLIENT_CAPABILITIES_META_KEY,
	type CompleteRequest,
	type CompleteResult,
	type CreateMcpHandlerOptions,
	type Implementation,
	type JsonSchemaType,
	type McpHttpHandler,
	type McpServer,
	type McpRequestContext,
	type McpServerFactory,
	ProtocolError,
	ProtocolErrorCode,
	type ReadResourceResult,
	type ServerContext,
	type ServerOptions,
	UriTemplate,
	createMcpHandler,
	fromJsonSchema,
} from "@modelcontextprotocol/server";

import {
	type McpAuthVerdict,
	type McpCapabilityAuth,
	type McpRegistrationHandle,
	type McpToolResult,
	type AnyMcpCapabilityDefinition,
	definePrompt,
	defineResource,
	defineResourceTemplate,
	defineTool,
	installCanonicalCapability,
} from "../authoring/capability.ts";
import { progress } from "../authoring/context.ts";
import {
	type McpCapabilityDenial,
	type McpServable,
	McpServerDefinition,
	type McpServerRuntime,
} from "../authoring/server-definition.ts";
import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import {
	EXPOSED_NAME_REGEX,
	type McpHubCatalogSnapshot,
	type McpHubEvent,
	type McpHubManager,
	type McpHubPromptRoute,
	type McpHubResourceRoute,
	type McpHubResourceTemplateRoute,
	type McpHubToolRoute,
} from "../hub/hub.ts";
import { stableFingerprint, type MaybePromise } from "../internal/value.ts";

/** One projected upstream capability, as seen by `policy.authorize`. */
export type McpGatewayRoute<ConnectionId extends string = string> =
	| { readonly kind: "prompt"; readonly route: McpHubPromptRoute<ConnectionId> }
	| { readonly kind: "resource"; readonly route: McpHubResourceRoute<ConnectionId> }
	| {
			readonly kind: "resourceTemplate";
			readonly route: McpHubResourceTemplateRoute<ConnectionId>;
	  }
	| { readonly kind: "tool"; readonly route: McpHubToolRoute<ConnectionId> };

export interface McpGatewayAuthorization<ConnectionId extends string = string> {
	readonly check: (
		authInfo: AuthInfo,
		route: McpGatewayRoute<ConnectionId>,
		context: McpRequestContext,
	) => MaybePromise<McpAuthVerdict | boolean>;
	/** What an unauthenticated request may see. No default — decide explicitly. */
	readonly anonymous: "allow" | "deny";
}

export interface McpGatewayPolicy<ConnectionId extends string = string> {
	/** Per-principal visibility, evaluated when the per-request server is materialized. */
	readonly authorize?: McpGatewayAuthorization<ConnectionId>;
	/**
	 * `"namespaced"` (default) projects tool and prompt names as `namespace.name`.
	 * `"passthrough"` keeps upstream names; a name listed by two members drops both.
	 */
	readonly names?: "namespaced" | "passthrough";
	/**
	 * `"namespaced"` (default) projects resource URIs reversibly as `namespace:uri`; requires the
	 * namespace to be a valid URI scheme (members whose namespace is not are reported as dropped).
	 * `"passthrough"` keeps upstream URIs; a URI listed by two members drops both.
	 */
	readonly resources?: "namespaced" | "passthrough";
	/** Forward `completion/complete` to upstreams that advertise `completions`. Default: `true`. */
	readonly completions?: boolean;
}

export interface McpGatewayOptions<HubId extends string, ConnectionId extends string> {
	readonly hubs: McpHubManager<HubId, ConnectionId>;
	readonly hubId: HubId;
	readonly serverInfo: Implementation;
	readonly instructions?: string;
	readonly policy?: McpGatewayPolicy<ConnectionId>;
	/** Extra SDK options for the materialized servers (never `requestState.verify`: rounds are relayed verbatim). */
	readonly sdk?: ServerOptions;
	readonly onCapabilityDenied?: (denial: McpCapabilityDenial) => void;
}

export interface McpGatewayDropped<ConnectionId extends string = string> {
	readonly kind: McpGatewayRoute["kind"];
	readonly connectionId: ConnectionId;
	readonly namespace: string;
	/** The upstream name (tools, prompts) or URI / URI template (resources). */
	readonly source: string;
	/** What the hub exposes: `source` after the member's rename (tools), else `source` itself. */
	readonly exposedName: string;
	/** The name / URI this gateway projected, which is what the drop decision was made on. */
	readonly name: string;
	readonly reason:
		| "invalid-name"
		| "invalid-template"
		| "name-collision"
		| "namespace-not-uri-scheme"
		| "uri-collision";
}

export interface McpGatewaySnapshot<
	HubId extends string = string,
	ConnectionId extends string = string,
> {
	readonly hubId: HubId;
	readonly generationByConnection: Readonly<Record<string, number>>;
	readonly projected: {
		readonly tools: number;
		readonly prompts: number;
		readonly resources: number;
		readonly resourceTemplates: number;
	};
	readonly dropped: readonly McpGatewayDropped<ConnectionId>[];
	/** Identity of the projected topology; changes whenever any section changes. */
	readonly topologyKey: string;
}

export interface McpGatewayEvent<
	HubId extends string = string,
	ConnectionId extends string = string,
> {
	readonly type: "gateway.topology.changed";
	readonly changed: readonly ("prompts" | "resources" | "tools")[];
	readonly snapshot: McpGatewaySnapshot<HubId, ConnectionId>;
}

export type McpGatewayListener<HubId extends string, ConnectionId extends string> = (
	event: McpGatewayEvent<HubId, ConnectionId>,
) => MaybePromise<void>;

/** A started gateway: watches the hub and pushes list-changed notifications downstream. */
export interface McpGatewayRuntime extends AsyncDisposable {
	close(): Promise<void>;
}

const URI_SCHEME_REGEX = /^[A-Za-z][A-Za-z0-9+.-]*$/;

/** Per-instance state a shared handler closure can reach; empty for shared (modern) projections. */
interface InstanceHolder {
	server?: McpServer;
}

interface InstalledEntry {
	readonly handle: McpRegistrationHandle;
	readonly version: string;
}

/** A materialized instance the gateway keeps in sync while it stays connected. */
interface GatewayInstance {
	readonly server: McpServer;
	readonly context: McpRequestContext;
	readonly holder: InstanceHolder;
	readonly installed: Map<string, InstalledEntry>;
}

/** The current route behind each projected name/URI; handlers resolve through it at call time. */
interface RouteIndex<ConnectionId extends string> {
	readonly tools: ReadonlyMap<string, McpHubToolRoute<ConnectionId>>;
	readonly prompts: ReadonlyMap<string, McpHubPromptRoute<ConnectionId>>;
	readonly resources: ReadonlyMap<string, McpHubResourceRoute<ConnectionId>>;
	readonly templates: ReadonlyMap<string, McpHubResourceTemplateRoute<ConnectionId>>;
}

const LIST_CHANGED_METHODS = [
	"notifications/tools/list_changed",
	"notifications/prompts/list_changed",
	"notifications/resources/list_changed",
];

interface Projection<HubId extends string, ConnectionId extends string> {
	readonly key: string;
	/** Whether the materialized servers advertise `completions`. */
	readonly completions: boolean;
	readonly sectionKeys: {
		readonly tools: string;
		readonly prompts: string;
		readonly resources: string;
	};
	readonly definition: McpServerDefinition;
	readonly snapshot: McpGatewaySnapshot<HubId, ConnectionId>;
}

/**
 * Serves a hub as a downstream MCP server. Every request materializes a server from ONE hub
 * catalog snapshot (immutable topology), forwards through generation- and fingerprint-fenced
 * hub routes (fail-closed execution), projects names collision-safely, and relays multi-round-trip
 * rounds verbatim. Downstream `authInfo` is never forwarded upstream: each upstream connection
 * carries its own credentials.
 */
export class McpGatewayDefinition<
	const HubId extends string = string,
	const ConnectionId extends string = string,
> implements McpServable {
	readonly serverInfo: Readonly<Implementation>;
	readonly hubId: HubId;
	readonly #hubs: McpHubManager<HubId, ConnectionId>;
	readonly #instructions: string | undefined;
	readonly #policy: Required<
		Pick<McpGatewayPolicy<ConnectionId>, "completions" | "names" | "resources">
	> &
		Pick<McpGatewayPolicy<ConnectionId>, "authorize">;
	readonly #sdk: ServerOptions | undefined;
	readonly #onCapabilityDenied: ((denial: McpCapabilityDenial) => void) | undefined;
	readonly #handlers = new Set<McpHttpHandler>();
	readonly #instances = new Set<GatewayInstance>();
	readonly #listeners = new Set<McpGatewayListener<HubId, ConnectionId>>();
	readonly #versions = new WeakMap<AnyMcpCapabilityDefinition, string>();
	readonly #keys = new WeakMap<AnyMcpCapabilityDefinition, string>();
	#routes: RouteIndex<ConnectionId> = {
		tools: new Map(),
		prompts: new Map(),
		resources: new Map(),
		templates: new Map(),
	};
	#projection: Projection<HubId, ConnectionId> | undefined;

	constructor(options: McpGatewayOptions<HubId, ConnectionId>) {
		if (typeof options.hubs?.catalog !== "function") {
			throw new KmcpError(KMCP_ERROR_CODES.INVALID_DEFINITION, "defineGateway requires `hubs`.");
		}
		this.#hubs = options.hubs;
		this.hubId = options.hubId;
		this.serverInfo = Object.freeze({ ...options.serverInfo });
		this.#instructions = options.instructions;
		this.#policy = Object.freeze({
			names: options.policy?.names ?? "namespaced",
			resources: options.policy?.resources ?? "namespaced",
			completions: options.policy?.completions ?? true,
			...(options.policy?.authorize === undefined ? {} : { authorize: options.policy.authorize }),
		});
		if (options.sdk?.requestState !== undefined) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				"A gateway relays requestState verbatim; do not configure sdk.requestState.",
			);
		}
		this.#sdk = options.sdk;
		this.#onCapabilityDenied = options.onCapabilityDenied;
		// Validate the hub exists now, not on the first request.
		this.#hubs.state(this.hubId);
	}

	/** The definition currently projected from the hub (rebuilt when the topology changes). */
	current(): McpServerDefinition {
		return this.#project().definition;
	}

	snapshot(): McpGatewaySnapshot<HubId, ConnectionId> {
		return this.#project().snapshot;
	}

	/** True when `policy.authorize.anonymous` is `"deny"`: such a gateway needs an auth gate. */
	get requiresAuthenticatedPrincipal(): boolean {
		return this.#policy.authorize?.anonymous === "deny";
	}

	async create(context: McpRequestContext): Promise<McpServer> {
		return (await this.instantiate(context)).server;
	}

	factory(): McpServerFactory {
		return (context) => this.create(context);
	}

	handler(options?: CreateMcpHandlerOptions): McpHttpHandler {
		const inner = createMcpHandler(this.factory(), options);
		const tracked: McpHttpHandler = {
			fetch: inner.fetch,
			notify: inner.notify,
			bus: inner.bus,
			close: async () => {
				this.#handlers.delete(tracked);
				await inner.close();
			},
		};
		this.#handlers.add(tracked);
		return tracked;
	}

	async instantiate(context: McpRequestContext): Promise<McpServerRuntime> {
		// A 2025-era connection carries client capabilities only in its initialize state, which
		// lives on the instance; a per-instance holder lets shared handler closures reach it.
		const holder: InstanceHolder = {};
		const projection = context.era === "legacy" ? this.#projectFor(holder) : this.#project();
		const runtime = await projection.definition.instantiate(context);
		holder.server = runtime.server;
		const installed = new Map<string, InstalledEntry>();
		for (const registration of runtime.registrations) {
			const key = this.#keys.get(registration.definition);
			const version = this.#versions.get(registration.definition);
			if (key !== undefined && version !== undefined) {
				installed.set(key, { handle: registration.handle, version });
			}
		}
		const instance: GatewayInstance = { server: runtime.server, context, holder, installed };
		if (projection.completions) this.#installCompletionHandler(instance);
		// Prune instances that disconnected (per-request HTTP instances are short-lived).
		for (const candidate of this.#instances) {
			if (!candidate.server.isConnected()) this.#instances.delete(candidate);
		}
		this.#instances.add(instance);
		return runtime;
	}

	/**
	 * `completion/complete` forwarded to the upstream that owns the prompt / template; kmcp's own
	 * completion handler is bypassed so instances reconciled after connect keep completing.
	 */
	#installCompletionHandler(instance: GatewayInstance): void {
		const hubs = this.#hubs;
		const hubId = this.hubId;
		instance.server.server.setRequestHandler(
			"completion/complete",
			async (request: CompleteRequest): Promise<CompleteResult> => {
				const { ref, argument, context } = request.params;
				const target =
					ref.type === "ref/prompt"
						? {
								key: `prompt:${ref.name}`,
								route: this.#routes.prompts.get(ref.name),
							}
						: { key: `template:${ref.uri}`, route: this.#routes.templates.get(ref.uri) };
				if (target.route === undefined || !instance.installed.has(target.key)) {
					throw new ProtocolError(
						ProtocolErrorCode.InvalidParams,
						ref.type === "ref/prompt"
							? `Prompt ${ref.name} not found`
							: `Resource template ${ref.uri} not found`,
					);
				}
				return hubs
					.complete(
						hubId,
						target.route,
						{ name: argument.name, value: argument.value },
						context?.arguments === undefined ? undefined : { arguments: context.arguments },
					)
					.catch(gatewayProtocolError);
			},
		);
	}

	/**
	 * Brings a connected instance (a pinned stdio connection, or an in-flight request) in line
	 * with the current projection: capabilities that disappeared or changed generation are
	 * removed, new ones installed. The SDK emits the list-changed notifications itself.
	 */
	async #reconcile(
		instance: GatewayInstance,
		projection: Projection<HubId, ConnectionId>,
	): Promise<void> {
		if (!instance.server.isConnected()) {
			this.#instances.delete(instance);
			return;
		}
		const admitted = await projection.definition.admit(instance.context);
		const wanted = new Map<string, AnyMcpCapabilityDefinition>();
		for (const capability of admitted) {
			const key = this.#keys.get(capability);
			if (key !== undefined) wanted.set(key, capability);
		}
		for (const [key, entry] of instance.installed) {
			const next = wanted.get(key);
			if (next !== undefined && this.#versions.get(next) === entry.version) continue;
			entry.handle.remove();
			instance.installed.delete(key);
		}
		for (const [key, capability] of wanted) {
			if (instance.installed.has(key)) continue;
			const version = this.#versions.get(capability);
			if (version === undefined) continue;
			instance.installed.set(key, {
				handle: installCanonicalCapability(capability, instance.server),
				version,
			});
		}
	}

	subscribe(listener: McpGatewayListener<HubId, ConnectionId>): () => void {
		if (typeof listener !== "function") throw new TypeError("listener must be a function.");
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Watches the hub: whenever a member's catalog is refreshed (or a member goes away), the
	 * projection is rebuilt and every live downstream handler / pinned instance receives the
	 * matching list-changed notifications. Never closes upstream connections.
	 */
	start(): McpGatewayRuntime {
		let previous = this.#project();
		const unsubscribe = this.#hubs.subscribe((event: McpHubEvent<HubId, ConnectionId>) => {
			if (event.hub.id !== this.hubId) return;
			if (
				event.type !== "hub.catalog.refreshed" &&
				event.type !== "hub.connection.changed" &&
				event.type !== "hub.updated"
			) {
				return;
			}
			const next = this.#project();
			if (next.key === previous.key) return;
			const changed: ("prompts" | "resources" | "tools")[] = [];
			if (next.sectionKeys.tools !== previous.sectionKeys.tools) changed.push("tools");
			if (next.sectionKeys.prompts !== previous.sectionKeys.prompts) changed.push("prompts");
			if (next.sectionKeys.resources !== previous.sectionKeys.resources) changed.push("resources");
			previous = next;
			void this.#notifyDownstream(changed, next);
			this.#publish({ type: "gateway.topology.changed", changed, snapshot: next.snapshot });
		});
		let closed = false;
		const close = async () => {
			if (closed) return;
			closed = true;
			unsubscribe();
		};
		return { close, [Symbol.asyncDispose]: close };
	}

	async #notifyDownstream(
		changed: readonly ("prompts" | "resources" | "tools")[],
		projection: Projection<HubId, ConnectionId>,
	): Promise<void> {
		for (const handler of this.#handlers) {
			for (const section of changed) {
				try {
					if (section === "tools") await handler.notify.toolsChanged();
					else if (section === "prompts") await handler.notify.promptsChanged();
					else await handler.notify.resourcesChanged();
				} catch {
					// A closed handler cannot be notified; it is removed when its owner closes it.
				}
			}
		}
		for (const instance of this.#instances) {
			// Legacy instances hold a per-instance projection (for the initialize-declared client
			// capabilities); rebuild it against the same holder before reconciling.
			const target =
				instance.context.era === "legacy" ? this.#projectFor(instance.holder) : projection;
			try {
				await this.#reconcile(instance, target);
			} catch {
				this.#instances.delete(instance);
			}
		}
	}

	#publish(event: McpGatewayEvent<HubId, ConnectionId>): void {
		for (const listener of this.#listeners) {
			try {
				void Promise.resolve(listener(event)).catch(() => undefined);
			} catch {
				// Listeners cannot alter gateway lifecycle.
			}
		}
	}

	#track(
		capability: AnyMcpCapabilityDefinition,
		key: string,
		route: {
			readonly connectionId: string;
			readonly generation: number;
			readonly catalogFingerprint: string;
		},
	): void {
		this.#keys.set(capability, key);
		this.#versions.set(
			capability,
			`${route.connectionId}:${route.generation}:${route.catalogFingerprint}`,
		);
	}

	#projectFor(holder: InstanceHolder): Projection<HubId, ConnectionId> {
		const catalog = this.#hubs.catalog(this.hubId);
		const completionsByConnection = this.#completions();
		return this.#build(
			catalog,
			topologyKey(catalog, this.#policy, completionsByConnection),
			completionsByConnection,
			holder,
		);
	}

	#completions(): Map<ConnectionId, boolean> {
		const state = this.#hubs.state(this.hubId);
		const completionsByConnection = new Map<ConnectionId, boolean>();
		for (const member of state.members) {
			completionsByConnection.set(
				member.connection.id,
				member.connection.capabilities?.completions !== undefined,
			);
		}
		return completionsByConnection;
	}

	#project(): Projection<HubId, ConnectionId> {
		const catalog = this.#hubs.catalog(this.hubId);
		const completionsByConnection = this.#completions();
		const key = topologyKey(catalog, this.#policy, completionsByConnection);
		if (this.#projection?.key === key) return this.#projection;
		const projection = this.#build(catalog, key, completionsByConnection);
		this.#projection = projection;
		return projection;
	}

	#build(
		catalog: McpHubCatalogSnapshot<HubId, ConnectionId>,
		key: string,
		completionsByConnection: ReadonlyMap<ConnectionId, boolean>,
		holder: InstanceHolder = {},
	): Projection<HubId, ConnectionId> {
		const hubs = this.#hubs;
		const hubId = this.hubId;
		const dropped: McpGatewayDropped<ConnectionId>[] = [];
		const capabilities: AnyMcpCapabilityDefinition[] = [];
		const tools = new Map<string, McpHubToolRoute<ConnectionId>>();
		const prompts = new Map<string, McpHubPromptRoute<ConnectionId>>();
		const resources = new Map<string, McpHubResourceRoute<ConnectionId>>();
		const templates = new Map<string, McpHubResourceTemplateRoute<ConnectionId>>();
		const authFor = (route: McpGatewayRoute<ConnectionId>): McpCapabilityAuth | undefined => {
			const authorize = this.#policy.authorize;
			if (authorize === undefined) return undefined;
			return {
				anonymous: authorize.anonymous,
				check: (authInfo, context) => authorize.check(authInfo, route, context),
			};
		};

		const nameMode = this.#policy.names;
		const toolNameCollisions =
			nameMode === "passthrough"
				? // A renamed tool collides under its EXPOSED name, which is what passthrough projects.
					nameCollisions(
						catalog.tools.map((route) => ({
							sourceName: route.exposedName,
							connectionId: route.connectionId,
						})),
					)
				: new Set<string>();
		const promptNameCollisions =
			nameMode === "passthrough" ? nameCollisions(catalog.prompts) : new Set<string>();
		let toolCount = 0;
		for (const route of catalog.tools) {
			const name = nameMode === "passthrough" ? route.exposedName : route.route;
			// The decision is made on the PROJECTED name, so the drop record carries it (and the
			// exposed name it came from) next to the upstream `source`.
			const names = { source: route.sourceName, exposedName: route.exposedName, name };
			if (!EXPOSED_NAME_REGEX.test(name)) {
				dropped.push(drop("tool", route, names, "invalid-name"));
				continue;
			}
			if (toolNameCollisions.has(name)) {
				dropped.push(drop("tool", route, names, "name-collision"));
				continue;
			}
			const tool = route.tool;
			const auth = authFor({ kind: "tool", route });
			const metadata = {
				...exact(tool, ["description", "title", "annotations", "icons", "_meta"]),
				...(auth === undefined ? {} : { auth }),
			};
			const inputSchema = fromJsonSchema<Record<string, unknown>>(
				tool.inputSchema as JsonSchemaType,
			);
			const forward = async (args: Record<string, unknown>, ctx: ServerContext) => {
				const current = this.#routes.tools.get(name);
				if (current === undefined) throw staleRoute(name);
				const report = progress(ctx);
				return hubs.callTool(hubId, current, args, {
					allowInputRequired: true,
					signal: ctx.mcpReq.signal,
					onprogress: (value) => {
						void report(value.progress, value.total, value.message).catch(() => undefined);
					},
					...forwardedRound(ctx, holder),
				});
			};
			let capability: AnyMcpCapabilityDefinition;
			if (tool.outputSchema === undefined) {
				capability = defineTool(name, { ...metadata, inputSchema }, forward);
			} else {
				const outputSchema = fromJsonSchema<Record<string, unknown>>(
					tool.outputSchema as JsonSchemaType,
				);
				capability = defineTool(
					name,
					{ ...metadata, inputSchema, outputSchema },
					// The upstream result is relayed verbatim; the SDK validates it against the
					// advertised output schema at the gateway seam exactly as it would upstream.
					(args, ctx) => forward(args, ctx) as Promise<McpToolResult<typeof outputSchema>>,
				);
			}
			this.#track(capability, `tool:${name}`, route);
			capabilities.push(capability);
			tools.set(name, route);
			toolCount += 1;
		}

		let promptCount = 0;
		for (const route of catalog.prompts) {
			const name = nameMode === "passthrough" ? route.sourceName : route.route;
			const names = { source: route.sourceName, exposedName: route.sourceName, name };
			if (!EXPOSED_NAME_REGEX.test(name)) {
				dropped.push(drop("prompt", route, names, "invalid-name"));
				continue;
			}
			if (promptNameCollisions.has(name)) {
				dropped.push(drop("prompt", route, names, "name-collision"));
				continue;
			}
			const prompt = route.prompt;
			const auth = authFor({ kind: "prompt", route });
			const metadata = {
				...exact(prompt, ["description", "title", "icons", "_meta"]),
				...(auth === undefined ? {} : { auth }),
			};
			const forward = (values: Record<string, string> | undefined, ctx: ServerContext) => {
				const current = this.#routes.prompts.get(name);
				if (current === undefined) throw staleRoute(name);
				return hubs
					.getPrompt(hubId, current, values, {
						signal: ctx.mcpReq.signal,
						...forwardedMeta(ctx, holder),
					})
					.catch(gatewayProtocolError);
			};
			const args = prompt.arguments ?? [];
			const capability: AnyMcpCapabilityDefinition =
				args.length === 0
					? definePrompt(name, metadata, (ctx) => forward(undefined, ctx))
					: definePrompt(
							name,
							{
								...metadata,
								argsSchema: fromJsonSchema<Record<string, string>>({
									type: "object",
									properties: Object.fromEntries(
										args.map((argument) => [
											argument.name,
											{
												type: "string",
												...(argument.description === undefined
													? {}
													: { description: argument.description }),
											},
										]),
									),
									required: args
										.filter((argument) => argument.required === true)
										.map((argument) => argument.name),
								}),
							},
							(values, ctx) => forward(stringArguments(values), ctx),
						);
			this.#track(capability, `prompt:${name}`, route);
			capabilities.push(capability);
			prompts.set(name, route);
			promptCount += 1;
		}

		const mode = this.#policy.resources;
		const collisions = mode === "passthrough" ? uriCollisions(catalog) : new Set<string>();
		let resourceCount = 0;
		for (const route of catalog.resources) {
			const projected = projectUri(mode, route.namespace, route.sourceUri);
			const names = {
				source: route.sourceUri,
				exposedName: route.sourceUri,
				name: projected ?? `${route.namespace}:${route.sourceUri}`,
			};
			if (projected === undefined) {
				dropped.push(drop("resource", route, names, "namespace-not-uri-scheme"));
				continue;
			}
			if (collisions.has(route.sourceUri)) {
				dropped.push(drop("resource", route, names, "uri-collision"));
				continue;
			}
			const resource = route.resource;
			const auth = authFor({ kind: "resource", route });
			const prefix = mode === "namespaced" ? `${route.namespace}:` : "";
			const capability = defineResource(
				`${route.namespace}.${resource.name}`,
				projected,
				{
					...exact(resource, [
						"description",
						"title",
						"mimeType",
						"icons",
						"annotations",
						"_meta",
						"size",
					]),
					...(auth === undefined ? {} : { auth }),
				},
				async (_uri, ctx) => {
					const current = this.#routes.resources.get(projected);
					if (current === undefined) throw staleRoute(projected);
					return prefixContents(
						await hubs
							.readResource(hubId, current, {
								signal: ctx.mcpReq.signal,
								...forwardedMeta(ctx, holder),
							})
							.catch(gatewayProtocolError),
						prefix,
					);
				},
			);
			this.#track(capability, `resource:${projected}`, route);
			capabilities.push(capability);
			resources.set(projected, route);
			resourceCount += 1;
		}

		let templateCount = 0;
		for (const route of catalog.resourceTemplates) {
			const projected = projectUri(mode, route.namespace, route.sourceUriTemplate);
			const names = {
				source: route.sourceUriTemplate,
				exposedName: route.sourceUriTemplate,
				name: projected ?? `${route.namespace}:${route.sourceUriTemplate}`,
			};
			if (projected === undefined) {
				dropped.push(drop("resourceTemplate", route, names, "namespace-not-uri-scheme"));
				continue;
			}
			if (collisions.has(route.sourceUriTemplate)) {
				dropped.push(drop("resourceTemplate", route, names, "uri-collision"));
				continue;
			}
			let sourceTemplate: UriTemplate;
			try {
				new UriTemplate(projected);
				sourceTemplate = new UriTemplate(route.sourceUriTemplate);
			} catch {
				dropped.push(drop("resourceTemplate", route, names, "invalid-template"));
				continue;
			}
			const resourceTemplate = route.resourceTemplate;
			const auth = authFor({ kind: "resourceTemplate", route });
			const prefix = mode === "namespaced" ? `${route.namespace}:` : "";
			const capability = defineResourceTemplate(
				`${route.namespace}.${resourceTemplate.name}`,
				projected,
				{
					...exact(resourceTemplate, [
						"description",
						"title",
						"mimeType",
						"icons",
						"annotations",
						"_meta",
					]),
					...(auth === undefined ? {} : { auth }),
				},
				async (uri, variables, ctx) => {
					const current = this.#routes.templates.get(projected);
					if (current === undefined) throw staleRoute(projected);
					const raw = uri.href;
					const sourceUri =
						prefix.length > 0 && raw.startsWith(prefix)
							? raw.slice(prefix.length)
							: prefix.length === 0
								? raw
								: sourceTemplate.expand(variables as Record<string, string>);
					return prefixContents(
						await hubs
							.readResource(hubId, current.namespace, sourceUri, {
								signal: ctx.mcpReq.signal,
								...forwardedMeta(ctx, holder),
							})
							.catch(gatewayProtocolError),
						prefix,
					);
				},
			);
			this.#track(capability, `template:${projected}`, route);
			capabilities.push(capability);
			templates.set(projected, route);
			templateCount += 1;
		}

		const completions =
			this.#policy.completions && [...completionsByConnection.values()].some(Boolean);
		const sdk: ServerOptions = {
			...this.#sdk,
			debouncedNotificationMethods: [
				...new Set([...(this.#sdk?.debouncedNotificationMethods ?? []), ...LIST_CHANGED_METHODS]),
			],
			...(completions
				? { capabilities: { ...this.#sdk?.capabilities, completions: {} } }
				: this.#sdk?.capabilities === undefined
					? {}
					: { capabilities: this.#sdk.capabilities }),
		};
		const definition = new McpServerDefinition(this.serverInfo, {
			...(this.#instructions === undefined ? {} : { instructions: this.#instructions }),
			sdk,
			resourceSubscriptions: false,
			capabilities,
			...(this.#onCapabilityDenied === undefined
				? {}
				: { onCapabilityDenied: this.#onCapabilityDenied }),
		});
		const generationByConnection: Record<string, number> = {};
		for (const member of catalog.members) {
			if (member.catalog !== undefined) {
				generationByConnection[member.connectionId] = member.catalog.generation;
			}
		}
		const snapshot: McpGatewaySnapshot<HubId, ConnectionId> = Object.freeze({
			hubId: this.hubId,
			generationByConnection: Object.freeze(generationByConnection),
			projected: Object.freeze({
				tools: toolCount,
				prompts: promptCount,
				resources: resourceCount,
				resourceTemplates: templateCount,
			}),
			dropped: Object.freeze(dropped),
			topologyKey: key,
		});
		this.#routes = Object.freeze({ tools, prompts, resources, templates });
		return Object.freeze({
			key,
			completions,
			sectionKeys: Object.freeze({
				tools: sectionKey(catalog.tools),
				prompts: sectionKey(catalog.prompts),
				resources: `${sectionKey(catalog.resources)}|${sectionKey(catalog.resourceTemplates)}`,
			}),
			definition,
			snapshot,
		});
	}
}

export function defineGateway<const HubId extends string, const ConnectionId extends string>(
	options: McpGatewayOptions<HubId, ConnectionId>,
): McpGatewayDefinition<HubId, ConnectionId> {
	return new McpGatewayDefinition(options);
}

/**
 * Picks the present keys of a catalog item. Catalog items are clone-normalized JSON (undefined
 * properties are omitted at capture), so the exact-optional cast below is sound at runtime.
 */
function exact<Item extends object, Key extends keyof Item>(
	item: Item,
	keys: readonly Key[],
): { readonly [K in Key]?: Exclude<Item[K], undefined> } {
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		const value = item[key];
		if (value !== undefined) out[key as string] = value;
	}
	return out as { readonly [K in Key]?: Exclude<Item[K], undefined> };
}

function drop<ConnectionId extends string>(
	kind: McpGatewayRoute["kind"],
	route: { readonly connectionId: ConnectionId; readonly namespace: string },
	names: { readonly source: string; readonly exposedName: string; readonly name: string },
	reason: McpGatewayDropped["reason"],
): McpGatewayDropped<ConnectionId> {
	return Object.freeze({
		kind,
		connectionId: route.connectionId,
		namespace: route.namespace,
		...names,
		reason,
	});
}

function projectUri(
	mode: "namespaced" | "passthrough",
	namespace: string,
	uri: string,
): string | undefined {
	if (mode === "passthrough") return uri;
	return URI_SCHEME_REGEX.test(namespace) ? `${namespace}:${uri}` : undefined;
}

function nameCollisions(
	routes: readonly { readonly sourceName: string; readonly connectionId: string }[],
): Set<string> {
	const owners = new Map<string, Set<string>>();
	for (const route of routes) {
		const set = owners.get(route.sourceName) ?? new Set<string>();
		set.add(route.connectionId);
		owners.set(route.sourceName, set);
	}
	const collisions = new Set<string>();
	for (const [name, set] of owners) if (set.size > 1) collisions.add(name);
	return collisions;
}

function uriCollisions<HubId extends string, ConnectionId extends string>(
	catalog: McpHubCatalogSnapshot<HubId, ConnectionId>,
): Set<string> {
	const owners = new Map<string, Set<ConnectionId>>();
	const note = (uri: string, connectionId: ConnectionId) => {
		const set = owners.get(uri) ?? new Set<ConnectionId>();
		set.add(connectionId);
		owners.set(uri, set);
	};
	for (const route of catalog.resources) note(route.sourceUri, route.connectionId);
	for (const route of catalog.resourceTemplates) note(route.sourceUriTemplate, route.connectionId);
	const collisions = new Set<string>();
	for (const [uri, set] of owners) if (set.size > 1) collisions.add(uri);
	return collisions;
}

/**
 * Identity of one projected section: the upstream catalogs behind it AND the exact set of routes it
 * exposes. Folding the routes in is what makes a hub update that changes WHICH names are exposed
 * without changing the count — a flipped `deny`, a pure rename — report the section as changed.
 */
function sectionKey(
	routes: readonly {
		connectionId: string;
		generation: number;
		catalogFingerprint: string;
		route: string;
	}[],
): string {
	const parts = new Set<string>();
	const identities: string[] = [];
	for (const route of routes) {
		parts.add(`${route.connectionId}:${route.generation}:${route.catalogFingerprint}`);
		identities.push(route.route);
	}
	return `${routes.length}/${[...parts].sort().join(",")}/${stableFingerprint(identities.sort())}`;
}

function topologyKey<HubId extends string, ConnectionId extends string>(
	catalog: McpHubCatalogSnapshot<HubId, ConnectionId>,
	policy: { readonly names: string; readonly resources: string; readonly completions: boolean },
	completions: ReadonlyMap<ConnectionId, boolean>,
): string {
	const members = catalog.members
		.map(
			(member) =>
				`${member.connectionId}=${member.catalog?.generation ?? "-"}:${member.catalog?.fingerprint ?? "-"}:${completions.get(member.connectionId) === true ? "c" : "-"}`,
		)
		.join("|");
	// The hub fingerprint covers namespaces, member filters and renames, so a `hub.updated` that only
	// changes the exposed view (same upstream catalogs, same counts) still rebuilds the projection.
	return `${policy.names}/${policy.resources}/${policy.completions ? "c" : "-"}/${catalog.fingerprint}/${members}/${catalog.tools.length}/${catalog.prompts.length}/${catalog.resources.length}/${catalog.resourceTemplates.length}`;
}

/** The current MRTR round to relay: the downstream client's embedded responses and echoed state. */
function forwardedRound(
	ctx: ServerContext,
	holder: InstanceHolder,
): {
	inputResponses?: Readonly<Record<string, unknown>>;
	requestState?: string;
	meta?: Readonly<Record<string, unknown>>;
} {
	const requestState = ctx.mcpReq.requestState<unknown>();
	return {
		...(ctx.mcpReq.inputResponses === undefined
			? {}
			: { inputResponses: ctx.mcpReq.inputResponses }),
		...(typeof requestState === "string" ? { requestState } : {}),
		...forwardedMeta(ctx, holder),
	};
}

/**
 * Forwards the DOWNSTREAM client's capabilities on the upstream request (`_meta` envelope key), so
 * the upstream's MRTR capability check sees the party that will actually answer its embedded
 * requests — never the gateway's own client declarations.
 */
function forwardedMeta(
	ctx: ServerContext,
	holder: InstanceHolder,
): { meta?: Readonly<Record<string, unknown>> } {
	const envelope = (ctx.mcpReq.envelope ?? {}) as Readonly<Record<string, unknown>>;
	// Modern: the request's own envelope. Legacy: the connection's initialize-declared state,
	// readable only from the pinned instance (per-instance projections carry it in `holder`).
	const capabilities =
		envelope[CLIENT_CAPABILITIES_META_KEY] ?? holder.server?.server.getClientCapabilities();
	if (capabilities === undefined || capabilities === null || typeof capabilities !== "object") {
		return {};
	}
	return { meta: { [CLIENT_CAPABILITIES_META_KEY]: capabilities } };
}

function stringArguments(values: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		if (typeof value === "string") out[key] = value;
		else if (value !== undefined) out[key] = String(value);
	}
	return out;
}

function prefixContents(result: ReadResourceResult, prefix: string): ReadResourceResult {
	if (prefix.length === 0) return result;
	return {
		...result,
		contents: result.contents.map((content) =>
			content.uri.startsWith(prefix) ? content : { ...content, uri: `${prefix}${content.uri}` },
		),
	};
}

function staleRoute(name: string): KmcpError {
	return new KmcpError(
		KMCP_ERROR_CODES.HUB_ROUTE_UNKNOWN,
		`'${name}' is no longer routed by this gateway.`,
	);
}

/** Maps a fenced-route failure (stale topology, upstream offline) to the protocol error a downstream expects. */
export function gatewayProtocolError(error: unknown): never {
	if (error instanceof KmcpError) {
		throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message);
	}
	throw error;
}
