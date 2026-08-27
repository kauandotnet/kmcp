import type {
	CallToolRequestOptions,
	CallToolResult,
	GetPromptResult,
	Prompt,
	ReadResourceResult,
	Resource,
	ResourceTemplateType,
	Tool,
} from "@modelcontextprotocol/client";

import { KMCP_ERROR_CODES, KmcpError, errorCode } from "../errors.ts";
import { assertNonEmpty, immutableClone, type MaybePromise } from "../internal/value.ts";
import type { McpCatalogSnapshot } from "../client/catalog.ts";
import type {
	McpConnectionEvent,
	McpConnectionManagerSnapshot,
	McpConnectionOperationControl,
	McpConnectionSnapshot,
} from "../client/manager.ts";
import { McpConnectionManager } from "../client/manager.ts";

export interface McpHubMember<ConnectionId extends string = string> {
	readonly connectionId: ConnectionId;
	readonly namespace: string;
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

	constructor(options: McpHubDefinitionOptions<HubId, ConnectionId>) {
		assertNonEmpty(options.id, "hub id");
		this.id = options.id;
		this.label = options.label ?? options.id;
		assertNonEmpty(this.label, "hub label");
		this.members = Object.freeze(
			(options.members ?? []).map((member) => {
				assertNamespace(member.namespace);
				return Object.freeze({ ...member });
			}),
		);
		this.tags = Object.freeze({ ...options.tags });
		assertUniqueMembers(this.members);
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
}

export interface McpHubSnapshot<
	HubId extends string = string,
	ConnectionId extends string = string,
> {
	readonly id: HubId;
	readonly label: string;
	readonly tags: Readonly<Record<string, string>>;
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
	readonly sourceName: string;
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
	readonly catalog?: McpCatalogSnapshot;
	readonly refreshErrorCode?: string;
}

export interface McpHubCatalogSnapshot<
	HubId extends string = string,
	ConnectionId extends string = string,
> {
	readonly hubId: HubId;
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
		options?: CallToolRequestOptions,
	): Promise<CallToolResult>;
	callTool(
		id: HubId,
		route: McpHubToolRoute<ConnectionId>,
		arguments_?: Readonly<Record<string, unknown>>,
		options?: CallToolRequestOptions,
	): Promise<CallToolResult>;
	callTool(
		id: HubId,
		route: McpHubToolRoute<ConnectionId> | string,
		arguments_: Readonly<Record<string, unknown>> = {},
		options?: CallToolRequestOptions,
	): Promise<CallToolResult> {
		this.#assertOpen();
		throwIfAborted(options?.signal);
		const routeName = typeof route === "string" ? route : route.route;
		const match = resolveRoute(this.#hub(id), routeName);
		const identity = this.#catalogIdentity(match.connectionId, "tools");
		const tool = findExactlyOne(
			identity?.catalog.tools.items ?? [],
			(candidate) => candidate.name === match.sourceName,
		);
		if (identity === undefined || tool === undefined) throw unknownRoute(routeName);
		if (
			typeof route !== "string" &&
			(route.namespace !== match.namespace ||
				route.connectionId !== match.connectionId ||
				route.sourceName !== match.sourceName ||
				route.generation !== identity.catalog.generation ||
				route.catalogFingerprint !== identity.catalog.fingerprint ||
				route.tool.name !== tool.name)
		) {
			throw unknownRoute(routeName);
		}
		return this.#connections.callTool(
			match.connectionId,
			match.sourceName,
			arguments_,
			options,
			identity.control,
		);
	}

	getPrompt(
		id: HubId,
		route: string,
		arguments_: Readonly<Record<string, string>> | undefined,
		signal?: AbortSignal,
	): Promise<GetPromptResult>;
	getPrompt(
		id: HubId,
		route: McpHubPromptRoute<ConnectionId>,
		arguments_: Readonly<Record<string, string>> | undefined,
		signal?: AbortSignal,
	): Promise<GetPromptResult>;
	getPrompt(
		id: HubId,
		route: McpHubPromptRoute<ConnectionId> | string,
		arguments_: Readonly<Record<string, string>> | undefined,
		signal?: AbortSignal,
	): Promise<GetPromptResult> {
		this.#assertOpen();
		throwIfAborted(signal);
		const routeName = typeof route === "string" ? route : route.route;
		const match = resolveRoute(this.#hub(id), routeName);
		const identity = this.#catalogIdentity(match.connectionId, "prompts");
		const prompt = findExactlyOne(
			identity?.catalog.prompts.items ?? [],
			(candidate) => candidate.name === match.sourceName,
		);
		if (identity === undefined || prompt === undefined) throw unknownRoute(routeName);
		if (
			typeof route !== "string" &&
			(route.namespace !== match.namespace ||
				route.connectionId !== match.connectionId ||
				route.sourceName !== match.sourceName ||
				route.generation !== identity.catalog.generation ||
				route.catalogFingerprint !== identity.catalog.fingerprint ||
				route.prompt.name !== prompt.name)
		) {
			throw unknownRoute(routeName);
		}
		return this.#connections.getPrompt(
			match.connectionId,
			match.sourceName,
			arguments_,
			signal,
			identity.control,
		);
	}

