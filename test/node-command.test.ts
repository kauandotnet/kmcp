import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SSEClientTransport, StreamableHTTPClientTransport } from "../src/client.ts";
import { KMCP_ERROR_CODES, KmcpError } from "../src/index.ts";
import {
	type McpServerConfig,
	type McpServersConfig,
	connectionsFromMcpConfig,
	parseCommandLine,
	resolveExecutable,
} from "../src/node.ts";

function invalidDefinition(error: unknown): boolean {
	return error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION;
}

/** The SDK's own view of a transport's static headers (what `_commonHeaders()` will send). */
async function commonHeaders(transport: unknown): Promise<Headers> {
	return await (transport as { _commonHeaders(): Promise<Headers> })._commonHeaders();
}

/** The parameters a `StdioClientTransport` would spawn with (nothing is spawned until `start()`). */
async function stdioParams(definition: {
	openTransport(): unknown;
}): Promise<{ command: string; args?: string[]; cwd?: string }> {
	const transport = (await definition.openTransport()) as {
		_serverParams: { command: string; args?: string[]; cwd?: string };
	};
	return transport._serverParams;
}

const NOT_ROOT = process.getuid?.() !== 0;

// ---------------------------------------------------------------------------
// parseCommandLine
// ---------------------------------------------------------------------------

test("parseCommandLine splits a host's single command line POSIX-style", () => {
	assert.deepEqual(parseCommandLine("npx -y @scope/pkg --flag 'a b'"), {
		command: "npx",
		args: ["-y", "@scope/pkg", "--flag", "a b"],
	});
	// Runs of any whitespace separate words; leading and trailing whitespace is not a word.
	assert.deepEqual(parseCommandLine("  node\tserver.js \n --port  8080 "), {
		command: "node",
		args: ["server.js", "--port", "8080"],
	});
	// Quoting is per character, not per word: quoted and bare pieces concatenate.
	assert.deepEqual(parseCommandLine(`node --json="{\\"a\\": 1}" '/opt/my dir/s.js'`), {
		command: "node",
		args: ['--json={"a": 1}', "/opt/my dir/s.js"],
	});
	// Empty quotes are an empty argument, not the absence of one.
	assert.deepEqual(parseCommandLine(`cmd "" ''`), { command: "cmd", args: ["", ""] });
	// A backslash outside quotes escapes the next character; inside single quotes it is literal.
	assert.deepEqual(parseCommandLine(String.raw`my\ server 'a\b' --a\"b`), {
		command: "my server",
		args: [String.raw`a\b`, `--a"b`],
	});
});

test("parseCommandLine expands nothing and treats operators as ordinary characters", () => {
	assert.deepEqual(parseCommandLine(`server $HOME ~ *.js '$X' "\\$Y" "$Z"`), {
		command: "server",
		// No variable expansion, no `~`, no globbing: only `\$` loses its backslash inside quotes.
		args: ["$HOME", "~", "*.js", "$X", "$Y", "$Z"],
	});
	assert.deepEqual(parseCommandLine("server | tee log && echo > out"), {
		command: "server",
		args: ["|", "tee", "log", "&&", "echo", ">", "out"],
	});
});

test("parseCommandLine refuses lines it cannot split unambiguously", () => {
	for (const line of [
		"npx 'unbalanced",
		'npx "unbalanced',
		"", // nothing at all
		"   \t\n ", // whitespace only
		"''", // quotes, but no command
		"npx \\", // a dangling escape
	]) {
		assert.throws(
			() => parseCommandLine(line),
			invalidDefinition,
			`expected ${JSON.stringify(line)} to be refused`,
		);
	}
	assert.throws(() => parseCommandLine(undefined as unknown as string), invalidDefinition);
});

// ---------------------------------------------------------------------------
// resolveExecutable
// ---------------------------------------------------------------------------

