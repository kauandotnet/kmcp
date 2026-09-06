import { readFile } from "node:fs/promises";
import { homedir, platform as osPlatform } from "node:os";
import { join, resolve } from "node:path";

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
	/** Request timeout in SECONDS (the field name and unit editors and `mcp.json` files share). */
	readonly timeout?: number;
	/** Pin one exact protocol revision (strict, no fallback); absent means auto-negotiate. */
	readonly protocolVersion?: string;
	/** Hub namespace to use for this entry; derived from the key when omitted. */
	readonly namespace?: string;
}

/** A remote (Streamable HTTP) entry of an `mcpServers` config. */
export interface McpHttpServerConfig {
	readonly type?: "http" | "streamable-http";
	readonly url: string;
	/** Static headers; an `Authorization` header is forwarded verbatim (and never exposed in snapshots). */
	readonly headers?: Readonly<Record<string, string>>;
	/** Request timeout in SECONDS (the field name and unit editors and `mcp.json` files share). */
	readonly timeout?: number;
	/** Pin one exact protocol revision (strict, no fallback); absent means auto-negotiate. */
	readonly protocolVersion?: string;
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
	"id" | "label" | "oauth" | "tags" | "transport" | "transportKind"
>;

export interface McpConfigLoaderOptions {
	readonly defaults?: McpConfigConnectionDefaults;
	/** Extra tags stamped on every definition (merged under the loader's own `kmcp.*` tags). */
	readonly tags?: Readonly<Record<string, string>>;
	/**
	 * Substitute `${NAME}` references in `url`, `command`, `args`, `env`, and `headers` from this
	 * map (pass `process.env` to use the process environment). Off when absent: config values are
	 * taken literally.
	 */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Observes a `${NAME}` whose variable is absent; the reference becomes an empty string. */
	readonly onMissingEnv?: (name: string, entryId: string) => void;
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
 * (`env`, `headers`) live only inside the transport factory — never in labels or tags. A
 * `timeout` (seconds) becomes the definition's default request timeout and a `protocolVersion`
 * pins the revision.
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
	for (const [id, rawEntry] of Object.entries(config.mcpServers)) {
		if (id.length === 0) {
			throw new KmcpError(KMCP_ERROR_CODES.INVALID_DEFINITION, "Config keys must be non-empty.");
		}
		const entry = options.env === undefined ? rawEntry : substituteEntry(rawEntry, id, options);
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
		const timeoutMs = entryTimeoutMs(entry, id);
		const base = {
			...shared,
			// The entry's own `timeout` is the more specific value, so it wins; the loader's
			// `defaults.timeoutMs` only fills in for entries that declare none.
			...(timeoutMs === undefined ? {} : { defaults: { ...shared.defaults, timeoutMs } }),
			...(entry.protocolVersion === undefined ? {} : { protocolVersion: entry.protocolVersion }),
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

function entryTimeoutMs(entry: McpServerConfig, id: string): number | undefined {
	if (entry.timeout === undefined) return undefined;
	if (!Number.isFinite(entry.timeout) || entry.timeout <= 0) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`Config entry '${id}' has an invalid 'timeout' (seconds, positive).`,
		);
	}
	return Math.round(entry.timeout * 1000);
}

const ENV_REFERENCE = /\$\{([^}]+)\}/g;

function substituteEntry(
	entry: McpServerConfig,
	id: string,
	options: McpConfigLoaderOptions,
): McpServerConfig {
	const env = options.env ?? {};
	const substitute = (value: string): string =>
		value.replace(ENV_REFERENCE, (_match, name: string) => {
			const replacement = env[name];
			if (replacement === undefined) {
				options.onMissingEnv?.(name, id);
				return "";
			}
			return replacement;
		});
	const substituteRecord = (
		record: Readonly<Record<string, string>> | undefined,
	): Readonly<Record<string, string>> | undefined =>
		record === undefined
			? undefined
			: Object.fromEntries(Object.entries(record).map(([key, value]) => [key, substitute(value)]));
	if ("url" in entry) {
		const headers = substituteRecord(entry.headers);
		return {
			...entry,
			url: substitute(entry.url),
			...(headers === undefined ? {} : { headers }),
		};
	}
	const env2 = substituteRecord(entry.env);
	return {
		...entry,
		command: substitute(entry.command),
		...(entry.args === undefined ? {} : { args: entry.args.map(substitute) }),
		...(env2 === undefined ? {} : { env: env2 }),
	};
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

/**
 * Recognizes a parsed document as an MCP config: the standard `{ mcpServers }` shape or the VS Code
 * `{ servers }` variant (normalized to `mcpServers`). Returns `undefined` for anything else,
 * including valid JSON that simply is not an MCP config. The servers object may be empty.
 */
export function asMcpServersConfig(parsed: unknown): McpServersConfig | undefined {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	for (const key of ["mcpServers", "servers"] as const) {
		const servers = record[key];
		if (typeof servers === "object" && servers !== null && !Array.isArray(servers)) {
			return { mcpServers: servers as Readonly<Record<string, McpServerConfig>> };
		}
	}
	return undefined;
}

/** Reads and recognizes one MCP config file (see {@link asMcpServersConfig}). */
export async function readMcpConfigFile(path: string): Promise<McpServersConfig> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		throw new KmcpError(KMCP_ERROR_CODES.OPERATION_FAILED, `Cannot read MCP config '${path}'.`, {
			cause: error,
		});
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`MCP config '${path}' is not valid JSON.`,
			{ cause: error },
		);
	}
	const config = asMcpServersConfig(parsed);
	if (config === undefined) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`MCP config '${path}' has no 'mcpServers' (or 'servers') object.`,
		);
	}
	return config;
}

