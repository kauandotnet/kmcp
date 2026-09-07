import {
	type CallToolResult,
	type CompleteResult,
	type GetPromptResult,
	type Prompt,
	type ReadResourceResult,
	type Resource,
	type ResourceTemplateType,
	type Tool,
	UriTemplate,
} from "@modelcontextprotocol/client";

import { KMCP_ERROR_CODES, KmcpError, errorCode } from "../errors.ts";
import {
	assertNonEmpty,
	immutableClone,
	stableFingerprint,
	type MaybePromise,
} from "../internal/value.ts";
import type { McpCatalogSection, McpCatalogSnapshot } from "../client/catalog.ts";
import type {
	McpCallToolOptions,
	McpCallToolParsedOptions,
	McpParsedToolResult,
	McpConnectionEvent,
	McpConnectionManagerSnapshot,
	McpConnectionOperationControl,
	McpConnectionSnapshot,
	McpReadOptions,
	McpRequestOptionsWithMeta,
} from "../client/manager.ts";
import { McpConnectionManager } from "../client/manager.ts";

/**
 * The character/length rule a projected tool or prompt name must satisfy downstream: the SDK
 * name grammar the gateway and the capability providers enforce. Rename sources and targets are
 * validated against it at definition time, so a hub never routes a name a projection would drop.
 */
export const EXPOSED_NAME_REGEX = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * An allow/deny list over a member's items, evaluated on the UPSTREAM identity (a tool or prompt
 * name, a resource URI or URI template) BEFORE renaming and namespacing. A pattern is an exact
 * identity or a prefix ending in a single trailing `*` (`git_*`). `deny` always wins over `allow`;
 * when `allow` is present only matching items are exposed; an absent filter exposes everything.
 */
export interface McpHubMemberFilter {
	readonly allow?: readonly string[];
	readonly deny?: readonly string[];
}

export interface McpHubMember<ConnectionId extends string = string> {
	readonly connectionId: ConnectionId;
	readonly namespace: string;
	/** Filters the member's tools by upstream tool name. */
	readonly tools?: McpHubMemberFilter;
	/** Filters the member's prompts by upstream prompt name. */
	readonly prompts?: McpHubMemberFilter;
	/** Filters the member's resources and resource templates by URI / URI template. */
	readonly resources?: McpHubMemberFilter;
	/**
	 * Tools only: upstream tool name -> exposed name, applied after `tools` filtering and before
	 * namespacing. Renamed tools keep their schemas and annotations; the upstream call still uses
	 * the upstream name.
	 */
	readonly rename?: Readonly<Record<string, string>>;
}

export interface McpHubDefinitionOptions<HubId extends string, ConnectionId extends string> {
	readonly id: HubId;
	readonly label?: string;
	readonly members?: readonly McpHubMember<ConnectionId>[];
	readonly tags?: Readonly<Record<string, string>>;
}

export class McpHubDefinition<
	const HubId extends string = string,
	const ConnectionId extends string = string,
> {
	readonly id: HubId;
	readonly label: string;
	readonly members: readonly McpHubMember<ConnectionId>[];
	readonly tags: Readonly<Record<string, string>>;
	/**
	 * A stable digest of everything that shapes the exposed surface: members, namespaces, filters
	 * and renames. Two definitions with the same fingerprint project the same catalog from the same
	 * upstream catalogs, so a consumer can treat `hub.updated` as a no-op when it does not change.
	 */
	readonly fingerprint: string;

	constructor(options: McpHubDefinitionOptions<HubId, ConnectionId>) {
		assertNonEmpty(options.id, "hub id");
		this.id = options.id;
		this.label = options.label ?? options.id;
		assertNonEmpty(this.label, "hub label");
		this.members = Object.freeze((options.members ?? []).map((member) => normalizeMember(member)));
		this.tags = Object.freeze({ ...options.tags });
		assertUniqueMembers(this.members);
		this.fingerprint = stableFingerprint({
			id: this.id,
			label: this.label,
			tags: this.tags,
			members: this.members,
		});
		Object.freeze(this);
	}

	withMembers(
		members: readonly McpHubMember<ConnectionId>[],
	): McpHubDefinition<HubId, ConnectionId> {
		return new McpHubDefinition({
			id: this.id,
			label: this.label,
			members,
			tags: this.tags,
		});
	}
}

export function defineHub<const HubId extends string, const ConnectionId extends string>(
	options: McpHubDefinitionOptions<HubId, ConnectionId>,
): McpHubDefinition<HubId, ConnectionId> {
	return new McpHubDefinition(options);
}

export interface McpHubMemberSnapshot<ConnectionId extends string = string> {
	readonly namespace: string;
	readonly connection: McpConnectionSnapshot<ConnectionId>;
	/**
	 * The effective filters and renames, echoed from the definition so a UI can render which of the
	 * member's items are disabled. Denied items are never listed in the hub catalog itself.
	 */
	readonly tools?: McpHubMemberFilter;
	readonly prompts?: McpHubMemberFilter;
	readonly resources?: McpHubMemberFilter;
	readonly rename?: Readonly<Record<string, string>>;
}

export interface McpHubSnapshot<
	HubId extends string = string,
	ConnectionId extends string = string,
> {
	readonly id: HubId;
	readonly label: string;
	readonly tags: Readonly<Record<string, string>>;
	readonly fingerprint: string;
	readonly members: readonly McpHubMemberSnapshot<ConnectionId>[];
}

