import {
	StdioClientTransport,
	type StdioServerParameters,
} from "@modelcontextprotocol/client/stdio";
import {
	serveStdio,
	type ServeStdioOptions,
	type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
	toNodeHandler,
	type NodeIncomingMessageLike,
	type NodeServerResponseLike,
	type ToNodeHandlerOptions,
} from "@modelcontextprotocol/node";
import {
	createMcpHandler,
	type CreateMcpHandlerOptions,
	type McpHttpHandler,
} from "@modelcontextprotocol/server";

import {
	McpConnectionDefinition,
	type McpConnectionDefinitionOptions,
} from "./client/connection.ts";
import { type McpAuthGate, withMcpAuth } from "./auth/gate.ts";
import { KMCP_ERROR_CODES, KmcpError } from "./errors.ts";
import {
	type McpServerRuntime,
	type McpServerSource,
	resolveServerSource,
	serverSourceFactory,
} from "./authoring/server-definition.ts";

export interface McpStdioConnectionOptions<Id extends string> extends Omit<
	McpConnectionDefinitionOptions<Id>,
	"transport"
> {
	readonly stdio: StdioServerParameters;
}

export function stdioConnection<const Id extends string>(
	options: McpStdioConnectionOptions<Id>,
): McpConnectionDefinition<Id> {
	const { stdio, ...definition } = options;
	return new McpConnectionDefinition({
		...definition,
		transport: () => new StdioClientTransport(stdio),
	});
}

/** Typed change-signal facade over the pinned stdio instance; each call is a no-op before pinning. */
export interface McpStdioNotifier {
	toolsChanged(): Promise<void>;
	promptsChanged(): Promise<void>;
	resourcesChanged(): Promise<void>;
	resourceUpdated(uri: string): Promise<void>;
}

export interface McpStdioHandle extends StdioServerHandle {
	/**
	 * The most recently materialized runtime. `serveStdio` pins one instance per connection; a
	 * modern opening may first materialize a `server/discover` probe instance that is discarded
	 * when the client falls back to the legacy handshake, so this getter reflects the latest.
	 */
	readonly runtime: McpServerRuntime | undefined;
	readonly notify: McpStdioNotifier;
}

export function serveMcpStdio(
	source: McpServerSource,
	options?: ServeStdioOptions,
): McpStdioHandle {
	assertServeableWithoutPrincipal(resolveServerSource(source), "serveMcpStdio");
	let current: McpServerRuntime | undefined;
	const handle = serveStdio(async (context) => {
		const definition = resolveServerSource(source);
		assertServeableWithoutPrincipal(definition, "serveMcpStdio");
		const runtime = await definition.instantiate(context);
		current = runtime;
		return runtime.server;
	}, options);
	const server = () => current?.server.server;
	return {
		close: () => handle.close(),
		get runtime() {
			return current;
		},
		notify: Object.freeze({
			toolsChanged: () => server()?.sendToolListChanged() ?? Promise.resolve(),
			promptsChanged: () => server()?.sendPromptListChanged() ?? Promise.resolve(),
			resourcesChanged: () => server()?.sendResourceListChanged() ?? Promise.resolve(),
			resourceUpdated: (uri: string) => server()?.sendResourceUpdated({ uri }) ?? Promise.resolve(),
		}),
	};
}

/**
 * `serveStdio` never supplies `authInfo`, so a definition whose capabilities require an
 * authenticated principal would silently serve nothing. Fail at startup instead.
 */
function assertServeableWithoutPrincipal(
	definition: ReturnType<typeof resolveServerSource>,
	entry: string,
): void {
	if (definition.requiresAuthenticatedPrincipal) {
		throw new KmcpError(
			KMCP_ERROR_CODES.CAPABILITY_AUTH_UNSERVEABLE,
			`${entry} cannot supply authInfo, but a capability declares auth.anonymous: "deny".`,
		);
	}
}

export interface McpNodeHandlerOptions {
	readonly mcp?: CreateMcpHandlerOptions;
	readonly node?: ToNodeHandlerOptions;
	/** Runs before every request; a caller-supplied `req.auth` is discarded when a gate is set. */
	readonly auth?: McpAuthGate;
}

/**
 * The Node request handler plus the official handler's control plane. It accepts Node's own
 * `IncomingMessage`/`ServerResponse` (whose `method`/`url` are typed optional) as well as the
 * SDK's duck types, so it can be passed straight to `createServer`.
 */
export type McpNodeRequestHandler = (
	request: IncomingMessage | NodeIncomingMessageLike,
	response: ServerResponse | NodeServerResponseLike,
	parsedBody?: unknown,
) => Promise<void>;

export type McpNodeHandler = McpNodeRequestHandler & McpHttpHandler;

export function createNodeMcpHandler(
	source: McpServerSource,
	options: McpNodeHandlerOptions = {},
): McpNodeHandler {
	const raw = createMcpHandler(serverSourceFactory(source), options.mcp);
	const mcp = options.auth === undefined ? raw : withMcpAuth(raw, options.auth);
	const adapter = toNodeHandler(mcp, options.node);
	const node: McpNodeRequestHandler = (request, response, parsedBody) =>
		adapter(request as NodeIncomingMessageLike, response as NodeServerResponseLike, parsedBody);
	return Object.assign(node, {
		fetch: mcp.fetch,
		close: mcp.close,
		notify: mcp.notify,
		bus: mcp.bus,
	});
}

export {
	StdioClientTransport,
	type StdioServerParameters,
} from "@modelcontextprotocol/client/stdio";
export {
	StdioServerTransport,
	type ServeStdioOptions,
	type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
export {
	hostHeaderValidation,
	localhostHostValidation,
	localhostOriginValidation,
	originValidation,
	toNodeHandler,
	toWebRequest,
} from "@modelcontextprotocol/node";
export type {
	NodeIncomingMessageLike,
	NodeMcpRequestHandler,
	NodeServerResponseLike,
	ToNodeHandlerOptions,
	ToWebRequestOptions,
} from "@modelcontextprotocol/node";
export { envBool, mcpHttpEnvOptions, serveMcpHttp } from "./node/serve.ts";
export type {
	McpDnsRebindingOptions,
	McpHttpServeOptions,
	McpHttpServerAddress,
	McpHttpServerHandle,
} from "./node/serve.ts";
export { FileKeyValueStore, loopbackOAuthCallback } from "./node/oauth.ts";
export type { McpLoopbackOAuthCallback, McpLoopbackOAuthCallbackOptions } from "./node/oauth.ts";

export {
	MCP_CONFIG_TAGS,
	connectionsFromMcpConfig,
	mcpConfigNamespace,
	type McpConfigConnectionDefaults,
	type McpConfigConnections,
	type McpConfigLoaderOptions,
	type McpHttpServerConfig,
	type McpServerConfig,
	type McpServersConfig,
	type McpStdioServerConfig,
} from "./node/config.ts";