	readResource(
		id: HubId,
		namespace: string,
		uri: string,
		signal?: AbortSignal,
	): Promise<ReadResourceResult>;
	readResource(
		id: HubId,
		route: McpHubResourceRoute<ConnectionId>,
		signal?: AbortSignal,
	): Promise<ReadResourceResult>;
	readResource(
		id: HubId,
		routeOrNamespace: McpHubResourceRoute<ConnectionId> | string,
		uriOrSignal?: AbortSignal | string,
		signal?: AbortSignal,
	): Promise<ReadResourceResult> {
		this.#assertOpen();
		if (typeof routeOrNamespace === "string") {
			if (typeof uriOrSignal !== "string") throw new TypeError("resource URI must be a string.");
			throwIfAborted(signal);
			return this.#readResource(id, routeOrNamespace, uriOrSignal, signal);
		}
		if (typeof uriOrSignal === "string") throw new TypeError("signal must be an AbortSignal.");
		throwIfAborted(uriOrSignal);
		return this.#readResource(
			id,
			routeOrNamespace.namespace,
			routeOrNamespace.sourceUri,
			uriOrSignal,
			routeOrNamespace,
		);
	}

	#readResource(
		id: HubId,
		namespace: string,
		uri: string,
		signal?: AbortSignal,
		route?: McpHubResourceRoute<ConnectionId>,
	): Promise<ReadResourceResult> {
		const definition = this.#hub(id);
		const member = definition.members.find((candidate) => candidate.namespace === namespace);
		if (member === undefined) throw unknownRoute(`${namespace}:${uri}`);
		const identity = this.#catalogIdentity(member.connectionId, "resources");
		const resource = findExactlyOne(
			identity?.catalog.resources.items ?? [],
			(candidate) => candidate.uri === uri,
		);
		const routeName = `${namespace}:${uri}`;
		if (identity === undefined || resource === undefined) throw unknownRoute(routeName);
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
		return this.#connections.readResource(member.connectionId, uri, signal, identity.control);
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
				...(connection.catalog === undefined ? {} : { catalog: connection.catalog }),
				...(refresh?.status === "rejected" ? { refreshErrorCode: errorCode(refresh.reason) } : {}),
			});
		});
		const tools: McpHubToolRoute<ConnectionId>[] = [];
		const prompts: McpHubPromptRoute<ConnectionId>[] = [];
		const resources: McpHubResourceRoute<ConnectionId>[] = [];
		const resourceTemplates: McpHubResourceTemplateRoute<ConnectionId>[] = [];
		for (const [index, member] of members.entries()) {
			const connection = connections[index];
			const catalog = member.catalog;
			if (
				connection === undefined ||
				catalog === undefined ||
				catalog.generation !== connection.generation ||
				!isRoutablePhase(connection.phase)
			) {
				continue;
			}
			if (catalog.tools.status === "fresh" && catalog.tools.fingerprint !== undefined) {
				for (const tool of uniquelyNamed(catalog.tools.items)) {
					tools.push(
						Object.freeze({
							route: `${member.namespace}.${tool.name}`,
							namespace: member.namespace,
							connectionId: member.connectionId,
							sourceName: tool.name,
							generation: catalog.generation,
							catalogFingerprint: catalog.fingerprint,
							tool: immutableClone(tool),
						}),
					);
				}
			}
			if (catalog.prompts.status === "fresh" && catalog.prompts.fingerprint !== undefined) {
				for (const prompt of uniquelyNamed(catalog.prompts.items)) {
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
			members: Object.freeze(
				definition.members.map((member) =>
					Object.freeze({
						namespace: member.namespace,
						connection: this.#connections.state(member.connectionId),
					}),
				),
			),
		});
	}

	#onConnectionEvent(event: McpConnectionEvent<ConnectionId>): void {
		if (this.#closed) return;
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
		section: "prompts" | "resources" | "tools",
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
	readonly namespace: string;
	readonly connectionId: ConnectionId;
	readonly sourceName: string;
} {
	for (const member of hub.members) {
		const prefix = `${member.namespace}.`;
		if (route.startsWith(prefix) && route.length > prefix.length) {
			return Object.freeze({
				namespace: member.namespace,
				connectionId: member.connectionId,
				sourceName: route.slice(prefix.length),
			});
		}
	}
	throw unknownRoute(route);
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