export interface McpHubManagerSnapshot<
	HubId extends string = string,
	ConnectionId extends string = string,
> {
	readonly revision: number;
	readonly closed: boolean;
	readonly hubs: readonly McpHubSnapshot<HubId, ConnectionId>[];
	readonly connections: McpConnectionManagerSnapshot<ConnectionId>;
}

export interface McpHubToolRoute<ConnectionId extends string = string> {
	readonly route: string;
	readonly namespace: string;
	readonly connectionId: ConnectionId;
	/** The upstream tool name, which is what the member is actually called with. */
	readonly sourceName: string;
	/** The name exposed under the namespace: `rename[sourceName]` when renamed, else `sourceName`. */
	readonly exposedName: string;
	readonly generation: number;
	readonly catalogFingerprint: string;
	readonly tool: Tool;
}

export interface McpHubPromptRoute<ConnectionId extends string = string> {
	readonly route: string;
	readonly namespace: string;
	readonly connectionId: ConnectionId;
	readonly sourceName: string;
	readonly generation: number;
	readonly catalogFingerprint: string;
	readonly prompt: Prompt;
}

export interface McpHubResourceRoute<ConnectionId extends string = string> {
	readonly route: string;
	readonly namespace: string;
	readonly connectionId: ConnectionId;
	readonly sourceName: string;
	readonly sourceUri: string;
	readonly generation: number;
	readonly catalogFingerprint: string;
	readonly resource: Resource;
}

export interface McpHubResourceTemplateRoute<ConnectionId extends string = string> {
	readonly route: string;
	readonly namespace: string;
	readonly connectionId: ConnectionId;
	readonly sourceName: string;
	readonly sourceUriTemplate: string;
	readonly generation: number;
	readonly catalogFingerprint: string;
	readonly resourceTemplate: ResourceTemplateType;
}

export interface McpHubCatalogMember<ConnectionId extends string = string> {
	readonly connectionId: ConnectionId;
	readonly namespace: string;
	/**
	 * The member's catalog AS EXPOSED: items its filters deny are removed and tools carry their
	 * exposed (renamed) name, so walking it never re-exposes what a filter hides. Its identity
	 * (`generation`, `fingerprint`) and its capture metrics still describe the upstream snapshot.
	 */
	readonly catalog?: McpCatalogSnapshot;
	readonly refreshErrorCode?: string;
}

export interface McpHubCatalogSnapshot<
	HubId extends string = string,
	ConnectionId extends string = string,
> {
	readonly hubId: HubId;
	/** The definition fingerprint this catalog was projected with. */
	readonly fingerprint: string;
	readonly members: readonly McpHubCatalogMember<ConnectionId>[];
	readonly tools: readonly McpHubToolRoute<ConnectionId>[];
	readonly prompts: readonly McpHubPromptRoute<ConnectionId>[];
	readonly resources: readonly McpHubResourceRoute<ConnectionId>[];
	readonly resourceTemplates: readonly McpHubResourceTemplateRoute<ConnectionId>[];
}

export type McpHubEventType =
	| "hub.catalog.refreshed"
	| "hub.connection.changed"
	| "hub.registered"
	| "hub.removed"
	| "hub.updated";

export interface McpHubEvent<HubId extends string = string, ConnectionId extends string = string> {
	readonly revision: number;
	readonly type: McpHubEventType;
	readonly hub: McpHubSnapshot<HubId, ConnectionId>;
}

export type McpHubListener<HubId extends string = string, ConnectionId extends string = string> = (
	event: McpHubEvent<HubId, ConnectionId>,
) => MaybePromise<void>;

export class McpHubManager<
	HubId extends string = string,
	ConnectionId extends string = string,