test("resolveExecutable searches PATH without spawning anything", async () => {
	const first = await mkdtemp(join(tmpdir(), "kmcp-bin-"));
	const second = await mkdtemp(join(tmpdir(), "kmcp-bin-"));
	const tool = join(second, "kmcp-tool");
	await writeFile(tool, "#!/bin/sh\nexit 0\n");
	await chmod(tool, 0o755);
	const data = join(second, "kmcp-data");
	await writeFile(data, "not a program");
	await chmod(data, 0o644);
	await mkdir(join(second, "kmcp-dir"));
	const env = { PATH: `${first}:${second}` };
	const linux = { env, platform: "linux" } as const;

	assert.equal(await resolveExecutable("kmcp-tool", linux), tool);
	assert.equal(await resolveExecutable("kmcp-missing", linux), undefined);
	// A directory that happens to carry the name is not a program.
	assert.equal(await resolveExecutable("kmcp-dir", linux), undefined);
	if (NOT_ROOT) assert.equal(await resolveExecutable("kmcp-data", linux), undefined);
	assert.equal(await resolveExecutable("", linux), undefined);
	// An empty PATH entry is ignored rather than meaning "the working directory".
	assert.equal(
		await resolveExecutable("kmcp-tool", { env: { PATH: "::" }, cwd: second, platform: "linux" }),
		undefined,
	);
	// No PATH at all is simply "not found", never a throw.
	assert.equal(await resolveExecutable("kmcp-tool", { env: {}, platform: "linux" }), undefined);
});

test("resolveExecutable checks explicit paths and returns them as written", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kmcp-bin-"));
	const tool = join(directory, "kmcp-tool");
	await writeFile(tool, "#!/bin/sh\nexit 0\n");
	await chmod(tool, 0o755);
	const bare = { env: {}, platform: "linux" } as const;

	assert.equal(await resolveExecutable(tool, bare), tool);
	assert.equal(await resolveExecutable("./kmcp-tool", { ...bare, cwd: directory }), "./kmcp-tool");
	assert.equal(await resolveExecutable("./kmcp-missing", { ...bare, cwd: directory }), undefined);
	assert.equal(await resolveExecutable(join(directory, "nope"), bare), undefined);
});

test("resolveExecutable applies the executable test to an explicit path too", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kmcp-bin-"));
	const tool = join(directory, "kmcp-run");
	await writeFile(tool, "#!/bin/sh\nexit 0\n");
	await chmod(tool, 0o755);
	const data = join(directory, "kmcp-data.bat");
	await writeFile(data, "@echo off\n");
	await chmod(data, 0o644);
	const posix = { env: {}, platform: "linux" } as const;

	assert.equal(await resolveExecutable(tool, posix), tool);
	// A readable-but-not-executable file would fail to spawn just as one found along PATH would,
	// so an explicit path is held to the same test rather than only being checked for existence.
	if (NOT_ROOT) assert.equal(await resolveExecutable(data, posix), undefined);
	// Windows has no execute bit: there any file that exists is a candidate.
	assert.equal(await resolveExecutable(data, { env: {}, platform: "win32" }), data);
});

test("resolveExecutable prefers a PATHEXT match over an extensionless script on Windows", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kmcp-bin-"));
	// What an MSYS/Git-Bash install leaves behind: a shell script Windows will not execute, beside
	// the `.cmd` shim Windows actually runs.
	await writeFile(join(directory, "kmcp-npx"), "#!/bin/sh\nexit 0\n");
	await writeFile(join(directory, "kmcp-npx.CMD"), "@echo off\n");
	await writeFile(join(directory, "kmcp.tool"), "not a program\n");
	const windows = { platform: "win32", env: { PATH: directory } } as const;

	assert.equal(await resolveExecutable("kmcp-npx", windows), join(directory, "kmcp-npx.CMD"));
	// A name that already carries a `.` may still match bare, which is what `which` does.
	assert.equal(await resolveExecutable("kmcp-npx.CMD", windows), join(directory, "kmcp-npx.CMD"));
	assert.equal(await resolveExecutable("kmcp.tool", windows), join(directory, "kmcp.tool"));
});