/** A well-known MCP config file location. */
export interface McpConfigCandidate {
	readonly path: string;
	/** `project` files live under the working directory, `global` files under the home directory. */
	readonly scope: "global" | "project";
	/** The client the location belongs to, for display. */
	readonly client: string;
}

export interface McpConfigPathOptions {
	readonly homeDir?: string;
	readonly cwd?: string;
	readonly platform?: NodeJS.Platform;
	/** Windows `APPDATA`; defaults to `process.env.APPDATA`. */
	readonly appData?: string;
}

/**
 * The standard MCP config locations, project-level first (they win on collisions): Claude Code
 * (`.mcp.json`, `~/.claude.json`), Claude Desktop, Cursor, VS Code, Windsurf, and Kiro. Paths are
 * absolute and de-duplicated; nothing is read.
 */
export function standardMcpConfigPaths(
	options: McpConfigPathOptions = {},
): readonly McpConfigCandidate[] {
	const home = options.homeDir ?? homedir();
	const cwd = options.cwd ?? process.cwd();
	const platform = options.platform ?? osPlatform();
	const appData = options.appData ?? process.env.APPDATA;
	const candidates: McpConfigCandidate[] = [
		{ path: join(cwd, ".mcp.json"), scope: "project", client: "claude-code" },
		{ path: join(cwd, "mcp.json"), scope: "project", client: "generic" },
		{ path: join(cwd, "mcp_config.json"), scope: "project", client: "generic" },
		{ path: join(cwd, ".cursor/mcp.json"), scope: "project", client: "cursor" },
		{ path: join(cwd, ".vscode/mcp.json"), scope: "project", client: "vscode" },
		{ path: join(cwd, ".kiro/settings/mcp.json"), scope: "project", client: "kiro" },
		{ path: join(home, ".cursor/mcp.json"), scope: "global", client: "cursor" },
		{ path: join(home, ".vscode/mcp.json"), scope: "global", client: "vscode" },
		{ path: join(home, ".codeium/windsurf/mcp_config.json"), scope: "global", client: "windsurf" },
		{ path: join(home, ".kiro/settings/mcp.json"), scope: "global", client: "kiro" },
		{ path: join(home, ".claude.json"), scope: "global", client: "claude-code" },
	];
	if (platform === "darwin") {
		candidates.push(
			{
				path: join(home, "Library/Application Support/Code/User/mcp.json"),
				scope: "global",
				client: "vscode",
			},
			{
				path: join(home, "Library/Application Support/Claude/claude_desktop_config.json"),
				scope: "global",
				client: "claude-desktop",
			},
		);
	} else if (platform === "win32") {
		if (appData !== undefined && appData.length > 0) {
			candidates.push(
				{ path: join(appData, "Code/User/mcp.json"), scope: "global", client: "vscode" },
				{
					path: join(appData, "Claude/claude_desktop_config.json"),
					scope: "global",
					client: "claude-desktop",
				},
			);
		}
	} else {
		candidates.push(
			{ path: join(home, ".config/Code/User/mcp.json"), scope: "global", client: "vscode" },
			{
				path: join(home, ".config/Claude/claude_desktop_config.json"),
				scope: "global",
				client: "claude-desktop",
			},
		);
	}
	const seen = new Set<string>();
	const unique: McpConfigCandidate[] = [];
	for (const candidate of candidates) {
		const absolute = resolve(candidate.path);
		if (seen.has(absolute)) continue;
		seen.add(absolute);
		unique.push(Object.freeze({ ...candidate, path: absolute }));
	}
	return Object.freeze(unique);
}

/**
 * Errno codes that mean "there is no config file here", not "the file is broken": the path itself
 * is missing (`ENOENT`), a path component is not a directory (`ENOTDIR`, e.g. `~/.cursor` is a
 * file), or the candidate is a directory (`EISDIR`). Everything else — a permission denial, a
 * dangling symlink loop, an I/O error — is a real access failure worth reporting.
 */
const ABSENT_CONFIG_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

function isAbsentConfig(error: unknown): boolean {
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" && ABSENT_CONFIG_CODES.has(code);
}

/** A config found at a standard location, with its parsed content. */
export interface McpDiscoveredConfig extends McpConfigCandidate {
	readonly config: McpServersConfig;
}

/** A file at a standard location that exists but could not be used. */
export interface McpConfigProblem extends McpConfigCandidate {
	readonly error: string;
}

export interface McpConfigDiscovery {
	readonly configs: readonly McpDiscoveredConfig[];
	readonly problems: readonly McpConfigProblem[];
}

/**
 * Reads every standard MCP config location that exists. Unreadable or unparseable files are
 * reported as problems rather than thrown, so one broken editor config never hides the others.
 */
export async function discoverMcpConfigs(
	options: McpConfigPathOptions = {},
): Promise<McpConfigDiscovery> {
	const configs: McpDiscoveredConfig[] = [];
	const problems: McpConfigProblem[] = [];
	for (const candidate of standardMcpConfigPaths(options)) {
		let raw: string;
		try {
			raw = await readFile(candidate.path, "utf8");
		} catch (error) {
			if (isAbsentConfig(error)) continue;
			problems.push({ ...candidate, error: "unreadable" });
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			problems.push({ ...candidate, error: "invalid JSON" });
			continue;
		}
		const config = asMcpServersConfig(parsed);
		if (config === undefined) {
			// Global files such as ~/.claude.json hold other settings; only a project file that
			// claims to be an MCP config and is not gets reported.
			if (candidate.scope === "project") {
				problems.push({ ...candidate, error: "no mcpServers object" });
			}
			continue;
		}
		configs.push({ ...candidate, config });
	}
	return Object.freeze({ configs: Object.freeze(configs), problems: Object.freeze(problems) });
}