> implements Disposable {
	readonly #connections: McpConnectionManager<ConnectionId>;
	readonly #hubs = new Map<HubId, McpHubDefinition<HubId, ConnectionId>>();
	readonly #listeners = new Set<McpHubListener<HubId, ConnectionId>>();
	readonly #unsubscribeConnections: () => void;
	#revision = 0;
	#closed = false;

	constructor(connections: McpConnectionManager<ConnectionId>) {
		this.#connections = connections;
		this.#unsubscribeConnections = connections.subscribe((event) => this.#onConnectionEvent(event));
	}

	get closed(): boolean {
		return this.#closed;
	}

	register(definition: McpHubDefinition<HubId, ConnectionId>): McpHubSnapshot<HubId, ConnectionId> {
		this.#assertOpen();
		if (this.#hubs.has(definition.id)) {
			throw new KmcpError(
				KMCP_ERROR_CODES.HUB_DUPLICATE,
				`Hub '${definition.id}' is already registered.`,
			);
		}
		this.#validateConnections(definition);
		this.#hubs.set(definition.id, definition);
		this.#publish("hub.registered", definition);
		return this.state(definition.id);
	}

	update(definition: McpHubDefinition<HubId, ConnectionId>): McpHubSnapshot<HubId, ConnectionId> {
		this.#assertOpen();
		this.#hub(definition.id);
		this.#validateConnections(definition);
		this.#hubs.set(definition.id, definition);
		this.#publish("hub.updated", definition);
		return this.state(definition.id);
	}

	remove(id: HubId): void {
		this.#assertOpen();
		const definition = this.#hub(id);
		this.#hubs.delete(id);
		this.#publish("hub.removed", definition);
	}

	async refreshCatalog(
		id: HubId,
		signal?: AbortSignal,
	): Promise<McpHubCatalogSnapshot<HubId, ConnectionId>> {
		this.#assertOpen();
		throwIfAborted(signal);
		const definition = this.#hub(id);
		const admissions = definition.members.map((member) =>
			Object.freeze({
				member,
				generation: this.#connections.state(member.connectionId).generation,
			}),
		);
		const refreshes = await Promise.allSettled(
			admissions.map(({ member, generation }) =>
				this.#connections.refreshCatalog(member.connectionId, signal, {
					expectedGeneration: generation,
				}),
			),
		);
		throwIfAborted(signal);
		this.#assertOpen();
		if (this.#hubs.get(id) !== definition) throw revisionConflict(id);
		this.#assertRefreshIdentity(id, admissions, refreshes);
		const result = this.#catalog(definition, refreshes);
		this.#publish("hub.catalog.refreshed", definition);
		return result;
	}

	catalog(id: HubId): McpHubCatalogSnapshot<HubId, ConnectionId> {
		return this.#catalog(this.#hub(id));
	}

	callTool(
		id: HubId,
		route: string,
		arguments_?: Readonly<Record<string, unknown>>,
		options?: McpCallToolOptions,
	): Promise<CallToolResult>;
	callTool(
		id: HubId,
		route: McpHubToolRoute<ConnectionId>,
		arguments_?: Readonly<Record<string, unknown>>,
		options?: McpCallToolOptions,
	): Promise<CallToolResult>;
	callTool(
		id: HubId,
		route: McpHubToolRoute<ConnectionId> | string,
		arguments_: Readonly<Record<string, unknown>> = {},
		options?: McpCallToolOptions,
	): Promise<CallToolResult> {
		this.#assertOpen();
		throwIfAborted(options?.signal);
		const resolved = this.#resolveToolCall(id, route);
		return this.#connections.callTool(
			resolved.connectionId,
			resolved.sourceName,
			arguments_,
			options,
			resolved.control,
		);
	}

	/**
	 * `callTool` with FastMCP-style ergonomics: raises `McpToolCallError` on an `isError` result
	 * (opt out with `raiseOnError: false`) and returns the parsed shape. The resolved catalog
	 * `Tool` is injected as `toolDefinition`, strengthening the SDK client's output-schema
	 * validation and header recovery.
	 */
	async callToolParsed(
		id: HubId,
		route: McpHubToolRoute<ConnectionId> | string,
		arguments_: Readonly<Record<string, unknown>> = {},
		options?: McpCallToolParsedOptions,
	): Promise<McpParsedToolResult> {
		this.#assertOpen();
		throwIfAborted(options?.signal);
		const resolved = this.#resolveToolCall(id, route);
		return this.#connections.callToolParsed(
			resolved.connectionId,
			resolved.sourceName,
			arguments_,
			{ ...options, toolDefinition: resolved.tool },
			resolved.control,
		);
	}

	#resolveToolCall(
		id: HubId,
		route: McpHubToolRoute<ConnectionId> | string,
	): {
		readonly connectionId: ConnectionId;
		readonly sourceName: string;
		readonly control: McpConnectionOperationControl;
		readonly tool: Tool;
	} {
		const routeName = typeof route === "string" ? route : route.route;
		const match = resolveRoute(this.#hub(id), routeName);
		const identity = this.#catalogIdentity(match.member.connectionId, "tools");
		// The exposed name is resolved against the same filtered, renamed, de-duplicated view the
		// catalog projects, so a denied or shadowed tool is as unknown here as a missing one.
		const exposed =
			identity === undefined
				? undefined
				: findExactlyOne(
						exposedTools(match.member, identity.catalog.tools.items),
						(candidate) => candidate.exposedName === match.name,
					);
		if (identity === undefined || exposed === undefined) throw unknownRoute(routeName);
		if (
			typeof route !== "string" &&
			(route.namespace !== match.member.namespace ||
				route.connectionId !== match.member.connectionId ||
				route.sourceName !== exposed.tool.name ||
				route.exposedName !== exposed.exposedName ||
				route.generation !== identity.catalog.generation ||
				route.catalogFingerprint !== identity.catalog.fingerprint ||
				route.tool.name !== exposed.tool.name)
		) {
			throw unknownRoute(routeName);
		}
		return {
			connectionId: match.member.connectionId,
			sourceName: exposed.tool.name,
			control: identity.control,
			tool: exposed.tool,
		};
	}

	getPrompt(
		id: HubId,
		route: string,
		arguments_: Readonly<Record<string, string>> | undefined,
		options?: McpRequestOptionsWithMeta,
	): Promise<GetPromptResult>;
	getPrompt(
		id: HubId,
		route: McpHubPromptRoute<ConnectionId>,
		arguments_: Readonly<Record<string, string>> | undefined,
		options?: McpRequestOptionsWithMeta,
	): Promise<GetPromptResult>;
	getPrompt(
		id: HubId,
		route: McpHubPromptRoute<ConnectionId> | string,
		arguments_: Readonly<Record<string, string>> | undefined,
		options?: McpRequestOptionsWithMeta,
	): Promise<GetPromptResult> {
		this.#assertOpen();
		throwIfAborted(options?.signal);
		const routeName = typeof route === "string" ? route : route.route;
		const match = resolveRoute(this.#hub(id), routeName);
		const identity = this.#catalogIdentity(match.member.connectionId, "prompts");
		const prompt = admits(match.member.prompts, match.name)
			? findExactlyOne(
					identity?.catalog.prompts.items ?? [],
					(candidate) => candidate.name === match.name,
				)
			: undefined;
		if (identity === undefined || prompt === undefined) throw unknownRoute(routeName);
		if (
			typeof route !== "string" &&
			(route.namespace !== match.member.namespace ||
				route.connectionId !== match.member.connectionId ||
				route.sourceName !== match.name ||
				route.generation !== identity.catalog.generation ||
				route.catalogFingerprint !== identity.catalog.fingerprint ||
				route.prompt.name !== prompt.name)
		) {
			throw unknownRoute(routeName);
		}
		return this.#connections.getPrompt(
			match.member.connectionId,
			match.name,
			arguments_,
			options,
			identity.control,
		);
	}

	/**
	 * Reads a resource through a namespace. The URI may be a listed static resource or an
	 * expansion of one of the member's listed resource templates (matched with the SDK
	 * `UriTemplate`); both are fenced on the member's current catalog generation.
	 */
	readResource(
		id: HubId,
		namespace: string,
		uri: string,
		options?: McpReadOptions,
	): Promise<ReadResourceResult>;
	readResource(
		id: HubId,
		route: McpHubResourceRoute<ConnectionId>,
		options?: McpReadOptions,
	): Promise<ReadResourceResult>;
	readResource(
		id: HubId,
		routeOrNamespace: McpHubResourceRoute<ConnectionId> | string,
		uriOrOptions?: McpReadOptions | string,
		options?: McpReadOptions,
	): Promise<ReadResourceResult> {
		this.#assertOpen();
		if (typeof routeOrNamespace === "string") {
			if (typeof uriOrOptions !== "string") throw new TypeError("resource URI must be a string.");
			throwIfAborted(options?.signal);
			return this.#readResource(id, routeOrNamespace, uriOrOptions, options);
		}
		if (typeof uriOrOptions === "string") throw new TypeError("options must be an object.");
		throwIfAborted(uriOrOptions?.signal);
		return this.#readResource(
			id,
			routeOrNamespace.namespace,
			routeOrNamespace.sourceUri,
			uriOrOptions,
			routeOrNamespace,
		);
	}

	#readResource(
		id: HubId,
		namespace: string,
		uri: string,
		options?: McpReadOptions,
		route?: McpHubResourceRoute<ConnectionId>,
	): Promise<ReadResourceResult> {
		const definition = this.#hub(id);
		const member = definition.members.find((candidate) => candidate.namespace === namespace);
		const routeName = `${namespace}:${uri}`;
		if (member === undefined) throw unknownRoute(routeName);
		// `deny` is matched on the REQUESTED URI, so a denied expansion can never be reached through
		// one of the member's templates however permissive the template's own pattern is.
		if (denies(member.resources, uri)) throw unknownRoute(routeName);
		const identity = this.#catalogIdentity(member.connectionId, "resources");
		if (identity === undefined) throw unknownRoute(routeName);
		const resource = findExactlyOne(
			identity.catalog.resources.items,
			(candidate) => candidate.uri === uri,
		);
		if (resource === undefined) {
			if (route !== undefined) throw unknownRoute(routeName);
			const templates = this.#catalogIdentity(member.connectionId, "resourceTemplates");
			// An admitted template stands for the whole set it expands, so allow-listing a member's
			// exact `uriTemplate` exposes its expansions; the template's literal head bounds them.
			if (
				templates === undefined ||
				templates.catalog !== identity.catalog ||
				!matchesAnyTemplate(
					templates.catalog.resourceTemplates.items.filter((item) =>
						admits(member.resources, item.uriTemplate),
					),
					uri,
				)
			) {
				throw unknownRoute(routeName);
			}
			return this.#connections.readResource(member.connectionId, uri, options, identity.control);
		}
		// A LISTED static resource is reachable only when the filter admits its own URI.
		if (!admits(member.resources, uri)) throw unknownRoute(routeName);
		if (
			route !== undefined &&
			(route.route !== routeName ||
				route.connectionId !== member.connectionId ||
				route.sourceName !== resource.name ||
				route.sourceUri !== resource.uri ||
				route.generation !== identity.catalog.generation ||
				route.catalogFingerprint !== identity.catalog.fingerprint ||
				route.resource.name !== resource.name ||
				route.resource.uri !== resource.uri)
		) {
			throw unknownRoute(routeName);
		}
		return this.#connections.readResource(member.connectionId, uri, options, identity.control);
	}

	/**
	 * `completion/complete` for a prompt argument (`ns.prompt`) or a resource-template variable
	 * (`ns:template`) of a hub member. Results are bounded by the connection manager.
	 */
	complete(
		id: HubId,
		route: McpHubPromptRoute<ConnectionId> | McpHubResourceTemplateRoute<ConnectionId> | string,
		argument: { readonly name: string; readonly value: string },
		context?: { readonly arguments?: Readonly<Record<string, string>> },
		options?: McpRequestOptionsWithMeta,
	): Promise<CompleteResult> {
		this.#assertOpen();
		throwIfAborted(options?.signal);
		const definition = this.#hub(id);
		const routeName = typeof route === "string" ? route : route.route;
		const target = resolveCompletionRoute(definition, routeName);
		const identity = this.#catalogIdentity(
			target.member.connectionId,
			target.kind === "prompt" ? "prompts" : "resourceTemplates",
		);
		if (identity === undefined) throw unknownRoute(routeName);
		if (
			!admits(
				target.kind === "prompt" ? target.member.prompts : target.member.resources,
				target.source,
			)
		) {
			throw unknownRoute(routeName);
		}
		if (
			typeof route !== "string" &&
			(route.connectionId !== target.member.connectionId ||
				route.generation !== identity.catalog.generation ||
				route.catalogFingerprint !== identity.catalog.fingerprint)
		) {
			throw unknownRoute(routeName);
		}
		const ref =
			target.kind === "prompt"
				? findExactlyOne(
						identity.catalog.prompts.items,
						(candidate) => candidate.name === target.source,
					) === undefined
					? undefined
					: ({ type: "ref/prompt", name: target.source } as const)
				: findExactlyOne(
							identity.catalog.resourceTemplates.items,
							(candidate) => candidate.uriTemplate === target.source,
					  ) === undefined
					? undefined
					: ({ type: "ref/resource", uri: target.source } as const);
		if (ref === undefined) throw unknownRoute(routeName);
		return this.#connections.complete(
			target.member.connectionId,
			{
				ref,
				argument: { name: argument.name, value: argument.value },
				...(context?.arguments === undefined
					? {}
					: { context: { arguments: { ...context.arguments } } }),
			},
			options,
			identity.control,
		);
	}

	state(id: HubId): McpHubSnapshot<HubId, ConnectionId> {
		return this.#snapshotHub(this.#hub(id));
	}

	snapshot(): McpHubManagerSnapshot<HubId, ConnectionId> {
		return Object.freeze({
			revision: this.#revision,
			closed: this.#closed,
			hubs: Object.freeze(
				[...this.#hubs.values()]
					.sort((left, right) => left.id.localeCompare(right.id))
					.map((hub) => this.#snapshotHub(hub)),
			),
			connections: this.#connections.snapshot(),
		});
	}

	subscribe(listener: McpHubListener<HubId, ConnectionId>): () => void {
		this.#assertOpen();
		if (typeof listener !== "function") throw new TypeError("listener must be a function.");
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.#unsubscribeConnections();
		} finally {
			this.#listeners.clear();
		}
	}

	[Symbol.dispose](): void {
		this.close();
	}

	#catalog(
		definition: McpHubDefinition<HubId, ConnectionId>,
		refreshes?: readonly PromiseSettledResult<McpCatalogSnapshot>[],
	): McpHubCatalogSnapshot<HubId, ConnectionId> {
		const connections = definition.members.map((member) =>
			this.#connections.state(member.connectionId),
		);
		const members = definition.members.map((member, index) => {
			const connection = connections[index];
			if (connection === undefined) throw revisionConflict(definition.id);
			const refresh = refreshes?.[index];
			return Object.freeze({
				connectionId: member.connectionId,
				namespace: member.namespace,
				...(connection.catalog === undefined
					? {}
					: { catalog: exposedCatalog(member, connection.catalog) }),
				...(refresh?.status === "rejected" ? { refreshErrorCode: errorCode(refresh.reason) } : {}),
			});
		});
		const tools: McpHubToolRoute<ConnectionId>[] = [];
		const prompts: McpHubPromptRoute<ConnectionId>[] = [];
		const resources: McpHubResourceRoute<ConnectionId>[] = [];
		const resourceTemplates: McpHubResourceTemplateRoute<ConnectionId>[] = [];
		for (const [index, member] of members.entries()) {
			const connection = connections[index];
			const filters = definition.members[index];
			// Routes are projected from the UPSTREAM catalog: `member.catalog` already carries the
			// exposed view, and filtering or renaming it a second time would resolve the wrong items.
			const catalog = connection?.catalog;
			if (
				connection === undefined ||
				filters === undefined ||
				catalog === undefined ||
				catalog.generation !== connection.generation ||
				!isRoutablePhase(connection.phase)
			) {
				continue;
			}
			if (catalog.tools.status === "fresh" && catalog.tools.fingerprint !== undefined) {
				for (const exposed of exposedTools(filters, catalog.tools.items)) {
					tools.push(
						Object.freeze({
							route: `${member.namespace}.${exposed.exposedName}`,
							namespace: member.namespace,
							connectionId: member.connectionId,
							sourceName: exposed.tool.name,
							exposedName: exposed.exposedName,
							generation: catalog.generation,
							catalogFingerprint: catalog.fingerprint,
							tool: immutableClone(exposed.tool),
						}),
					);
				}
			}
			if (catalog.prompts.status === "fresh" && catalog.prompts.fingerprint !== undefined) {
				for (const prompt of uniquelyNamed(catalog.prompts.items)) {
					if (!admits(filters.prompts, prompt.name)) continue;
					prompts.push(
						Object.freeze({
							route: `${member.namespace}.${prompt.name}`,
							namespace: member.namespace,
							connectionId: member.connectionId,
							sourceName: prompt.name,
							generation: catalog.generation,
							catalogFingerprint: catalog.fingerprint,
							prompt: immutableClone(prompt),
						}),
					);
				}
			}
			if (catalog.resources.status === "fresh" && catalog.resources.fingerprint !== undefined) {
				for (const resource of uniquelyIdentified(catalog.resources.items, (item) => item.uri)) {
					if (!admits(filters.resources, resource.uri)) continue;
					resources.push(
						Object.freeze({
							route: `${member.namespace}:${resource.uri}`,
							namespace: member.namespace,
							connectionId: member.connectionId,
							sourceName: resource.name,
							sourceUri: resource.uri,
							generation: catalog.generation,
							catalogFingerprint: catalog.fingerprint,
							resource: immutableClone(resource),
						}),
					);
				}
			}
			if (
				catalog.resourceTemplates.status === "fresh" &&
				catalog.resourceTemplates.fingerprint !== undefined
			) {
				for (const resourceTemplate of uniquelyIdentified(
					catalog.resourceTemplates.items,
					(item) => item.uriTemplate,
				)) {
					if (!admits(filters.resources, resourceTemplate.uriTemplate)) continue;
					resourceTemplates.push(
						Object.freeze({
							route: `${member.namespace}:${resourceTemplate.uriTemplate}`,
							namespace: member.namespace,
							connectionId: member.connectionId,
							sourceName: resourceTemplate.name,
							sourceUriTemplate: resourceTemplate.uriTemplate,
							generation: catalog.generation,
							catalogFingerprint: catalog.fingerprint,
							resourceTemplate: immutableClone(resourceTemplate),
						}),
					);
				}
			}
		}
		return Object.freeze({
			hubId: definition.id,
			fingerprint: definition.fingerprint,
			members: Object.freeze(members),
			tools: Object.freeze(tools),
			prompts: Object.freeze(prompts),
			resources: Object.freeze(resources),
			resourceTemplates: Object.freeze(resourceTemplates),
		});
	}

	#snapshotHub(
		definition: McpHubDefinition<HubId, ConnectionId>,
	): McpHubSnapshot<HubId, ConnectionId> {
		return Object.freeze({
			id: definition.id,
			label: definition.label,
			tags: definition.tags,
			fingerprint: definition.fingerprint,
			members: Object.freeze(
				definition.members.map((member) =>
					Object.freeze({
						namespace: member.namespace,
						connection: this.#connections.state(member.connectionId),
						...(member.tools === undefined ? {} : { tools: member.tools }),
						...(member.prompts === undefined ? {} : { prompts: member.prompts }),
						...(member.resources === undefined ? {} : { resources: member.resources }),
						...(member.rename === undefined ? {} : { rename: member.rename }),
					}),
				),
			),
		});
	}

	#onConnectionEvent(event: McpConnectionEvent<ConnectionId>): void {
		// Diagnostics never change a member's phase or catalog, so they are not a topology change.
		if (this.#closed || event.type === "connection.error") return;
		for (const hub of this.#hubs.values()) {
			if (hub.members.some((member) => member.connectionId === event.connection.id)) {
				if (event.type === "connection.removed") {
					const updated = hub.withMembers(
						hub.members.filter((member) => member.connectionId !== event.connection.id),
					);
					this.#hubs.set(hub.id, updated);
					this.#publish("hub.updated", updated);
				} else {
					this.#publish("hub.connection.changed", hub);
				}
			}
		}
	}

	#publish(type: McpHubEventType, definition: McpHubDefinition<HubId, ConnectionId>): void {
		if (this.#closed) return;
		this.#revision += 1;
		const event = Object.freeze({
			revision: this.#revision,
			type,
			hub: this.#snapshotHub(definition),
		});
		for (const listener of this.#listeners) {
			try {
				void Promise.resolve(listener(event)).catch(() => undefined);
			} catch {
				// Hub event listeners cannot alter hub lifecycle.
			}
		}
	}

	#validateConnections(definition: McpHubDefinition<HubId, ConnectionId>): void {
		for (const member of definition.members) this.#connections.state(member.connectionId);
	}

	#catalogIdentity(
		connectionId: ConnectionId,
		section: "prompts" | "resourceTemplates" | "resources" | "tools",
	):
		| {
				readonly catalog: McpCatalogSnapshot;
				readonly control: McpConnectionOperationControl;
		  }
		| undefined {
		const connection = this.#connections.state(connectionId);
		const catalog = connection.catalog;
		if (
			catalog === undefined ||
			catalog.generation !== connection.generation ||
			!isRoutablePhase(connection.phase) ||
			catalog[section].status !== "fresh" ||
			catalog[section].fingerprint === undefined
		) {
			return undefined;
		}
		return Object.freeze({
			catalog,
			control: Object.freeze({
				expectedGeneration: connection.generation,
				expectedCatalogFingerprint: catalog.fingerprint,
			}),
		});
	}

	#assertRefreshIdentity(
		id: HubId,
		admissions: readonly {
			readonly member: McpHubMember<ConnectionId>;
			readonly generation: number;
		}[],
		refreshes: readonly PromiseSettledResult<McpCatalogSnapshot>[],
	): void {
		for (const [index, admission] of admissions.entries()) {
			const connection = this.#connections.state(admission.member.connectionId);
			if (connection.generation !== admission.generation) throw revisionConflict(id);
			const refresh = refreshes[index];
			if (refresh?.status !== "fulfilled") continue;
			if (
				connection.catalog === undefined ||
				connection.catalog.generation !== refresh.value.generation ||
				connection.catalog.fingerprint !== refresh.value.fingerprint
			) {
				throw revisionConflict(id);
			}
		}
	}

	#hub(id: HubId): McpHubDefinition<HubId, ConnectionId> {
		const hub = this.#hubs.get(id);
		if (hub === undefined) {
			throw new KmcpError(KMCP_ERROR_CODES.HUB_UNKNOWN, `Unknown hub '${id}'.`);
		}
		return hub;
	}

	#assertOpen(): void {
		if (this.#closed) {
			throw new KmcpError(KMCP_ERROR_CODES.MANAGER_CLOSED, "Hub manager is closed.");
		}
	}
}

