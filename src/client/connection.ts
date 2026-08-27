import {
	Client,
	type ClientOptions,
	type ConnectOptions,
	type Implementation,
	StreamableHTTPClientTransport,
	type StreamableHTTPClientTransportOptions,
	type Transport,
} from "@modelcontextprotocol/client";

import { assertNonEmpty, type MaybePromise } from "../internal/value.ts";

export type McpTransportFactory = () => MaybePromise<Transport>;

export interface McpConnectionDefinitionOptions<Id extends string> {
	readonly id: Id;
	readonly label?: string;
	readonly tags?: Readonly<Record<string, string>>;
	readonly clientInfo?: Implementation;
	readonly clientOptions?: ClientOptions;
	readonly connectOptions?: ConnectOptions;
	readonly transport: McpTransportFactory;
}

export class McpConnectionDefinition<const Id extends string = string> {
	readonly id: Id;
	readonly label: string;
	readonly tags: Readonly<Record<string, string>>;
	readonly clientInfo: Readonly<Implementation>;
	readonly clientOptions: ClientOptions;
	readonly connectOptions: ConnectOptions | undefined;
	readonly #transportFactory: McpTransportFactory;

	constructor(options: McpConnectionDefinitionOptions<Id>) {
		assertNonEmpty(options.id, "connection id");
		this.id = options.id;
		this.label = options.label ?? options.id;
		assertNonEmpty(this.label, "connection label");
		this.tags = Object.freeze({ ...options.tags });
		this.clientInfo = Object.freeze({
			name: "kmcp",
			version: "0.1.0-alpha.0",
			...options.clientInfo,
		});
		this.clientOptions = Object.freeze({
			...options.clientOptions,
			versionNegotiation: options.clientOptions?.versionNegotiation ?? { mode: "auto" as const },
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
}

export function defineConnection<const Id extends string>(
	options: McpConnectionDefinitionOptions<Id>,
): McpConnectionDefinition<Id> {
	return new McpConnectionDefinition(options);
}

export interface McpHttpConnectionOptions<Id extends string> extends Omit<
	McpConnectionDefinitionOptions<Id>,
	"transport"
> {
	readonly url: string | URL;
	readonly transportOptions?: StreamableHTTPClientTransportOptions;
}

export function httpConnection<const Id extends string>(
	options: McpHttpConnectionOptions<Id>,
): McpConnectionDefinition<Id> {
	const { url, transportOptions, ...definition } = options;
	const endpoint = typeof url === "string" ? new URL(url) : new URL(url.href);
	return new McpConnectionDefinition({
		...definition,
		transport: () => new StreamableHTTPClientTransport(endpoint, transportOptions),
	});
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

	get closed(): boolean {
		return this.#closed;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		if (this.#closeTask !== undefined) return this.#closeTask;
		const task = this.client.close().then(() => {
			this.#closed = true;
		});
		this.#closeTask = task;
		try {
			await task;
		} catch (error) {
			if (this.#closeTask === task) this.#closeTask = undefined;
			throw error;
		}
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}
}

export function createOfficialClient(definition: McpConnectionDefinition): Client {
	return new Client(definition.clientInfo, definition.clientOptions);
}
