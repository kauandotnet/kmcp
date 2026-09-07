import { createHash } from "node:crypto";
import {
	type FSWatcher,
	type Stats,
	existsSync,
	readFileSync,
	statSync,
	unwatchFile,
	watch,
	watchFile,
} from "node:fs";
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
import { type McpParsedCommandLine, parseCommandLine } from "./command.ts";

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
	 *
	 * The split is decided on the string AS WRITTEN, before `${…}` substitution, and a value that
	 * reads as a path is left whole: one that exists on disk (`/Applications/My App/bin/srv`), one
	 * rooted at a drive letter (`C:\Program Files\MyServer\server.exe`), or one using `\`
	 * separators without quotes. An expanded `${VAR}` is therefore never re-split.
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
	 * Substitute `${NAME}` and VS Code's `${env:NAME}` references in every string field of an entry
	 * (`url`, `command`, `args`, `env`, `headers`, `cwd`) from this map (pass `process.env` to use
	 * the process environment). Off when absent: config values are taken literally.
	 *
	 * Only those two spellings are the loader's to expand. A reference the HOST owns —
	 * `${input:api-key}`, `${command:…}`, `${config:…}`, `${workspaceFolder}` and the rest of VS
	 * Code's predefined variables — is left exactly as written rather than collapsing to an empty
	 * string, and never reaches `onMissingEnv`.
	 */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/**
	 * Observes a `${NAME}` (or `${env:NAME}`, reported as the bare `NAME`) whose variable is absent;
	 * the reference becomes an empty string.
	 */
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
 *
 * Every definition carries a `fingerprint`: a SHA-256 over the entry as loaded plus the loader
 * options that shape it, so a host that re-reads a config file can tell an untouched entry from an
 * edited one (a rotated token included) without comparing definitions field by field.
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
		assertEntryShape(rawEntry, id);
		// Routing is decided on the RAW entry: which fields are present never depends on what
		// `${…}` expands to, and the command split below has to see the pre-substitution string.
		const transportType = entryTransportType(rawEntry, id);
		const entry = substituteEntry(rawEntry, id, transportType, options);
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
			fingerprint: entryFingerprint(entry, options),
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
		if (transportType === "stdio") {
			const stdio = entry as McpStdioServerConfig;
			result[id] = stdioConnection({
				...base,
				...pin,
				tags: tagsFor("stdio"),
				stdio: {
					// `substituteEntry` already split and expanded the command line, so this is a
					// pass-through; the identity substitute keeps the split rule in one place.
					...entryCommand(stdio, id, identity),
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

// A Map, not an object: a plain record resolves `type: "constructor"` and `type: "__proto__"`
// through `Object.prototype` and would route a config entry to a transport nobody named.
const TRANSPORT_ALIASES: ReadonlyMap<string, McpConfigTransport> = new Map<
	string,
	McpConfigTransport
>([
	["stdio", "stdio"],
	["http", "http"],
	["streamable-http", "http"],
	["streamablehttp", "http"],
	["streamable_http", "http"],
	["sse", "sse"],
]);

/** Entry fields that must be a plain string when present. */
const ENTRY_STRING_FIELDS = ["command", "url", "cwd", "namespace", "protocolVersion"] as const;
/** Entry fields that must be an object whose every value is a string when present. */
const ENTRY_RECORD_FIELDS = ["env", "headers"] as const;

function invalidEntryField(id: string, field: string, expected: string): KmcpError {
	return new KmcpError(
		KMCP_ERROR_CODES.INVALID_DEFINITION,
		`Config entry '${id}' has an invalid '${field}': expected ${expected}.`,
	);
}

/**
 * Checks one entry's field shapes up front, naming the entry and the field. Config files are
 * hand-written JSON, so the wrong type is ordinary; without this a number `command` escapes as a
 * raw `TypeError` from `String.prototype.replace` and a string `args` is spread into one argument
 * per CHARACTER. `type`/`transport` are validated where they are resolved, `timeout` where it is
 * converted.
 */
function assertEntryShape(entry: unknown, id: string): void {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`Config entry '${id}' must be an object.`,
		);
	}
	const record = entry as Record<string, unknown>;
	for (const field of ENTRY_STRING_FIELDS) {
		const value = record[field];
		if (value !== undefined && typeof value !== "string") {
			throw invalidEntryField(id, field, "a string");
		}
	}
	const args = record.args;
	if (args !== undefined && (!Array.isArray(args) || args.some((v) => typeof v !== "string"))) {
		throw invalidEntryField(id, "args", "an array of strings");
	}
	for (const field of ENTRY_RECORD_FIELDS) {
		const value = record[field];
		if (value === undefined) continue;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw invalidEntryField(id, field, "an object of strings");
		}
		for (const [key, item] of Object.entries(value)) {
			if (typeof item !== "string") throw invalidEntryField(id, `${field}.${key}`, "a string");
		}
	}
}

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
		const kind = TRANSPORT_ALIASES.get(value.trim().toLowerCase());
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

/** `C:\srv\server.exe`, `D:/srv/server.exe` — a drive-letter root. */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * Whether a `command` that carries whitespace is ONE command line to split, or one program whose
 * path merely holds spaces. Decided on the RAW, pre-substitution string, so a `${VAR}` that expands
 * to `/Applications/My App/bin/srv` is never re-split by the expansion.
 *
 * Three shapes are read as a path and left whole: one that exists on disk exactly as written, one
 * rooted at a drive letter, and one that uses `\` separators without any quote to disambiguate
 * them from the POSIX escapes `parseCommandLine` would see (which also keeps a trailing `C:\srv\`
 * from failing the whole config).
 */
function looksLikeCommandLine(raw: string): boolean {
	if (!/\s/.test(raw)) return false;
	if (existsSync(raw)) return false;
	if (WINDOWS_DRIVE_PATH.test(raw)) return false;
	if (raw.includes("\\") && !raw.includes('"') && !raw.includes("'")) return false;
	return true;
}

const identity = (value: string): string => value;

/**
 * The `command`/`args` pair to spawn, with `substitute` applied to each token AFTER the split so an
 * expanded value is never re-split. A `command` that holds whitespace and comes WITHOUT `args` is
 * one command line (hosts with a single input field store it that way) unless it reads as a path
 * (see {@link looksLikeCommandLine}). Any `args` field — including `[]` — means the command is a
 * program name and is passed through verbatim.
 */
function entryCommand(
	entry: McpStdioServerConfig,
	id: string,
	substitute: (value: string) => string,
): { command: string; args: string[] } {
	const raw = entry.command;
	if (typeof raw !== "string" || raw.length === 0) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`Config entry '${id}' must have a 'command' or a 'url'.`,
		);
	}
	if (entry.args !== undefined) {
		return { command: substitute(raw), args: entry.args.map(substitute) };
	}
	if (!looksLikeCommandLine(raw)) return { command: substitute(raw), args: [] };
	let parsed: McpParsedCommandLine;
	try {
		parsed = parseCommandLine(raw);
	} catch (error) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`Config entry '${id}' has an unparseable 'command': ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ cause: error },
		);
	}
	return { command: substitute(parsed.command), args: parsed.args.map(substitute) };
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