function resolveRoute<HubId extends string, ConnectionId extends string>(
	hub: McpHubDefinition<HubId, ConnectionId>,
	route: string,
): {
	readonly member: McpHubMember<ConnectionId>;
	/** The name as EXPOSED under the namespace (renamed, for tools). */
	readonly name: string;
} {
	for (const member of hub.members) {
		const prefix = `${member.namespace}.`;
		if (route.startsWith(prefix) && route.length > prefix.length) {
			return Object.freeze({ member, name: route.slice(prefix.length) });
		}
	}
	throw unknownRoute(route);
}

function resolveCompletionRoute<HubId extends string, ConnectionId extends string>(
	hub: McpHubDefinition<HubId, ConnectionId>,
	route: string,
): {
	readonly kind: "prompt" | "resourceTemplate";
	readonly member: McpHubMember<ConnectionId>;
	readonly source: string;
} {
	for (const member of hub.members) {
		const promptPrefix = `${member.namespace}.`;
		const templatePrefix = `${member.namespace}:`;
		if (route.startsWith(templatePrefix) && route.length > templatePrefix.length) {
			return Object.freeze({
				kind: "resourceTemplate",
				member,
				source: route.slice(templatePrefix.length),
			});
		}
		if (route.startsWith(promptPrefix) && route.length > promptPrefix.length) {
			return Object.freeze({
				kind: "prompt",
				member,
				source: route.slice(promptPrefix.length),
			});
		}
	}
	throw unknownRoute(route);
}

