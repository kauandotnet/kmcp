import {
	StdioClientTransport,
	type StdioServerParameters,
} from "@modelcontextprotocol/client/stdio";
import {
	serveStdio,
	type ServeStdioOptions,
	type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import {
	toNodeHandler,
	type NodeMcpRequestHandler,
	type ToNodeHandlerOptions,
} from "@modelcontextprotocol/node";
import type { CreateMcpHandlerOptions, McpHttpHandler } from "@modelcontextprotocol/server";

import {
	McpConnectionDefinition,
	type McpConnectionDefinitionOptions,
} from "./client/connection.ts";
import type { McpServerDefinition } from "./authoring/server-definition.ts";

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

export function serveMcpStdio(
	definition: McpServerDefinition,
	options?: ServeStdioOptions,
): StdioServerHandle {
	return serveStdio(definition.factory(), options);
}

export interface McpNodeHandlerOptions {
	readonly mcp?: CreateMcpHandlerOptions;
	readonly node?: ToNodeHandlerOptions;
}

export type McpNodeHandler = NodeMcpRequestHandler & McpHttpHandler;

export function createNodeMcpHandler(
	definition: McpServerDefinition,
	options: McpNodeHandlerOptions = {},
): McpNodeHandler {
	const mcp = definition.handler(options.mcp);
	const node = toNodeHandler(mcp, options.node);
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
