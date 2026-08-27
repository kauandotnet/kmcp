import { McpConnectionManager, type McpConnectionManagerOptions } from "./client/manager.ts";
import { McpHubManager } from "./hub/hub.ts";

export interface KmcpOptions {
	readonly connections?: McpConnectionManagerOptions;
}

export class Kmcp<
	ConnectionId extends string = string,
	HubId extends string = string,
> implements AsyncDisposable {
	readonly connections: McpConnectionManager<ConnectionId>;
	readonly hubs: McpHubManager<HubId, ConnectionId>;
	#closed = false;
	#closeTask: Promise<void> | undefined;

	constructor(options: KmcpOptions = {}) {
		this.connections = new McpConnectionManager(options.connections);
		this.hubs = new McpHubManager(this.connections);
	}

	get closed(): boolean {
		return this.#closed;
	}

	close(): Promise<void> {
		if (this.#closeTask !== undefined) return this.#closeTask;
		this.#closed = true;
		const task = Promise.resolve().then(async () => {
			this.hubs.close();
			await this.connections.close();
		});
		this.#closeTask = task;
		return task;
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}
}

export function createKmcp<ConnectionId extends string = string, HubId extends string = string>(
	options: KmcpOptions = {},
): Kmcp<ConnectionId, HubId> {
	return new Kmcp(options);
}

export class KmcpBuilder {
	readonly #options: KmcpOptions;

	constructor(options: KmcpOptions = {}) {
		this.#options = options;
	}

	connections(options: McpConnectionManagerOptions): KmcpBuilder {
		return new KmcpBuilder({ ...this.#options, connections: options });
	}

	build<ConnectionId extends string = string, HubId extends string = string>(): Kmcp<
		ConnectionId,
		HubId
	> {
		return new Kmcp(this.#options);
	}
}