interface McpHubExposedTool {
	readonly tool: Tool;
	readonly exposedName: string;
}

/**
 * The member's tools as they are exposed: filtered on the upstream name, renamed, then narrowed to
 * the names that identify exactly one tool (an ambiguous name is dropped, as duplicate upstream
 * names already are).
 */
function exposedTools<ConnectionId extends string>(
	member: McpHubMember<ConnectionId>,
	items: readonly Tool[],
): McpHubExposedTool[] {
	const exposed: McpHubExposedTool[] = [];
	for (const tool of uniquelyNamed(items)) {
		if (!admits(member.tools, tool.name)) continue;
		exposed.push(Object.freeze({ tool, exposedName: renamed(member.rename, tool.name) }));
	}
	return uniquelyIdentified(exposed, (entry) => entry.exposedName);
}

/**
 * A member's catalog as the hub EXPOSES it: denied items removed, tools carrying their exposed name
 * and narrowed to the ones `exposedTools` routes. `generation`, `fingerprint` and the capture
 * metrics are left as captured: they identify and size the UPSTREAM snapshot, not this view.
 */
function exposedCatalog<ConnectionId extends string>(
	member: McpHubMember<ConnectionId>,
	catalog: McpCatalogSnapshot,
): McpCatalogSnapshot {
	if (
		member.tools === undefined &&
		member.prompts === undefined &&
		member.resources === undefined &&
		member.rename === undefined
	) {
		return catalog;
	}
	return Object.freeze({
		...catalog,
		tools: exposedSection(
			catalog.tools,
			exposedTools(member, catalog.tools.items).map((entry) =>
				entry.exposedName === entry.tool.name
					? entry.tool
					: Object.freeze({ ...entry.tool, name: entry.exposedName }),
			),
		),
		prompts: exposedSection(
			catalog.prompts,
			catalog.prompts.items.filter((item) => admits(member.prompts, item.name)),
		),
		resources: exposedSection(
			catalog.resources,
			catalog.resources.items.filter((item) => admits(member.resources, item.uri)),
		),
		resourceTemplates: exposedSection(
			catalog.resourceTemplates,
			catalog.resourceTemplates.items.filter((item) => admits(member.resources, item.uriTemplate)),
		),
	});
}

