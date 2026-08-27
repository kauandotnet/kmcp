import {
	createMcpHandler,
	type CreateMcpHandlerOptions,
	type Implementation,
	type McpHttpHandler,
	type McpRequestContext,
	McpServer,
	type McpServerFactory,
	type ServerOptions,
	type Transport,
} from "@modelcontextprotocol/server";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import { immutableProtocolClone, type MaybePromise } from "../internal/value.ts";
import {
	assertCanonicalCapability,
	installCanonicalCapability,
	type AnyMcpCapabilityDefinition,
	type McpRegistrationHandle,
} from "./capability.ts";

export interface McpServerDefinitionOptions {
	readonly sdk?: ServerOptions;
	readonly capabilities?: readonly AnyMcpCapabilityDefinition[];
	readonly setup?: (server: McpServer, context: McpRequestContext) => MaybePromise<void>;
}

export interface McpInstalledCapability {
	readonly definition: AnyMcpCapabilityDefinition;
	readonly handle: McpRegistrationHandle;
}

export class McpServerRuntime implements AsyncDisposable {
	readonly server: McpServer;
	readonly registrations: readonly McpInstalledCapability[];

	constructor(server: McpServer, registrations: readonly McpInstalledCapability[]) {
		this.server = server;
		this.registrations = Object.freeze([...registrations]);
		Object.freeze(this);
	}

	connect(transport: Transport): Promise<void> {
		return this.server.connect(transport);
	}

	close(): Promise<void> {
		return this.server.close();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}
}

export class McpServerDefinition {
	readonly serverInfo: Readonly<Implementation>;
	readonly sdkOptions: ServerOptions | undefined;
	readonly capabilities: readonly AnyMcpCapabilityDefinition[];
	readonly #setup:
		((server: McpServer, context: McpRequestContext) => MaybePromise<void>) | undefined;

	constructor(serverInfo: Implementation, options: McpServerDefinitionOptions = {}) {
		this.serverInfo = immutableProtocolClone(serverInfo, "server info");
		this.sdkOptions = options.sdk;
		this.capabilities = Object.freeze([...(options.capabilities ?? [])]);
		this.#setup = options.setup;
		for (const capability of this.capabilities) assertCanonicalCapability(capability);
		assertUniqueCapabilities(this.capabilities);
		Object.freeze(this);
	}

	async create(context: McpRequestContext): Promise<McpServer> {
		return (await this.instantiate(context)).server;
	}

	async instantiate(context: McpRequestContext): Promise<McpServerRuntime> {
		const server = new McpServer(this.serverInfo, this.sdkOptions);
		try {
			const registrations = this.capabilities.map((definition) =>
				Object.freeze({
					definition,
					handle: installCanonicalCapability(definition, server),
				}),
			);
			await this.#setup?.(server, context);
			return new McpServerRuntime(server, registrations);
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
		return new McpServerDefinition(this.serverInfo, {
			...(this.sdkOptions === undefined ? {} : { sdk: this.sdkOptions }),
			capabilities: [...this.capabilities, ...capabilities],
			...(this.#setup === undefined ? {} : { setup: this.#setup }),
		});
	}
}

export function defineServer(
	serverInfo: Implementation,
	options: McpServerDefinitionOptions = {},
): McpServerDefinition {
	return new McpServerDefinition(serverInfo, options);
}

function assertUniqueCapabilities(capabilities: readonly AnyMcpCapabilityDefinition[]): void {
	const keys = new Set<string>();
	for (const capability of capabilities) {
		const key = `${capability.kind}:${capability.name}`;
		if (keys.has(key)) {
			throw new KmcpError(
				KMCP_ERROR_CODES.CAPABILITY_DUPLICATE,
				`Duplicate MCP capability: ${key}.`,
			);
		}
		keys.add(key);
	}
}
