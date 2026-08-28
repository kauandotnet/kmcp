import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

import {
	McpConnectionDefinition,
	type McpConnectionDefinitionOptions,
	httpConnection,
} from "../client/connection.ts";
import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import { stdioConnection } from "../node.ts";

/** A stdio entry of an `mcpServers` config (the shape desktop MCP clients and editors share). */
export interface McpStdioServerConfig {
	readonly type?: "stdio";
	readonly command: string;
	readonly args?: readonly string[];
	/** Merged over the SDK's default inherited environment. Values are secrets: never logged. */
	readonly env?: Readonly<Record<string, string>>;
	readonly cwd?: string;
	/** Hub namespace to use for this entry; derived from the key when omitted. */
	readonly namespace?: string;
}

/** A remote (Streamable HTTP) entry of an `mcpServers` config. */
export interface McpHttpServerConfig {
	readonly type?: "http" | "streamable-http";
	readonly url: string;
	/** Static headers; an `Authorization` header is forwarded verbatim (and never exposed in snapshots). */
	readonly headers?: Readonly<Record<string, string>>;
	/** Hub namespace to use for this entry; derived from the key when omitted. */
	readonly namespace?: string;
}

export type McpServerConfig = McpHttpServerConfig | McpStdioServerConfig;

export interface McpServersConfig {
	readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
}

/** Definition options applied to every connection produced from a config. */
export type McpConfigConnectionDefaults = Omit<
	McpConnectionDefinitionOptions<string>,
	"id" | "label" | "oauth" | "tags" | "transport"
>;

export interface McpConfigLoaderOptions {
	readonly defaults?: McpConfigConnectionDefaults;
	/** Extra tags stamped on every definition (merged under the loader's own `kmcp.*` tags). */
	readonly tags?: Readonly<Record<string, string>>;
}

export type McpConfigConnections<Config extends McpServersConfig> = {
	readonly [Id in keyof Config["mcpServers"] & string]: McpConnectionDefinition<Id>;
};

/** Tag keys the loader stamps on every definition. */
export const MCP_CONFIG_TAGS = Object.freeze({
	source: "kmcp.source",
	transport: "kmcp.transport",
	namespace: "kmcp.namespace",
} as const);

/**
 * Turns an `mcpServers` config into keyed connection definitions. Config keys are accepted as-is
 * (reverse-DNS keys such as `io.github.foo` are common) and each definition carries a hub-safe
 * namespace suggestion in `tags["kmcp.namespace"]` (see {@link mcpConfigNamespace}). Secrets
 * (`env`, `headers`) live only inside the transport factory — never in labels or tags.
 */
export function connectionsFromMcpConfig<const Config extends McpServersConfig>(
	config: Config,
	options: McpConfigLoaderOptions = {},
): McpConfigConnections<Config> {
	if (config === null || typeof config !== "object" || typeof config.mcpServers !== "object") {
		throw new KmcpError(KMCP_ERROR_CODES.INVALID_DEFINITION, "Expected an `mcpServers` object.");
	}
	const result: Record<string, McpConnectionDefinition<string>> = {};
	const namespaces = new Map<string, string>();
	for (const [id, entry] of Object.entries(config.mcpServers)) {
		if (id.length === 0) {
			throw new KmcpError(KMCP_ERROR_CODES.INVALID_DEFINITION, "Config keys must be non-empty.");
		}
		const namespace = entry.namespace ?? mcpConfigNamespace(id);
		const clash = namespaces.get(namespace);
		if (clash !== undefined) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				`Config entries '${clash}' and '${id}' map to the same namespace '${namespace}'; set 'namespace' explicitly.`,
			);
		}
		namespaces.set(namespace, id);
		const shared = options.defaults ?? {};
		const base = {
			...shared,
			id,
			label: id,
		};
		const tagsFor = (transport: "http" | "stdio") => ({
			...options.tags,
			[MCP_CONFIG_TAGS.source]: "mcp-config",
			[MCP_CONFIG_TAGS.transport]: transport,
			[MCP_CONFIG_TAGS.namespace]: namespace,
		});
		if ("url" in entry) {
			if (typeof entry.url !== "string") {
				throw new KmcpError(
					KMCP_ERROR_CODES.INVALID_DEFINITION,
					`Config entry '${id}' must have a string 'url'.`,
				);
			}
			result[id] = httpConnection({
				...base,
				tags: tagsFor("http"),
				url: entry.url,
				...(entry.headers === undefined ? {} : { headers: entry.headers }),
			});
			continue;
		}
		if (typeof entry.command !== "string" || entry.command.length === 0) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				`Config entry '${id}' must have a 'command' or a 'url'.`,
			);
		}
		result[id] = stdioConnection({
			...base,
			tags: tagsFor("stdio"),
			stdio: {
				command: entry.command,
				args: [...(entry.args ?? [])],
				env: { ...getDefaultEnvironment(), ...entry.env },
				...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
			},
		});
	}
	return Object.freeze(result) as McpConfigConnections<Config>;
}

/**
 * Derives a hub-safe namespace (`/^[A-Za-z0-9][A-Za-z0-9_-]*$/`) from a config key: every other
 * character becomes `_`, runs collapse, and a leading non-alphanumeric prefix is dropped.
 */
export function mcpConfigNamespace(id: string): string {
	const cleaned = id
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^[^A-Za-z0-9]+/, "");
	return cleaned.length === 0 ? "server" : cleaned;
}