function exposedSection<Item>(
	section: McpCatalogSection<Item>,
	items: readonly Item[],
): McpCatalogSection<Item> {
	return Object.freeze({ ...section, items: Object.freeze(items) });
}

function renamed(rename: Readonly<Record<string, string>> | undefined, name: string): string {
	if (rename === undefined || !Object.hasOwn(rename, name)) return name;
	return rename[name] ?? name;
}

/** Whether a filter exposes an upstream identity. `deny` wins; an absent filter exposes everything. */
function admits(filter: McpHubMemberFilter | undefined, value: string): boolean {
	if (filter === undefined) return true;
	if (denies(filter, value)) return false;
	if (filter.allow === undefined) return true;
	return filter.allow.some((pattern) => matchesPattern(pattern, value));
}

/** Whether a filter refuses an identity outright, whatever its `allow` list says. */
function denies(filter: McpHubMemberFilter | undefined, value: string): boolean {
	return filter?.deny?.some((pattern) => matchesPattern(pattern, value)) === true;
}

function matchesPattern(pattern: string, value: string): boolean {
	if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
	return value === pattern;
}

function normalizeMember<ConnectionId extends string>(
	member: McpHubMember<ConnectionId>,
): McpHubMember<ConnectionId> {
	assertNamespace(member.namespace);
	const label = `hub member '${member.namespace}'`;
	const tools = normalizeFilter(member.tools, `${label} tools filter`);
	const prompts = normalizeFilter(member.prompts, `${label} prompts filter`);
	const resources = normalizeFilter(member.resources, `${label} resources filter`);
	const rename = normalizeRename(member.rename, `${label} rename`);
	return Object.freeze({
		connectionId: member.connectionId,
		namespace: member.namespace,
		...(tools === undefined ? {} : { tools }),
		...(prompts === undefined ? {} : { prompts }),
		...(resources === undefined ? {} : { resources }),
		...(rename === undefined ? {} : { rename }),
	});
}

