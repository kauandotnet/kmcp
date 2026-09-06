import { type FSWatcher, type Stats, unwatchFile, watch, watchFile } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, platform as osPlatform } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

import {
	McpConnectionDefinition,
	type McpConnectionDefinitionOptions,
	httpConnection,
	sseConnection,
} from "../client/connection.ts";
import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import { stdioConnection } from "../node.ts";
import { parseCommandLine } from "./command.ts";

/**
 * The transport an entry may name in `type` (Cursor, VS Code and Claude Desktop) or in
 * `transport` (some editors and registries). `streamable-http` / `streamableHttp` are spellings of
 * `http`; `sse` selects the deprecated HTTP+SSE transport.
 */
export type McpConfigTransportType =
	"stdio" | "http" | "streamable-http" | "streamableHttp" | "sse";

/** A stdio entry of an `mcpServers` config (the shape desktop MCP clients and editors share). */
export interface McpStdioServerConfig {
	readonly type?: "stdio";
	/** Same as `type`, for hosts that spell the field `transport`. Both must agree. */
	readonly transport?: "stdio";
	/**
	 * The program to spawn. With NO `args` field, a command that carries whitespace is split as a
	 * whole command line (see `parseCommandLine`) — the single-input-field shape hosts store —
	 * so `"npx -y pkg"` becomes `npx` plus `["-y", "pkg"]`. An entry that has `args` (even `[]`)
	 * is never re-split, which is also how a program whose path contains spaces is expressed.
	 */
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

/** A remote (Streamable HTTP, or legacy HTTP+SSE when `type` says so) `mcpServers` entry. */
export interface McpHttpServerConfig {
	readonly type?: "http" | "streamable-http" | "streamableHttp" | "sse";
	/** Same as `type`, for hosts that spell the field `transport`. Both must agree. */
	readonly transport?: "http" | "streamable-http" | "streamableHttp" | "sse";
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
 *
 * The transport comes from the entry's `type` (or `transport`) when it declares one: `stdio`,
 * `http`/`streamable-http`/`streamableHttp`, or the deprecated `sse`. An unknown value, or one
 * that contradicts the entry's own fields, is refused instead of being guessed at. Entries
 * without either field keep the old inference: a `url` means Streamable HTTP, a `command` means
 * stdio.
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
			id,
			label: id,
		};
		// `sseConnection` takes no `protocolVersion` (that wire is legacy-era only), so the pin is
		// applied per transport rather than in `base`.
		const pin =
			entry.protocolVersion === undefined ? {} : { protocolVersion: entry.protocolVersion };
		const tagsFor = (transport: "http" | "sse" | "stdio") => ({
			...options.tags,
			[MCP_CONFIG_TAGS.source]: "mcp-config",
			[MCP_CONFIG_TAGS.transport]: transport,
			[MCP_CONFIG_TAGS.namespace]: namespace,
		});
		const transportType = entryTransportType(entry, id);
		if (transportType === "stdio") {
			const stdio = entry as McpStdioServerConfig;
			result[id] = stdioConnection({
				...base,
				...pin,
				tags: tagsFor("stdio"),
				stdio: {
					...entryCommand(stdio, id),
					env: { ...getDefaultEnvironment(), ...stdio.env },
					...(stdio.cwd === undefined ? {} : { cwd: stdio.cwd }),
				},
			});
			continue;
		}
		const remote = entry as McpHttpServerConfig;
		if (typeof remote.url !== "string") {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				`Config entry '${id}' must have a string 'url'.`,
			);
		}
		const headers = remote.headers === undefined ? {} : { headers: remote.headers };
		if (transportType === "sse") {
			if (remote.protocolVersion !== undefined) {
				throw new KmcpError(
					KMCP_ERROR_CODES.INVALID_DEFINITION,
					`Config entry '${id}' is 'sse', which negotiates the legacy era only and cannot pin 'protocolVersion'.`,
				);
			}
			result[id] = sseConnection({ ...base, tags: tagsFor("sse"), url: remote.url, ...headers });
			continue;
		}
		result[id] = httpConnection({
			...base,
			...pin,
			tags: tagsFor("http"),
			url: remote.url,
			...headers,
		});
	}
	return Object.freeze(result) as McpConfigConnections<Config>;
}

