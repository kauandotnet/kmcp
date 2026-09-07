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
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

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
import { stableFingerprint } from "./internal/value.ts";
import {
	type McpServerRuntime,
	type McpServerSource,
	resolveServerSource,
	serverSourceFactory,
} from "./authoring/server-definition.ts";

export interface McpStdioConnectionOptions<Id extends string> extends Omit<
	McpConnectionDefinitionOptions<Id>,
	"transport" | "transportKind"
> {
	readonly stdio: StdioServerParameters;
	/**
	 * Receives every newline-terminated line the child writes to stderr (the SDK pipes it instead
	 * of inheriting the parent's stderr). Lines are untrusted upstream text: bound them before they
	 * reach logs. Without it the SDK default applies (`stdio.stderr`, else `inherit`).
	 */
	readonly onStderrLine?: (line: string) => void;
	/** Longest stderr line delivered to `onStderrLine`; longer lines are truncated. Default: 8 KiB. */
	readonly maxStderrLineLength?: number;
}

const DEFAULT_MAX_STDERR_LINE = 8 * 1024;

export function stdioConnection<const Id extends string>(
	options: McpStdioConnectionOptions<Id>,
): McpConnectionDefinition<Id> {
	const { stdio, onStderrLine, maxStderrLineLength, ...definition } = options;
	if (onStderrLine !== undefined && typeof onStderrLine !== "function") {
		throw new TypeError("onStderrLine must be a function.");
	}
	const maxLine = maxStderrLineLength ?? DEFAULT_MAX_STDERR_LINE;
	if (!Number.isSafeInteger(maxLine) || maxLine < 1) {
		throw new RangeError("maxStderrLineLength must be a positive integer.");
	}
	return new McpConnectionDefinition({
		...definition,
		transportKind: "stdio",
		// Shape only: the command line, the env NAMES and the cwd, never env values.
		transportFingerprint: stableFingerprint({
			command: stdio.command,
			args: stdio.args ?? [],
			env: Object.keys(stdio.env ?? {}).sort(),
			cwd: stdio.cwd ?? null,
		}),
		transport: () => {
			if (onStderrLine === undefined) return new StdioClientTransport(stdio);
			const transport = new StdioClientTransport({ ...stdio, stderr: "pipe" });
			// With `stderr: "pipe"` the SDK exposes a PassThrough from construction time, so the
			// reader attaches before `start()` and never loses early startup output.
			const stream = transport.stderr as Readable | null;
			if (stream !== null) {
				const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
				lines.on("line", (line) => {
					if (line.length === 0) return;
					try {
						onStderrLine(line.length > maxLine ? `${line.slice(0, maxLine)}…` : line);
					} catch {
						// A throwing observer must not break the transport.
					}
				});
			}
			return transport;
		},
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
export {
	FileKeyValueStore,
	browserOpenCommand,
	loopbackOAuthCallback,
	openBrowser,
} from "./node/oauth.ts";
export type {
	McpBrowserOpenCommand,
	McpLoopbackOAuthCallback,
	McpLoopbackOAuthCallbackOptions,
} from "./node/oauth.ts";

export {
	MCP_CONFIG_TAGS,
	asMcpServersConfig,
	connectionsFromMcpConfig,
	discoverMcpConfigs,
	mcpConfigNamespace,
	readMcpConfigFile,
	standardMcpConfigPaths,
	watchMcpConfigs,
	type McpConfigCandidate,
	type McpConfigChange,
	type McpConfigConnectionDefaults,
	type McpConfigConnections,
	type McpConfigDiscovery,
	type McpConfigLoaderOptions,
	type McpConfigPathOptions,
	type McpConfigProblem,
	type McpConfigTransportType,
	type McpConfigWatchOptions,
	type McpConfigWatcher,
	type McpDiscoveredConfig,
	type McpHttpServerConfig,
	type McpServerConfig,
	type McpServersConfig,
	type McpStdioServerConfig,
} from "./node/config.ts";
export { parseCommandLine, resolveExecutable } from "./node/command.ts";
export type { McpParsedCommandLine, McpResolveExecutableOptions } from "./node/command.ts";
export { syncResourceToFile, writeDecodedResource, writeResourceToFile } from "./node/resources.ts";
export type {
	McpResourceFileSync,
	McpResourceFileSyncOptions,
	McpWriteResourceFileOptions,
	McpWrittenResourceFile,
} from "./node/resources.ts";