function normalizeFilter(
	filter: McpHubMemberFilter | undefined,
	label: string,
): McpHubMemberFilter | undefined {
	if (filter === undefined) return undefined;
	// `allow: []` is a present allow list that exposes nothing, so it is never collapsed away; an
	// empty `deny` denies nothing, so it collapses exactly like an absent one.
	const allow = normalizePatterns(filter.allow, `${label} allow`);
	const denied = normalizePatterns(filter.deny, `${label} deny`);
	const deny = denied === undefined || denied.length === 0 ? undefined : denied;
	if (allow === undefined && deny === undefined) return undefined;
	return Object.freeze({
		...(allow === undefined ? {} : { allow }),
		...(deny === undefined ? {} : { deny }),
	});
}

function normalizePatterns(
	patterns: readonly string[] | undefined,
	label: string,
): readonly string[] | undefined {
	if (patterns === undefined) return undefined;
	const unique = new Set<string>();
	for (const pattern of patterns) {
		if (typeof pattern !== "string" || pattern.trim().length === 0) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				`${label} must not contain an empty pattern.`,
			);
		}
		const star = pattern.indexOf("*");
		if (star !== -1 && star !== pattern.length - 1) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				`${label} pattern '${pattern}' may only use '*' as its last character.`,
			);
		}
		unique.add(pattern);
	}
	// Sorted and de-duplicated, so two definitions listing the same patterns share one fingerprint.
	return Object.freeze([...unique].sort());
}