test("resolveExecutable unquotes Windows PATH entries and searches the cwd first", async () => {
	// A space in the directory name is why a Windows PATH quotes an entry at all.
	const directory = await mkdtemp(join(tmpdir(), "kmcp bin-"));
	await writeFile(join(directory, "kmcp-tool.CMD"), "@echo off\n");
	const local = await mkdtemp(join(tmpdir(), "kmcp-cwd-"));
	await writeFile(join(local, "kmcp-tool.CMD"), "@echo off\n");
	const bystander = await mkdtemp(join(tmpdir(), "kmcp-empty-"));

	// One matching pair of surrounding quotes is list syntax, not part of the directory name.
	assert.equal(
		await resolveExecutable("kmcp-tool", {
			platform: "win32",
			env: { PATH: `"${directory}"` },
			cwd: bystander,
		}),
		join(directory, "kmcp-tool.CMD"),
	);
	// Windows resolves a bare name against the working directory before PATH.
	assert.equal(
		await resolveExecutable("kmcp-tool", {
			platform: "win32",
			env: { PATH: directory },
			cwd: local,
		}),
		join(local, "kmcp-tool.CMD"),
	);
	// POSIX never does: a file in the project directory is not an installed tool.
	const script = join(local, "kmcp-tool");
	await writeFile(script, "#!/bin/sh\nexit 0\n");
	await chmod(script, 0o755);
	assert.equal(
		await resolveExecutable("kmcp-tool", { platform: "linux", env: { PATH: "" }, cwd: local }),
		undefined,
	);
});

test("resolveExecutable applies PATHEXT and case-insensitive env names on Windows", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kmcp-bin-"));
	await writeFile(join(directory, "kmcp-tool.CMD"), "@echo off\n");
	await writeFile(join(directory, "kmcp-two.bat"), "@echo off\n");
	const windows = { platform: "win32" } as const;

	// `Path` is the same variable as `PATH` on Windows, and the default PATHEXT applies.
	assert.equal(
		await resolveExecutable("kmcp-tool", { ...windows, env: { Path: directory } }),
		join(directory, "kmcp-tool.CMD"),
	);
	// A name that already carries the extension is not extended twice.
	assert.equal(
		await resolveExecutable("kmcp-tool.CMD", { ...windows, env: { Path: directory } }),
		join(directory, "kmcp-tool.CMD"),
	);
	assert.equal(
		await resolveExecutable("kmcp-two", {
			...windows,
			env: { PATH: directory, PATHEXT: ".bat" },
		}),
		join(directory, "kmcp-two.bat"),
	);
	assert.equal(
		await resolveExecutable("kmcp-two", { ...windows, env: { PATH: directory, PATHEXT: ".exe" } }),
		undefined,
	);
	// The Windows PATH separator is `;`, so a POSIX-looking list is one (nonexistent) entry.
	assert.equal(
		await resolveExecutable("kmcp-two", {
			...windows,
			env: { PATH: `${directory}:${directory}`, PATHEXT: ".bat" },
		}),
		undefined,
	);
});

// ---------------------------------------------------------------------------
// connectionsFromMcpConfig: transport `type` routing
// ---------------------------------------------------------------------------

test("config entries route on their declared transport type", async () => {
	const connections = connectionsFromMcpConfig({
		mcpServers: {
			legacy: {
				type: "sse",
				url: "https://legacy.example.com/sse",
				headers: { "x-tenant": "acme" },
				timeout: 2,
			},
			spelled: { transport: "sse", url: "https://spelled.example.com/sse" },
			dashed: { type: "streamable-http", url: "https://dashed.example.com/mcp" },
			camel: { type: "streamableHttp", url: "https://camel.example.com/mcp" },
			local: { type: "stdio", command: "node", args: ["server.js"] },
			inferredHttp: { url: "https://inferred.example.com/mcp" },
			inferredStdio: { command: "node", args: ["server.js"] },
		},
	});

	assert.equal(connections.legacy.transportKind, "sse");
	assert.equal(connections.legacy.tags["kmcp.transport"], "sse");
	assert.equal(connections.spelled.transportKind, "sse");
	// The legacy wire negotiates the legacy era, and the entry's own timeout still applies.
	assert.deepEqual(connections.legacy.clientOptions.versionNegotiation, { mode: "legacy" });
	assert.equal(connections.legacy.defaults.timeoutMs, 2000);
	for (const id of ["dashed", "camel", "inferredHttp"] as const) {
		assert.equal(connections[id].transportKind, "streamable-http", id);
		assert.equal(connections[id].tags["kmcp.transport"], "http", id);
	}
	assert.equal(connections.local.transportKind, "stdio");
	assert.equal(connections.inferredStdio.transportKind, "stdio");

	// The routing decides which transport is actually built, and headers reach it as with http.
	const sse = await connections.legacy.openTransport();
	assert.ok(sse instanceof SSEClientTransport);
	assert.equal((await commonHeaders(sse)).get("x-tenant"), "acme");
	assert.ok((await connections.dashed.openTransport()) instanceof StreamableHTTPClientTransport);
});

