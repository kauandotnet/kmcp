import type {
	CallToolRequestOptions,
	CallToolResult,
	Client,
	GetPromptResult,
	ProtocolEra,
	ReadResourceResult,
	ServerCapabilities,
	Transport,
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
import type { McpCatalogSection, McpCatalogSnapshot } from "./catalog.ts";
import { McpClientSession, McpConnectionDefinition, createOfficialClient } from "./connection.ts";

export type McpConnectionPhase =
	"connecting" | "degraded" | "draining" | "failed" | "offline" | "online" | "quarantined";

export interface McpConnectionSnapshot<Id extends string = string> {
	readonly id: Id;
	readonly label: string;
	readonly tags: Readonly<Record<string, string>>;
	readonly phase: McpConnectionPhase;
	readonly generation: number;
	readonly lastTransitionAt: string;
	readonly connectedAt?: string;
	readonly protocolVersion?: string;
	readonly protocolEra?: ProtocolEra;
	readonly serverInfo?: Readonly<{ name: string; version: string }>;
	readonly capabilities?: ServerCapabilities;
	readonly errorCode?: string;
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
	| "connection.registered"
	| "connection.removed"
	| "connection.state.changed";

export interface McpConnectionEvent<Id extends string = string> {
	readonly revision: number;
	readonly type: McpConnectionEventType;
	readonly occurredAt: string;
	readonly connection: McpConnectionSnapshot<Id>;
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
	readonly now?: () => number;
	readonly onListenerError?: (error: unknown, event: McpConnectionEvent) => MaybePromise<void>;
}

/** Optional stale-work fences for an operation admitted to an already-online connection. */
export interface McpConnectionOperationControl {
	readonly expectedGeneration?: number;
	readonly expectedCatalogFingerprint?: string;
}

interface ManagedConnection<Id extends string> {
	readonly definition: McpConnectionDefinition<Id>;
	phase: McpConnectionPhase;
	generation: number;
	activeOperations: number;
	lastTransitionAt: string;
	connectedAt?: string;
	errorCode?: string;
	catalog?: McpCatalogSnapshot;
	catalogRevision: number;
	session?: McpClientSession<Id>;
	connectTask?: Promise<McpConnectionSnapshot<Id>>;
	disconnectTask?: Promise<McpConnectionSnapshot<Id>>;
	removeTask?: Promise<void>;
	quarantinedCleanup?: () => Promise<void>;
	readonly drainWaiters: Set<() => void>;
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

export class McpConnectionManager<Id extends string = string> implements AsyncDisposable {
	readonly #entries = new Map<Id, ManagedConnection<Id>>();
	readonly #listeners = new Set<McpConnectionListener<Id>>();
	readonly #maxConnections: number;
	readonly #catalogBounds: McpCatalogBounds;
	readonly #now: () => number;
	readonly #onListenerError:
		((error: unknown, event: McpConnectionEvent<Id>) => MaybePromise<void>) | undefined;
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
		this.#now = safeClock(options.now ?? Date.now);
		this.#onListenerError = options.onListenerError;
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
			catalogRevision: 0,
			lastTransitionAt: isoTimestamp(this.#now),
			drainWaiters: new Set(),
		};
		this.#entries.set(definition.id, entry);
		this.#publish("connection.registered", entry);
		return this.#snapshotEntry(entry);
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
			return await operation(session.client, session);
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
		options?: CallToolRequestOptions,
		control?: McpConnectionOperationControl,
	): Promise<CallToolResult> {
		return this.withClient(
			id,
			(client) => client.callTool({ name, arguments: { ...arguments_ } }, options),
			options?.signal,
			control,
		);
	}

	readResource(
		id: Id,
		uri: string,
		signal?: AbortSignal,
		control?: McpConnectionOperationControl,
	): Promise<ReadResourceResult> {
		return this.withClient(
			id,
			(client) =>
				client.readResource(
					{ uri },
					{ ...(signal === undefined ? {} : { signal }), cacheMode: "use" },
				),
			signal,
			control,
		);
	}

	getPrompt(
		id: Id,
		name: string,
		arguments_: Readonly<Record<string, string>> | undefined,
		signal?: AbortSignal,
		control?: McpConnectionOperationControl,
	): Promise<GetPromptResult> {
		return this.withClient(
			id,
			(client) =>
				client.getPrompt(
					{ name, ...(arguments_ === undefined ? {} : { arguments: { ...arguments_ } }) },
					signal === undefined ? undefined : { signal },
				),
			signal,
			control,
		);
	}

	async refreshCatalog(
		id: Id,
		signal?: AbortSignal,
		control?: McpConnectionOperationControl,
	): Promise<McpCatalogSnapshot> {
		const entry = this.#entry(id);
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
					const capabilities = client.getServerCapabilities();
					const previous = entry.catalog?.generation === generation ? entry.catalog : undefined;
					const discoveries = await Promise.allSettled([
						discoverSection(
							capabilities?.tools !== undefined,
							() =>
								client
									.listTools(undefined, {
										...(signal === undefined ? {} : { signal }),
										cacheMode: "refresh",
									})
									.then((v) => v.tools),
							previous?.tools,
							this.#catalogBounds,
							signal,
						),
						discoverSection(
							capabilities?.resources !== undefined,
							() =>
								client
									.listResources(undefined, {
										...(signal === undefined ? {} : { signal }),
										cacheMode: "refresh",
									})
									.then((v) => v.resources),
							previous?.resources,
							this.#catalogBounds,
							signal,
						),
						discoverSection(
							capabilities?.resources !== undefined,
							() =>
								client
									.listResourceTemplates(undefined, {
										...(signal === undefined ? {} : { signal }),
										cacheMode: "refresh",
									})
									.then((v) => v.resourceTemplates),
							previous?.resourceTemplates,
							this.#catalogBounds,
							signal,
						),
						discoverSection(
							capabilities?.prompts !== undefined,
							() =>
								client
									.listPrompts(undefined, {
										...(signal === undefined ? {} : { signal }),
										cacheMode: "refresh",
									})
									.then((v) => v.prompts),
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

	async #performConnect(entry: ManagedConnection<Id>): Promise<McpConnectionSnapshot<Id>> {
		if (entry.activeOperations > 0) await this.#waitUntilDrained(entry);
		this.#transition(entry, "connecting");
		let transport: Transport | undefined;
		let session: McpClientSession<Id> | undefined;
		try {
			transport = await entry.definition.openTransport();
			const client = createOfficialClient(entry.definition);
			session = new McpClientSession(entry.definition.id, client);
			client.onclose = () => {
				if (entry.session === session && entry.phase !== "draining" && entry.phase !== "offline") {
					delete entry.session;
					delete entry.connectedAt;
					entry.errorCode = KMCP_ERROR_CODES.CONNECTION_NOT_ONLINE;
					this.#transition(entry, "failed");
				}
			};
			await client.connect(transport, entry.definition.connectOptions);
			const generation = nextGeneration(this.#generationSequence);
			this.#generationSequence = generation;
			entry.session = session;
			entry.generation = generation;
			delete entry.catalog;
			entry.connectedAt = isoTimestamp(this.#now);
			delete entry.errorCode;
			this.#transition(entry, "online");
			return this.#snapshotEntry(entry);
		} catch (error) {
			const cleanup = cleanupAfterFailedConnect(session, transport);
			if (cleanup !== undefined) {
				try {
					await cleanup();
				} catch (cleanupError) {
					entry.quarantinedCleanup = cleanup;
					entry.errorCode = KMCP_ERROR_CODES.CONNECTION_CLOSE_FAILED;
					this.#transition(entry, "quarantined");
					throw new KmcpError(
						KMCP_ERROR_CODES.CONNECTION_CLOSE_FAILED,
						`Failed to clean up the unsuccessful connection '${entry.definition.id}'.`,
						{
							cause: new AggregateError([error, cleanupError], "Connect and cleanup both failed."),
						},
					);
				}
			}
			entry.errorCode = KMCP_ERROR_CODES.CONNECTION_CONNECT_FAILED;
			this.#transition(entry, "failed");
			throw new KmcpError(
				KMCP_ERROR_CODES.CONNECTION_CONNECT_FAILED,
				`Failed to connect '${entry.definition.id}'.`,
				{ cause: error },
			);
		}
	}

	async #performRemove(entry: ManagedConnection<Id>): Promise<void> {
		await this.disconnect(entry.definition.id);
		if (this.#entries.get(entry.definition.id) !== entry) return;
		this.#entries.delete(entry.definition.id);
		this.#publish("connection.removed", entry);
	}

	async #performDisconnect(entry: ManagedConnection<Id>): Promise<McpConnectionSnapshot<Id>> {
		if (entry.connectTask !== undefined) await entry.connectTask.catch(() => undefined);
		const quarantinedCleanup = entry.quarantinedCleanup;
		if (quarantinedCleanup !== undefined) {
			this.#transition(entry, "draining");
			try {
				await quarantinedCleanup();
				delete entry.quarantinedCleanup;
				delete entry.errorCode;
				this.#transition(entry, "offline");
				return this.#snapshotEntry(entry);
			} catch (error) {
				entry.errorCode = KMCP_ERROR_CODES.CONNECTION_CLOSE_FAILED;
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
			this.#transition(entry, "offline");
			return this.#snapshotEntry(entry);
		}

		this.#transition(entry, "draining");
		await this.#waitUntilDrained(entry);
		try {
			await session.close();
			delete entry.session;
			delete entry.connectedAt;
			delete entry.errorCode;
			this.#transition(entry, "offline");
			return this.#snapshotEntry(entry);
		} catch (error) {
			entry.errorCode = KMCP_ERROR_CODES.CONNECTION_CLOSE_FAILED;
			this.#transition(entry, "quarantined");
			throw new KmcpError(
				KMCP_ERROR_CODES.CONNECTION_CLOSE_FAILED,
				`Failed to close '${entry.definition.id}'.`,
				{ cause: error },
			);
		}
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
		entry.phase = phase;
		entry.lastTransitionAt = isoTimestamp(this.#now);
		this.#publish("connection.state.changed", entry);
	}

	#publish(type: McpConnectionEventType, entry: ManagedConnection<Id>): void {
		this.#revision += 1;
		const event: McpConnectionEvent<Id> = Object.freeze({
			revision: this.#revision,
			type,
			occurredAt: isoTimestamp(this.#now),
			connection: this.#snapshotEntry(entry),
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
		const serverInfo = client?.getServerVersion();
		const protocolVersion = client?.getNegotiatedProtocolVersion();
		const protocolEra = client?.getProtocolEra();
		const capabilities = client?.getServerCapabilities();
		return Object.freeze({
			id: entry.definition.id,
			label: entry.definition.label,
			tags: entry.definition.tags,
			phase: entry.phase,
			generation: entry.generation,
			lastTransitionAt: entry.lastTransitionAt,
			...(entry.connectedAt === undefined ? {} : { connectedAt: entry.connectedAt }),
			...(protocolVersion === undefined ? {} : { protocolVersion }),
			...(protocolEra === undefined ? {} : { protocolEra }),
			...(serverInfo === undefined ? {} : { serverInfo: immutableClone(serverInfo) }),
			...(capabilities === undefined ? {} : { capabilities: immutableClone(capabilities) }),
			...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
			...(entry.catalog === undefined ? {} : { catalog: entry.catalog }),
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

function cloneCatalogItems<Item>(
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