function normalizeRename(
	rename: Readonly<Record<string, string>> | undefined,
	label: string,
): Readonly<Record<string, string>> | undefined {
	if (rename === undefined) return undefined;
	const entries = Object.entries(rename);
	if (entries.length === 0) return undefined;
	const targets = new Set<string>();
	for (const [source, target] of entries) {
		// The target carries the rule a projected name must satisfy downstream: one the gateway
		// would drop is refused here instead of routing on the hub and vanishing at the seam. The
		// source only has to name an upstream tool exactly: renaming is how an upstream name the
		// gateway could never project is rescued.
		if (source.length === 0 || source !== source.trim()) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				`${label} source '${source}' must be a non-empty, unpadded upstream tool name.`,
			);
		}
		assertExposedName(target, `${label} target for '${source}'`);
		if (source === target) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				`${label} maps '${source}' to itself.`,
			);
		}
		if (targets.has(target)) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				`${label} maps more than one tool to '${target}'.`,
			);
		}
		targets.add(target);
	}
	// `fromEntries` keeps `__proto__` an own property; reads go through `Object.hasOwn`.
	return Object.freeze(Object.fromEntries(entries));
}

function assertExposedName(value: string, label: string): void {
	if (typeof value !== "string" || !EXPOSED_NAME_REGEX.test(value)) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`${label} '${String(value)}' must match ${EXPOSED_NAME_REGEX.source}.`,
		);
	}
}

function matchesAnyTemplate(templates: readonly ResourceTemplateType[], uri: string): boolean {
	for (const template of uniquelyIdentified(templates, (item) => item.uriTemplate)) {
		try {
			if (new UriTemplate(template.uriTemplate).match(uri) !== null) return true;
		} catch {
			// An unparsable upstream template never matches.
		}
	}
	return false;
}

function findExactlyOne<Item>(
	items: readonly Item[],
	predicate: (item: Item) => boolean,
): Item | undefined {
	let found: Item | undefined;
	for (const item of items) {
		if (!predicate(item)) continue;
		if (found !== undefined) return undefined;
		found = item;
	}
	return found;
}

function uniquelyNamed<Item extends { readonly name: string }>(items: readonly Item[]): Item[] {
	return uniquelyIdentified(items, (item) => item.name);
}

function uniquelyIdentified<Item>(
	items: readonly Item[],
	identity: (item: Item) => string,
): Item[] {
	const counts = new Map<string, number>();
	for (const item of items) {
		const key = identity(item);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return items.filter((item) => counts.get(identity(item)) === 1);
}

function isRoutablePhase(phase: McpConnectionSnapshot["phase"]): boolean {
	return phase === "online" || phase === "degraded";
}

function throwIfAborted(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}

function revisionConflict(id: string): KmcpError {
	return new KmcpError(
		KMCP_ERROR_CODES.HUB_REVISION_CONFLICT,
		`Hub '${id}' changed while its catalog refresh was in flight.`,
	);
}

function unknownRoute(route: string): KmcpError {
	return new KmcpError(KMCP_ERROR_CODES.HUB_ROUTE_UNKNOWN, `Unknown hub route '${route}'.`);
}

function assertNamespace(namespace: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(namespace)) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`Invalid hub namespace '${namespace}'.`,
		);
	}
}

function assertUniqueMembers<ConnectionId extends string>(
	members: readonly McpHubMember<ConnectionId>[],
): void {
	const namespaces = new Set<string>();
	const connections = new Set<ConnectionId>();
	for (const member of members) {
		if (namespaces.has(member.namespace)) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				`Duplicate hub namespace '${member.namespace}'.`,
			);
		}
		if (connections.has(member.connectionId)) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				`Connection '${member.connectionId}' is attached more than once.`,
			);
		}
		namespaces.add(member.namespace);
		connections.add(member.connectionId);
	}
}