const ENV_REFERENCE = /\$\{([^{}]*)\}/g;
/** VS Code spells an environment lookup `${env:NAME}`; the prefix is not part of the name. */
const ENV_REFERENCE_PREFIX = "env:";
const ENV_REFERENCE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * VS Code's predefined `${…}` variables. They belong to the HOST that owns the workspace, so the
 * loader leaves them exactly as written instead of resolving them to an empty string.
 */
const HOST_VARIABLES: ReadonlySet<string> = new Set([
	"cwd",
	"defaultBuildTask",
	"execPath",
	"file",
	"fileBasename",
	"fileBasenameNoExtension",
	"fileDirname",
	"fileExtname",
	"fileWorkspaceFolder",
	"lineNumber",
	"pathSeparator",
	"relativeFile",
	"relativeFileDirname",
	"selectedText",
	"userHome",
	"workspaceFolder",
	"workspaceFolderBasename",
]);

/**
 * The environment variable a `${…}` body names, or `undefined` when the reference is not the
 * loader's to expand: a `name:`-prefixed reference some host resolves (`${input:api-key}`,
 * `${command:pickPort}`), one of {@link HOST_VARIABLES}, or a body that is not a variable name at
 * all. Those are returned untouched rather than emptied, and never reported as missing.
 */
function envReferenceName(body: string): string | undefined {
	if (body.startsWith(ENV_REFERENCE_PREFIX)) {
		const name = body.slice(ENV_REFERENCE_PREFIX.length);
		return name.length === 0 ? undefined : name;
	}
	if (!ENV_REFERENCE_NAME.test(body) || HOST_VARIABLES.has(body)) return undefined;
	return body;
}

