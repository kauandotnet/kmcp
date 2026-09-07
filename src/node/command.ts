import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { platform as osPlatform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";

/** The result of splitting one command line: the program and its arguments, unexpanded. */
export interface McpParsedCommandLine {
	readonly command: string;
	readonly args: readonly string[];
}

const DOUBLE_QUOTE_ESCAPES: ReadonlySet<string> = new Set(['"', "\\", "$", "`"]);

/**
 * Splits a single-string command line (`npx -y @scope/pkg --flag 'a b'`) into a command and its
 * arguments — the shape hosts that offer ONE input field store. POSIX word splitting only: single
 * quotes are literal, double quotes keep whitespace and honour `\"`, `\\`, `\$` and ``\` ``, and a
 * backslash outside quotes escapes the next character. Nothing is expanded: no globbing, no `~`,
 * no `$VAR`, no command substitution, no operators (`|`, `&&`, `>` are ordinary characters), so
 * the result is always exactly one program plus its literal arguments and is safe to hand to
 * `StdioClientTransport` (which spawns without a shell).
 *
 * @throws KmcpError `INVALID_DEFINITION` on an unbalanced quote, a trailing backslash, or a line
 * that holds no command at all.
 */
export function parseCommandLine(line: string): McpParsedCommandLine {
	if (typeof line !== "string") {
		throw new KmcpError(KMCP_ERROR_CODES.INVALID_DEFINITION, "A command line must be a string.");
	}
	const tokens: string[] = [];
	let current = "";
	// Tracked separately from `current.length`: `''` is an empty argument, not the absence of one.
	let started = false;
	let index = 0;
	const flush = () => {
		if (!started) return;
		tokens.push(current);
		current = "";
		started = false;
	};
	while (index < line.length) {
		const char = line[index] as string;
		if (char === "\\") {
			const next = line[index + 1];
			if (next === undefined) {
				throw new KmcpError(
					KMCP_ERROR_CODES.INVALID_DEFINITION,
					`Command line ends with a dangling backslash: ${JSON.stringify(line)}.`,
				);
			}
			current += next;
			started = true;
			index += 2;
			continue;
		}
		if (char === "'" || char === '"') {
			index += 1;
			started = true;
			let closed = false;
			while (index < line.length) {
				const inner = line[index] as string;
				if (inner === char) {
					closed = true;
					index += 1;
					break;
				}
				if (char === '"' && inner === "\\") {
					const next = line[index + 1];
					if (next !== undefined && DOUBLE_QUOTE_ESCAPES.has(next)) {
						current += next;
						index += 2;
						continue;
					}
				}
				current += inner;
				index += 1;
			}
			if (!closed) {
				throw new KmcpError(
					KMCP_ERROR_CODES.INVALID_DEFINITION,
					`Command line has an unbalanced ${char === '"' ? "double" : "single"} quote: ${JSON.stringify(line)}.`,
				);
			}
			continue;
		}
		if (isSpace(char)) {
			flush();
			index += 1;
			continue;
		}
		current += char;
		started = true;
		index += 1;
	}
	flush();
	const [command, ...args] = tokens;
	if (command === undefined || command.length === 0) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`Command line has no command: ${JSON.stringify(line)}.`,
		);
	}
	return Object.freeze({ command, args: Object.freeze(args) });
}

function isSpace(char: string): boolean {
	return char === " " || char === "\t" || char === "\n" || char === "\r";
}