/** The transports a config entry can resolve to, after aliases are folded together. */
type McpConfigTransport = "http" | "sse" | "stdio";

const TRANSPORT_ALIASES: Readonly<Record<string, McpConfigTransport>> = Object.freeze({
	stdio: "stdio",
	http: "http",
	"streamable-http": "http",
	streamablehttp: "http",
	streamable_http: "http",
	sse: "sse",
});

/**
 * Reads the entry's declared transport (`type`, or the `transport` spelling), falling back to the
 * historical inference. A declared value that is unknown, or that the entry's own fields
 * contradict, is a definition error: guessing would silently connect a host to the wrong wire.
 */
function entryTransportType(entry: McpServerConfig, id: string): McpConfigTransport {
	const record = entry as {
		readonly type?: unknown;
		readonly transport?: unknown;
		readonly url?: unknown;
		readonly command?: unknown;
	};
	let resolved: McpConfigTransport | undefined;
	let declaredAs: string | undefined;
	for (const field of ["type", "transport"] as const) {
		const value = record[field];
		if (value === undefined) continue;
		if (typeof value !== "string") {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				`Config entry '${id}' has a non-string '${field}'.`,
			);
		}
		const kind = TRANSPORT_ALIASES[value.trim().toLowerCase()];
		if (kind === undefined) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				`Config entry '${id}' has an unknown ${field} '${value}'; expected 'stdio', 'http', 'streamable-http' or 'sse'.`,
			);
		}
		if (resolved !== undefined && resolved !== kind) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				`Config entry '${id}' declares type '${declaredAs}' and transport '${value}'; they must agree.`,
			);
		}
		resolved = kind;
		declaredAs = value;
	}
	const hasUrl = record.url !== undefined;
	const hasCommand = record.command !== undefined;
	if (resolved === undefined) return hasUrl ? "http" : "stdio";
	if (resolved === "stdio" ? hasUrl && !hasCommand : hasCommand && !hasUrl) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`Config entry '${id}' declares '${declaredAs}' but has ${
				resolved === "stdio" ? "a 'url' and no 'command'" : "a 'command' and no 'url'"
			}.`,
		);
	}
	return resolved;
}

/**
 * The `command`/`args` pair to spawn. A `command` that holds whitespace and comes WITHOUT `args`
 * is one command line and is split (hosts with a single input field store it that way); note that
 * `${VAR}` substitution happens first, so an expanded value with spaces splits too. Any `args`
 * field — including `[]` — means the command is a program name and is passed through verbatim.
 */