/**
 * Expands `${NAME}`/`${env:NAME}` in every VALUE-bearing field of an entry — `url`, `cwd`,
 * `headers`, `env`, `command` and `args`. Routing never decides which fields are substituted, so a
 * `type: "stdio"` entry that still carries a stale `url` gets its `command`, `args` and `env`
 * expanded all the same instead of handing the child a literal `${TOKEN}`. (`namespace`, `type` and
 * `transport` are identifiers the loader reads, not values, and are taken as written.) The stdio
 * command line is split before its tokens are substituted; see {@link entryCommand}.
 */
function substituteEntry(
	entry: McpServerConfig,
	id: string,
	transportType: McpConfigTransport,
	options: McpConfigLoaderOptions,
): McpServerConfig {
	const env = options.env;
	const substitute =
		env === undefined
			? identity
			: (value: string): string =>
					value.replace(ENV_REFERENCE, (match: string, body: string) => {
						const name = envReferenceName(body);
						if (name === undefined) return match;
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
	const next = { ...entry } as Record<string, unknown>;
	for (const field of ["url", "cwd"] as const) {
		const value = next[field];
		if (typeof value === "string") next[field] = substitute(value);
	}
	for (const field of ENTRY_RECORD_FIELDS) {
		const record = substituteRecord(next[field] as Readonly<Record<string, string>> | undefined);
		if (record !== undefined) next[field] = record;
	}
	if (typeof next.command === "string") {
		if (transportType === "stdio") {
			const command = entryCommand(entry as McpStdioServerConfig, id, substitute);
			next.command = command.command;
			next.args = command.args;
		} else {
			// A leftover `command` on a remote entry is not what gets spawned, so it is expanded but
			// never split: splitting could only fail on a value nothing will run.
			next.command = substitute(next.command);
			if (Array.isArray(next.args)) next.args = (next.args as readonly string[]).map(substitute);
		}
	}
	return next as unknown as McpServerConfig;
}

/**
 * A SHA-256 over the canonical JSON of one loaded entry — every field, keys sorted, values as they
 * stand AFTER substitution — together with the loader options that shape the definition
 * (`defaults`, `tags`). Reloading the same config produces the same digest, so a manager's
 * `reconcile` can tell an untouched entry from an edited one without diffing live closures.
 *
 * The digest deliberately covers SECRET values (`env`, `headers`, a token inside a `url`): a
 * rotated credential MUST count as a change. SHA-256 is one-way and never reversible, so the digest
 * reveals nothing about what went into it and is safe to expose, log and compare. Values JSON
 * cannot carry (the callbacks a `defaults` may hold) contribute nothing.
 */
function entryFingerprint(entry: McpServerConfig, options: McpConfigLoaderOptions): string {
	const shape = canonicalJson({ entry, defaults: options.defaults, tags: options.tags });
	return createHash("sha256").update(shape).digest("hex");
}

/** JSON with object keys sorted, so the key order a config file happens to use never matters. */
function canonicalJson(value: unknown, seen: Set<object> = new Set()): string {
	if (typeof value === "bigint") return JSON.stringify(value.toString());
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (seen.has(value)) return '"[circular]"';
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
		}
		const record = value as Record<string, unknown>;
		const fields: string[] = [];
		for (const key of Object.keys(record).sort()) {
			const item = record[key];
			if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
			fields.push(`${JSON.stringify(key)}:${canonicalJson(item, seen)}`);
		}
		return `{${fields.join(",")}}`;
	} finally {
		seen.delete(value);
	}
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
	/**
	 * Passed to {@link standardMcpConfigPaths} when `paths` is omitted; `cwd` also resolves the
	 * relative paths (and relative candidates) given in `paths`.
	 */
	readonly pathOptions?: McpConfigPathOptions;
	/**
	 * Called once per settled change, per path, and only when the file's BYTES actually differ from
	 * what was last delivered (see {@link McpConfigWatchOptions.initial}). Exceptions are routed to
	 * `onError`.
	 */
	readonly onChange: (change: McpConfigChange) => void;
	/**
	 * Deliver each watched path's CURRENT content once at start, before any change. Default:
	 * `false` — the watcher records what each file holds at start and stays silent until the
	 * content differs from that, so a host that has already loaded its configs is not handed them
	 * again.
	 */
	readonly initial?: boolean;
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

/** Stands in for "there is no file at this path"; no hex digest can collide with it. */
const ABSENT_DIGEST = "absent";

function digestOf(raw: string): string {
	return createHash("sha256").update(raw).digest("hex");
}

/** The digest of a file's current content, or `undefined` when it cannot be read at all. */
function digestOfFileSync(path: string): string | undefined {
	try {
		return digestOf(readFileSync(path, "utf8"));
	} catch (error) {
		return isAbsentConfig(error) ? ABSENT_DIGEST : undefined;
	}
}

/**
 * `dev:ino` for a directory — its identity on disk, which survives a rename but not a delete and
 * recreate. `undefined` when the path is gone or is no longer a directory.
 */
function directoryIdentity(path: string): string | undefined {
	try {
		const stats = statSync(path, { bigint: true });
		return stats.isDirectory() ? `${stats.dev}:${stats.ino}` : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Watches MCP config files and reports each settled change with the freshly parsed content, so a
 * long-lived host can pick up a server the user just added in another app without a restart.
 *
 * Watching happens on each file's PARENT directory (`fs.watch`), which is what makes creation,
 * deletion and the write-to-temp-then-rename editors do observable; a platform where that throws
 * (or fails later, or has its directory deleted out from under it) falls back to `fs.watchFile`
 * polling for the affected files. Only `node:fs` is used — no watcher dependency, no recursive
 * watching, and no directory is walked.
 *
 * Changes are content-addressed: each path's raw bytes are hashed (SHA-256) and a rewrite that
 * produces identical content is NOT reported. Hosts rewrite these files constantly (Claude Code
 * rewrites `~/.claude.json` on almost every interaction) and macOS replays pre-watch events, so
 * without that a host would rebuild its connections over and over for nothing. The hashes are
 * primed at start, so nothing is delivered until the content actually changes; pass
 * `initial: true` to receive each file's current content once up front.
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
				: // A candidate's own path is resolved against the SAME base as a bare string's, so
					// `pathOptions.cwd` scopes both (a test cwd must not fall through to the process's).
					{ ...source, path: resolve(pathOptions.cwd ?? process.cwd(), source.path) };
		if (candidate.path.length === 0) continue;
		candidates.set(candidate.path, Object.freeze(candidate));
	}

	const timers = new Map<string, NodeJS.Timeout>();
	const watchers = new Set<FSWatcher>();
	const polling = new Map<string, () => void>();
	// The SHA-256 of the raw text last DELIVERED for each path (or `ABSENT_DIGEST` for "no file
	// here"), so byte-identical rewrites and replayed events are dropped instead of republished.
	const digests = new Map<string, string>();
	if (options.initial !== true) {
		// Primed BEFORE any watcher is armed (and synchronously, so no edit can slip into the gap):
		// the watch starts from what the files hold now and stays quiet until that changes.
		for (const path of candidates.keys()) {
			const digest = digestOfFileSync(path);
			if (digest !== undefined) digests.set(path, digest);
		}
	}
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
				if (digests.get(candidate.path) === ABSENT_DIGEST) return;
				digests.set(candidate.path, ABSENT_DIGEST);
				deliver({ path: candidate.path, configs: Object.freeze([]) });
				return;
			}
			// A real access failure leaves the recorded digest alone, so a retry still reports.
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
		const digest = digestOf(raw);
		// Identical bytes are the same config: hosts rewrite these files constantly, and macOS
		// replays events that predate the watch. The digest is recorded even for content that turns
		// out to be broken, so one bad file is reported once rather than on every rewrite of it.
		if (digests.get(candidate.path) === digest) return;
		digests.set(candidate.path, digest);
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
			// The name the directory itself is reported under when it is the thing that changed.
			const selfName = basename(directory);
			// The `dev:ino` the live handle was opened on, so a directory that was replaced (deleted
			// and recreated) is recognized as a different one rather than trusted.
			let identity: string | undefined;
			let live: FSWatcher | undefined;

			const drop = (watcher: FSWatcher): void => {
				watchers.delete(watcher);
				try {
					watcher.close();
				} catch {
					// Already closed.
				}
				if (live === watcher) live = undefined;
			};
			const fallback = (error: unknown): void => {
				// A directory that simply does not exist is the normal case for a standard location
				// nobody has used yet, not a failure worth reporting; polling still sees it appear.
				if (!isAbsentConfig(error)) report(error, directory);
				for (const candidate of group) startPolling(candidate);
			};
			/**
			 * `fs.watch` keeps reporting on the directory it opened, so a deleted or replaced
			 * directory leaves a handle that is alive but watches nothing. Linux announces that as an
			 * ordinary `'change'` naming the directory itself (never as an `'error'`), so every such
			 * event re-stats the path: same inode, nothing to do; gone, poll (which also sees it come
			 * back); replaced, re-watch the directory that is there now.
			 */
			const recheck = (watcher: FSWatcher): void => {
				if (closed || live !== watcher) return;
				const current = directoryIdentity(directory);
				if (current !== undefined && current === identity) return;
				drop(watcher);
				for (const candidate of group) trigger(candidate.path);
				if (current === undefined) {
					for (const candidate of group) startPolling(candidate);
					return;
				}
				open();
			};
			function open(): void {
				if (closed) return;
				let watcher: FSWatcher;
				try {
					// The directory itself may not exist yet (`~/.cursor` before Cursor ran once).
					watcher = watch(directory, { persistent });
				} catch (error) {
					fallback(error);
					return;
				}
				live = watcher;
				identity = directoryIdentity(directory);
				watcher.on("change", (_event, filename) => {
					if (live !== watcher) return;
					const name =
						filename === null || filename === undefined
							? undefined
							: typeof filename === "string"
								? filename
								: filename.toString("utf8");
					if (name === undefined || name === selfName) recheck(watcher);
					if (name === undefined) {
						// Some platforms omit the name; re-check every file this directory holds.
						for (const candidate of group) trigger(candidate.path);
						return;
					}
					const candidate = byName.get(name);
					if (candidate !== undefined) trigger(candidate.path);
				});
				watcher.on("error", (error) => {
					// The directory was removed, or the platform dropped the handle: keep going by
					// polling.
					drop(watcher);
					fallback(error);
				});
				watchers.add(watcher);
			}
			open();
		}
	}

	if (options.initial === true) {
		// The host asked for the current content: deliver it once, which records the digests too, so
		// the rewrites that follow are compared against what was actually handed over.
		queue = queue.then(async () => {
			for (const candidate of candidates.values()) {
				try {
					await emit(candidate);
				} catch (error) {
					report(error, candidate.path);
				}
			}
		});
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
				watchers.clear();
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