export interface McpResolveExecutableOptions {
	/** The environment to read `PATH` (and `PATHEXT` on Windows) from. Default: `process.env`. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Base for relative paths and relative `PATH` entries. Default: `process.cwd()`. */
	readonly cwd?: string;
	/** Overrides the lookup rules (`PATH` separator, `PATHEXT`). Default: the running platform. */
	readonly platform?: NodeJS.Platform;
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Resolves what a `command` field would actually run, WITHOUT spawning anything: a bare name is
 * looked up along `PATH` (each entry must hold a file that is executable by this process; on
 * Windows the working directory is searched first and every `PATHEXT` suffix is tried), and a name
 * that already carries a path separator is checked against the filesystem and returned as written
 * (only a `PATHEXT` suffix is ever appended). Returns `undefined` when nothing matches — the answer
 * to "will this stdio entry fail with ENOENT?", which a host can ask before it connects, and never
 * a reason to throw.
 */
export async function resolveExecutable(
	command: string,
	options: McpResolveExecutableOptions = {},
): Promise<string | undefined> {
	if (typeof command !== "string" || command.length === 0) return undefined;
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const windows = (options.platform ?? osPlatform()) === "win32";
	const suffixes = executableSuffixes(command, env, windows);
	if (command.includes("/") || (windows && command.includes("\\"))) {
		for (const suffix of suffixes) {
			const candidate = command + suffix;
			const absolute = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
			// The same test as the `PATH` branch: a readable-but-not-executable file at an explicit
			// path would fail to spawn exactly as one found along `PATH` would.
			if (await isExecutableFile(absolute, windows)) return candidate;
		}
		return undefined;
	}
	const search = lookupEnv(env, "PATH", windows) ?? "";
	// Windows resolves a bare name against the working directory BEFORE `PATH` (which `cmd.exe` and
	// `CreateProcess` both do, and `which` copies); POSIX shells never do, so there a project file
	// can't shadow an installed tool.
	const entries = windows ? [cwd, ...search.split(";")] : search.split(":");
	for (const rawEntry of entries) {
		// A Windows `PATH` may quote entries that hold spaces (`"C:\Program Files\bin";C:\bin`); the
		// quotes are list syntax, not part of the directory name. `"` is a legal filename character
		// on POSIX, so nothing is stripped there.
		const entry = windows ? unquotePathEntry(rawEntry) : rawEntry;
		// An empty `PATH` entry means the working directory to a shell; treat it as noise instead,
		// so a stray `:` never makes a file in the project directory look like an installed tool.
		if (entry.length === 0) continue;
		const directory = isAbsolute(entry) ? entry : resolve(cwd, entry);
		for (const suffix of suffixes) {
			const candidate = join(directory, command + suffix);
			if (await isExecutableFile(candidate, windows)) return candidate;
		}
	}
	return undefined;
}

/** Removes one matching pair of surrounding double quotes from a `PATH` entry. */
function unquotePathEntry(entry: string): string {
	return entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"')
		? entry.slice(1, -1)
		: entry;
}

/**
 * `[""]` off Windows. On Windows every `PATHEXT` suffix the name lacks, preceded by the bare name
 * ONLY when the name already carries a `.` — the rule `which` uses. Trying `""` unconditionally
 * would let an extensionless MSYS/Git-Bash shell script named `npx` win over the `npx.cmd` that
 * Windows would actually have executed.
 */
function executableSuffixes(
	command: string,
	env: Readonly<Record<string, string | undefined>>,
	windows: boolean,
): readonly string[] {
	if (!windows) return [""];
	const configured = lookupEnv(env, "PATHEXT", windows) ?? DEFAULT_PATHEXT;
	const lower = command.toLowerCase();
	const suffixes = command.includes(".") ? [""] : [];
	for (const raw of configured.split(";")) {
		const suffix = raw.trim();
		if (suffix.length === 0) continue;
		if (lower.endsWith(suffix.toLowerCase())) continue;
		suffixes.push(suffix);
	}
	return suffixes;
}

/** Windows environment names are case-insensitive (`Path` and `PATH` are the same variable). */
function lookupEnv(
	env: Readonly<Record<string, string | undefined>>,
	name: string,
	windows: boolean,
): string | undefined {
	const direct = env[name];
	if (direct !== undefined || !windows) return direct;
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(env)) {
		if (key.toLowerCase() === wanted) return value;
	}
	return undefined;
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

async function isExecutableFile(path: string, windows: boolean): Promise<boolean> {
	if (!(await isFile(path))) return false;
	if (windows) return true;
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