test("an unknown or contradictory transport type is refused at definition time", () => {
	const load = (entry: unknown) =>
		connectionsFromMcpConfig({ mcpServers: { alpha: entry } } as unknown as McpServersConfig);

	assert.throws(
		() => load({ type: "websocket", url: "https://x.example.com/mcp" }),
		(error: unknown) =>
			invalidDefinition(error) &&
			/'alpha'/.test((error as Error).message) &&
			/'websocket'/.test((error as Error).message),
	);
	assert.throws(() => load({ transport: "grpc", command: "node" }), invalidDefinition);
	assert.throws(() => load({ type: 7, url: "https://x.example.com/mcp" }), invalidDefinition);
	// A type that contradicts the entry's own fields.
	assert.throws(() => load({ type: "stdio", url: "https://x.example.com/mcp" }), invalidDefinition);
	assert.throws(() => load({ type: "http", command: "node" }), invalidDefinition);
	assert.throws(() => load({ type: "sse", command: "node" }), invalidDefinition);
	// `type` and `transport` must agree when both are present.
	assert.throws(
		() => load({ type: "http", transport: "sse", url: "https://x.example.com/mcp" }),
		invalidDefinition,
	);
	// The legacy wire is legacy-era only, so pinning a revision on it is a contradiction too.
	assert.throws(
		() => load({ type: "sse", url: "https://x.example.com/sse", protocolVersion: "2025-11-25" }),
		invalidDefinition,
	);

	// Agreeing spellings, a value in another case, and an entry that carries both fields but says
	// which one to use, are all fine.
	const ok = connectionsFromMcpConfig({
		mcpServers: {
			agreed: { type: "streamable-http", transport: "http", url: "https://a.example.com/mcp" },
			both: {
				type: "stdio",
				command: "node",
				url: "https://b.example.com/mcp",
			} as unknown as McpServerConfig,
			shouted: { type: "HTTP", url: "https://c.example.com/mcp" } as unknown as McpServerConfig,
		},
	});
	assert.equal(ok.agreed.transportKind, "streamable-http");
	assert.equal(ok.both.transportKind, "stdio");
	assert.equal(ok.shouted.transportKind, "streamable-http");
});

// ---------------------------------------------------------------------------
// connectionsFromMcpConfig: single-field command lines
// ---------------------------------------------------------------------------

test("a config command with whitespace and no args is parsed as one command line", async () => {
	const connections = connectionsFromMcpConfig({
		mcpServers: {
			single: { command: "npx -y @scope/pkg --flag 'a b'" },
			quoted: { command: `'/opt/my dir/server' --port 8080` },
			// An explicit `args` field — even empty — means `command` is a program name.
			spaced: { command: "/opt/my dir/server", args: [] },
			listed: { command: "node", args: ["server.js"] },
			bare: { command: "server-bin" },
		},
	});

	const single = await stdioParams(connections.single);
	assert.equal(single.command, "npx");
	assert.deepEqual(single.args, ["-y", "@scope/pkg", "--flag", "a b"]);
	assert.deepEqual((await stdioParams(connections.quoted)).command, "/opt/my dir/server");
	assert.deepEqual((await stdioParams(connections.quoted)).args, ["--port", "8080"]);
	assert.deepEqual((await stdioParams(connections.spaced)).command, "/opt/my dir/server");
	assert.deepEqual((await stdioParams(connections.spaced)).args, []);
	assert.deepEqual((await stdioParams(connections.listed)).args, ["server.js"]);
	assert.deepEqual((await stdioParams(connections.bare)).command, "server-bin");
});

test("an unparseable single-field command names the entry it came from", () => {
	assert.throws(
		() => connectionsFromMcpConfig({ mcpServers: { alpha: { command: "npx 'unbalanced" } } }),
		(error: unknown) =>
			invalidDefinition(error) &&
			/'alpha'/.test((error as Error).message) &&
			error instanceof KmcpError &&
			error.cause instanceof KmcpError,
	);
	// Substitution happens first, so the split sees the expanded value.
	const connections = connectionsFromMcpConfig(
		{ mcpServers: { alpha: { command: "${BIN} --flag" } } },
		{ env: { BIN: "server-bin" } },
	);
	assert.equal(connections.alpha.transportKind, "stdio");
});