function entryCommand(
	entry: McpStdioServerConfig,
	id: string,
): { command: string; args: string[] } {
	if (typeof entry.command !== "string" || entry.command.length === 0) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`Config entry '${id}' must have a 'command' or a 'url'.`,
		);
	}
	if (entry.args !== undefined) return { command: entry.command, args: [...entry.args] };
	if (!/\s/.test(entry.command)) return { command: entry.command, args: [] };
	try {
		const parsed = parseCommandLine(entry.command);
		return { command: parsed.command, args: [...parsed.args] };
	} catch (error) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`Config entry '${id}' has an unparseable 'command': ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ cause: error },
		);
	}
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

/** One watched path changed; `configs` is what discovery would report for that path right now. */
export interface McpConfigChange {
	readonly path: string;
	/**
	 * The config at `path` as it stands: one entry, or none when the file was deleted or holds no
	 * `mcpServers`/`servers` object (a `~/.claude.json` that carries only other settings). Feed the
	 * entry's `config` to {@link connectionsFromMcpConfig} to rebuild connections.
	 */
	readonly configs: readonly McpDiscoveredConfig[];
}

export interface McpConfigWatchOptions {
	/**
	 * Files to watch — absolute or `cwd`-relative paths, or candidates from
	 * {@link standardMcpConfigPaths}. Default: every standard location. Files that do not exist
	 * yet are watched too: their creation is a change.
	 */
	readonly paths?: readonly (string | McpConfigCandidate)[];
	/** Passed to {@link standardMcpConfigPaths} when `paths` is omitted; `cwd` also scopes strings. */
	readonly pathOptions?: McpConfigPathOptions;
	/** Called once per settled change, per path. Exceptions are routed to `onError`. */
	readonly onChange: (change: McpConfigChange) => void;
	/**
	 * Receives read failures, unparseable JSON, and watch failures (a `KmcpError` for the first
	 * two). The watch continues: one broken editor config never stops the others.
	 */
	readonly onError?: (error: unknown, path: string) => void;
	/** Coalescing window for bursts (editors write-then-rename). Default: 250 ms. */
	readonly debounceMs?: number;
	/** Poll with `fs.watchFile` instead of `fs.watch` (network shares, containers). */
	readonly poll?: boolean;
	/** Polling interval for `poll` and for the automatic fallback. Default: 1000 ms. */
	readonly pollIntervalMs?: number;
	/** Whether the watch keeps the process alive. Default: `true`, as `fs.watch` itself. */
	readonly persistent?: boolean;
}

export interface McpConfigWatcher {
	/** The absolute paths being watched, in the order they were resolved. */
	readonly paths: readonly string[];
	/** Stops every watcher and settles in-flight reads. Idempotent: later calls await the first. */
	close(): Promise<void>;
}

const DEFAULT_WATCH_DEBOUNCE_MS = 250;
const DEFAULT_WATCH_POLL_MS = 1000;

/**
 * Watches MCP config files and reports each settled change with the freshly parsed content, so a
 * long-lived host can pick up a server the user just added in another app without a restart.
 *
 * Watching happens on each file's PARENT directory (`fs.watch`), which is what makes creation,
 * deletion and the write-to-temp-then-rename editors do observable; a platform where that throws
 * (or fails later) falls back to `fs.watchFile` polling for the affected files. Only `node:fs` is
 * used — no watcher dependency, no recursive watching, and no directory is walked.
 */
export function watchMcpConfigs(options: McpConfigWatchOptions): McpConfigWatcher {
	if (typeof options?.onChange !== "function") {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			"watchMcpConfigs requires an 'onChange' callback.",
		);
	}
	const debounceMs = watchInterval(options.debounceMs, DEFAULT_WATCH_DEBOUNCE_MS, "debounceMs", 0);
	const pollIntervalMs = watchInterval(
		options.pollIntervalMs,
		DEFAULT_WATCH_POLL_MS,
		"pollIntervalMs",
		1,
	);
	const persistent = options.persistent ?? true;
	const pathOptions = options.pathOptions ?? {};
	const sources = options.paths ?? standardMcpConfigPaths(pathOptions);
	const candidates = new Map<string, McpConfigCandidate>();
	for (const source of sources) {
		const candidate =
			typeof source === "string"
				? watchCandidate(source, pathOptions)
				: { ...source, path: resolve(source.path) };
		if (candidate.path.length === 0) continue;
		candidates.set(candidate.path, Object.freeze(candidate));
	}

	const timers = new Map<string, NodeJS.Timeout>();
	const watchers: FSWatcher[] = [];
	const polling = new Map<string, () => void>();
	let closed = false;
	// Reads are chained so two quick edits can never deliver out of order, and so `close()` has
	// something to await before it promises that no further callback will run.
	let queue: Promise<void> = Promise.resolve();

	const report = (error: unknown, path: string): void => {
		if (options.onError === undefined) return;
		try {
			options.onError(error, path);
		} catch {
			// A throwing observer must not tear the watch down.
		}
	};

	const deliver = (change: McpConfigChange): void => {
		if (closed) return;
		try {
			options.onChange(Object.freeze(change));
		} catch (error) {
			report(error, change.path);
		}
	};

	const emit = async (candidate: McpConfigCandidate): Promise<void> => {
		if (closed) return;
		let raw: string;
		try {
			raw = await readFile(candidate.path, "utf8");
		} catch (error) {
			if (isAbsentConfig(error)) {
				deliver({ path: candidate.path, configs: Object.freeze([]) });
				return;
			}
			report(
				new KmcpError(
					KMCP_ERROR_CODES.OPERATION_FAILED,
					`Cannot read MCP config '${candidate.path}'.`,
					{ cause: error },
				),
				candidate.path,
			);
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			report(
				new KmcpError(
					KMCP_ERROR_CODES.INVALID_DEFINITION,
					`MCP config '${candidate.path}' is not valid JSON.`,
					{ cause: error },
				),
				candidate.path,
			);
			return;
		}
		const config = asMcpServersConfig(parsed);
		deliver({
			path: candidate.path,
			configs: Object.freeze(config === undefined ? [] : [Object.freeze({ ...candidate, config })]),
		});
	};

	const trigger = (path: string): void => {
		if (closed) return;
		const candidate = candidates.get(path);
		if (candidate === undefined) return;
		const pending = timers.get(path);
		if (pending !== undefined) clearTimeout(pending);
		const timer = setTimeout(() => {
			timers.delete(path);
			// The chain must never end up rejected: `close()` awaits it, and an unexpected failure
			// belongs to the observer, not to the caller that happens to be closing the watch.
			queue = queue
				.then(() => emit(candidate))
				.catch((error: unknown) => report(error, candidate.path));
		}, debounceMs);
		if (!persistent) timer.unref();
		timers.set(path, timer);
	};

	const startPolling = (candidate: McpConfigCandidate): void => {
		if (closed || polling.has(candidate.path)) return;
		const listener = (current: Stats, previous: Stats): void => {
			// `watchFile` polls a path that does not exist too; two absent stats are not a change.
			if (current.mtimeMs === 0 && previous.mtimeMs === 0) return;
			trigger(candidate.path);
		};
		watchFile(candidate.path, { interval: pollIntervalMs, persistent }, listener);
		polling.set(candidate.path, () => unwatchFile(candidate.path, listener));
	};

	if (options.poll === true) {
		for (const candidate of candidates.values()) startPolling(candidate);
	} else {
		const byDirectory = new Map<string, McpConfigCandidate[]>();
		for (const candidate of candidates.values()) {
			const directory = dirname(candidate.path);
			const group = byDirectory.get(directory);
			if (group === undefined) byDirectory.set(directory, [candidate]);
			else group.push(candidate);
		}
		for (const [directory, group] of byDirectory) {
			const byName = new Map(group.map((candidate) => [basename(candidate.path), candidate]));
			const fallback = (error: unknown): void => {
				// A directory that simply does not exist is the normal case for a standard location
				// nobody has used yet, not a failure worth reporting; polling still sees it appear.
				if (!isAbsentConfig(error)) report(error, directory);
				for (const candidate of group) startPolling(candidate);
			};
			let watcher: FSWatcher;
			try {
				// The directory itself may not exist yet (`~/.cursor` before Cursor ran once).
				watcher = watch(directory, { persistent });
			} catch (error) {
				fallback(error);
				continue;
			}
			watcher.on("change", (_event, filename) => {
				if (filename === null || filename === undefined) {
					// Some platforms omit the name; re-check every file this directory holds.
					for (const candidate of group) trigger(candidate.path);
					return;
				}
				const name = typeof filename === "string" ? filename : filename.toString("utf8");
				const candidate = byName.get(name);
				if (candidate !== undefined) trigger(candidate.path);
			});
			watcher.on("error", (error) => {
				// The directory was removed, or the platform dropped the handle: keep going by polling.
				watcher.close();
				fallback(error);
			});
			watchers.push(watcher);
		}
	}

	let closing: Promise<void> | undefined;
	return Object.freeze({
		paths: Object.freeze([...candidates.keys()]),
		close: (): Promise<void> => {
			closing ??= (async () => {
				closed = true;
				for (const timer of timers.values()) clearTimeout(timer);
				timers.clear();
				for (const watcher of watchers) {
					try {
						watcher.close();
					} catch {
						// Already closed by an error handler.
					}
				}
				watchers.length = 0;
				for (const stop of polling.values()) stop();
				polling.clear();
				await queue;
			})();
			return closing;
		},
	});
}

function watchInterval(
	value: number | undefined,
	fallback: number,
	field: string,
	minimum: number,
): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < minimum) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`watchMcpConfigs '${field}' must be a number >= ${minimum}.`,
		);
	}
	return value;
}

/** A bare path gets the documented scope meaning: under the working directory is `project`. */
function watchCandidate(path: string, options: McpConfigPathOptions): McpConfigCandidate {
	const absolute = resolve(options.cwd ?? process.cwd(), path);
	const cwd = resolve(options.cwd ?? process.cwd());
	const inside = absolute === cwd || absolute.startsWith(cwd + sep);
	return { path: absolute, scope: inside ? "project" : "global", client: "custom" };
}
