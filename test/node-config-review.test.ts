import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KMCP_ERROR_CODES, KmcpError } from "../src/index.ts";
import { type McpServersConfig, connectionsFromMcpConfig } from "../src/node.ts";

function invalidDefinition(error: unknown): boolean {
	return error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION;
}

/** Loads a one-entry config, with the entry typed loosely so bad shapes can be exercised. */
function load(entry: unknown, options?: Parameters<typeof connectionsFromMcpConfig>[1]) {
	return connectionsFromMcpConfig(
		{ mcpServers: { alpha: entry } } as unknown as McpServersConfig,
		options,
	);
}

interface StdioParams {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

/** The parameters a `StdioClientTransport` would spawn with (nothing is spawned until `start()`). */
async function stdioParams(definition: { openTransport(): unknown }): Promise<StdioParams> {
	const transport = (await definition.openTransport()) as { _serverParams: StdioParams };
	return transport._serverParams;
}

/** Just the split, without the inherited environment `getDefaultEnvironment()` layers in. */
async function stdioArgv(definition: {
	openTransport(): unknown;
}): Promise<{ command: string; args: string[] }> {
	const params = await stdioParams(definition);
	return { command: params.command, args: params.args ?? [] };
}

/** The SDK's own view of a transport's static headers (what `_commonHeaders()` will send). */
async function commonHeaders(definition: { openTransport(): unknown }): Promise<Headers> {
	const transport = (await definition.openTransport()) as {
		_commonHeaders(): Promise<Headers>;
	};
	return await transport._commonHeaders();
}

function fingerprintOf(definition: unknown): string {
	const value = (definition as { readonly fingerprint?: unknown }).fingerprint;
	assert.equal(typeof value, "string", "the definition should expose a fingerprint");
	return value as string;
}

// ---------------------------------------------------------------------------
// Substitution reaches every field, whatever the entry routes to
// ---------------------------------------------------------------------------

test("a stdio entry that still carries a url has its command, args and env substituted", async () => {
	// `type` decides the route, so a stale `url` left behind by an editor must not send the
	// substitution down the remote branch and hand the child a literal `${TOKEN}`.
	const connections = load(
		{
			type: "stdio",
			url: "https://stale.example.com/mcp",
			command: "${BIN}",
			args: ["--token", "${TOKEN}"],
			env: { API_KEY: "${TOKEN}" },
			cwd: "${HOME_DIR}/work",
		},
		{ env: { BIN: "server-bin", TOKEN: "s3cret", HOME_DIR: "/srv" } },
	);

	const params = await stdioParams(connections.alpha!);
	assert.equal(params.command, "server-bin");
	assert.deepEqual(params.args, ["--token", "s3cret"]);
	assert.equal(params.env?.API_KEY, "s3cret");
	assert.equal(params.cwd, "/srv/work");
});

test("a remote entry that still carries a command has its url and headers substituted", async () => {
	const connections = load(
		{
			type: "http",
			url: "https://${HOST}/mcp",
			// An unparseable leftover on a route that never spawns anything is not a definition error.
			command: "npx 'unbalanced ${TOKEN}",
			headers: { authorization: "Bearer ${TOKEN}" },
		},
		{ env: { HOST: "api.example.com", TOKEN: "s3cret" } },
	);

	assert.equal((await commonHeaders(connections.alpha!)).get("authorization"), "Bearer s3cret");
});

// ---------------------------------------------------------------------------
// `${env:NAME}` and the references the host owns
// ---------------------------------------------------------------------------

test("${env:NAME} resolves and host-owned references are left exactly as written", async () => {
	const missing: string[] = [];
	const connections = load(
		{
			url: "https://x.example.com/${env:STAGE}",
			headers: {
				authorization: "Bearer ${env:TOKEN}",
				"x-plain": "${TOKEN}",
				// VS Code resolves these itself; emptying them would silently produce a broken value.
				"x-input": "${input:api-key}",
				"x-command": "${command:pickPort}",
				"x-folder": "${workspaceFolder}/mcp",
				"x-home": "${userHome}",
				"x-odd": "${not a name}",
				"x-empty": "${}",
				// A name the loader does own, but that the map has no value for, still empties.
				"x-missing": "${ABSENT}",
			},
		},
		{
			env: { STAGE: "prod", TOKEN: "s3cret" },
			onMissingEnv: (name) => missing.push(name),
		},
	);

	const headers = await commonHeaders(connections.alpha!);
	assert.equal(headers.get("authorization"), "Bearer s3cret");
	assert.equal(headers.get("x-plain"), "s3cret");
	assert.equal(headers.get("x-input"), "${input:api-key}");
	assert.equal(headers.get("x-command"), "${command:pickPort}");
	assert.equal(headers.get("x-folder"), "${workspaceFolder}/mcp");
	assert.equal(headers.get("x-home"), "${userHome}");
	assert.equal(headers.get("x-odd"), "${not a name}");
	assert.equal(headers.get("x-empty"), "${}");
	assert.equal(headers.get("x-missing"), "");
	// Only the reference the loader owns is reported missing; the host's are not its business.
	assert.deepEqual(missing, ["ABSENT"]);

	const transport = (await connections.alpha!.openTransport()) as unknown as { _url: URL };
	assert.equal(transport._url.href, "https://x.example.com/prod");
});

// ---------------------------------------------------------------------------
// Splitting a single-field command line
// ---------------------------------------------------------------------------

test("a command that reads as a path is never split, before or after substitution", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kmcp my dir-"));
	const program = join(directory, "my server");
	await writeFile(program, "#!/bin/sh\nexit 0\n");

	const connections = connectionsFromMcpConfig(
		{
			mcpServers: {
				// A path that exists exactly as written is a program, spaces and all.
				onDisk: { command: program },
				// Drive-letter roots, with and without a trailing separator (which would otherwise be
				// a dangling backslash and fail the whole config).
				drive: { command: "C:\\Program Files\\MyServer\\server.exe" },
				trailing: { command: "C:\\Program Files\\MyServer\\" },
				// `\` separators and no quote to disambiguate them from POSIX escapes.
				share: { command: "\\\\share\\My Server\\srv.exe" },
				// The split is decided on the RAW string, so an expansion with spaces is not re-split.
				expanded: { command: "${PROGRAM}" },
				// A real single-field command line still splits.
				line: { command: "npx -y @scope/pkg --flag 'a b'" },
				// Quotes disambiguate, so a quoted Windows command line splits as one.
				quoted: { command: '"C:\\srv\\my server.exe" --port 8080' },
			},
		},
		{ env: { PROGRAM: program } },
	);

	assert.deepEqual(await stdioArgv(connections.onDisk), { command: program, args: [] });
	assert.deepEqual(await stdioArgv(connections.drive), {
		command: "C:\\Program Files\\MyServer\\server.exe",
		args: [],
	});
	assert.deepEqual(await stdioArgv(connections.trailing), {
		command: "C:\\Program Files\\MyServer\\",
		args: [],
	});
	assert.deepEqual(await stdioArgv(connections.share), {
		command: "\\\\share\\My Server\\srv.exe",
		args: [],
	});
	assert.deepEqual(await stdioArgv(connections.expanded), { command: program, args: [] });
	assert.deepEqual(await stdioArgv(connections.line), {
		command: "npx",
		args: ["-y", "@scope/pkg", "--flag", "a b"],
	});
	assert.deepEqual(await stdioArgv(connections.quoted), {
		command: "C:\\srv\\my server.exe",
		args: ["--port", "8080"],
	});
});

test("a ${VAR} that expands to a flag is one token, not a re-split command line", async () => {
	const connections = load(
		{ command: "server ${FLAGS}" },
		{ env: { FLAGS: "--name 'my server'" } },
	);
	// The line is split first, so the expansion lands in exactly one argument.
	assert.deepEqual(await stdioArgv(connections.alpha!), {
		command: "server",
		args: ["--name 'my server'"],
	});
});

// ---------------------------------------------------------------------------
// Field shapes
// ---------------------------------------------------------------------------

test("a config field of the wrong type is refused by name, never as a raw TypeError", () => {
	const cases: readonly (readonly [unknown, string])[] = [
		[{ command: 7 }, "command"],
		[{ url: { href: "https://x.example.com/mcp" } }, "url"],
		// Without the check a string `args` is spread into one argument per CHARACTER.
		[{ command: "node", args: "server.js" }, "args"],
		[{ command: "node", args: ["server.js", 2] }, "args"],
		[{ command: "node", env: { API_KEY: 1 } }, "env.API_KEY"],
		[{ url: "https://x.example.com/mcp", headers: ["authorization"] }, "headers"],
		[{ url: "https://x.example.com/mcp", headers: { authorization: null } }, "headers.authoriz"],
		[{ command: "node", cwd: 3 }, "cwd"],
		[{ command: "node", namespace: false }, "namespace"],
		[{ command: "node", protocolVersion: 2025 }, "protocolVersion"],
	];
	for (const [entry, field] of cases) {
		assert.throws(
			() => load(entry),
			(error: unknown) =>
				invalidDefinition(error) &&
				(error as Error).message.includes("'alpha'") &&
				(error as Error).message.includes(field),
			`expected ${JSON.stringify(entry)} to name '${field}'`,
		);
	}
	// An entry that is not an object at all is refused before anything reads a field off it.
	for (const entry of [null, "node", 7, ["node"]]) {
		assert.throws(() => load(entry), invalidDefinition, `expected ${JSON.stringify(entry)}`);
	}
});

// ---------------------------------------------------------------------------
// Transport aliases are not inherited
// ---------------------------------------------------------------------------

test("a transport type that only exists on Object.prototype is not a transport", () => {
	for (const type of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
		// Built through JSON, as a config file is: `__proto__` in an object literal would set the
		// prototype instead of becoming a key.
		const entry: unknown = JSON.parse(
			JSON.stringify({ type, url: "https://x.example.com/mcp", command: "node" }),
		);
		assert.throws(
			() => load(entry),
			(error: unknown) =>
				invalidDefinition(error) && (error as Error).message.includes("unknown type"),
			`expected type '${type}' to be refused`,
		);
	}
});

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

const FINGERPRINT_CONFIG = {
	mcpServers: {
		local: {
			type: "stdio",
			command: "node",
			args: ["server.js"],
			env: { API_KEY: "one" },
			cwd: "/srv",
			timeout: 5,
		},
		remote: {
			type: "http",
			url: "https://x.example.com/mcp",
			headers: { authorization: "Bearer one" },
			protocolVersion: "2025-11-25",
		},
	},
} as const satisfies McpServersConfig;

test("a config fingerprints identically every time it is loaded", () => {
	const first = connectionsFromMcpConfig(FINGERPRINT_CONFIG);
	const second = connectionsFromMcpConfig(FINGERPRINT_CONFIG);
	assert.equal(fingerprintOf(first.local), fingerprintOf(second.local));
	assert.equal(fingerprintOf(first.remote), fingerprintOf(second.remote));
	// A SHA-256, so nothing that went in can be read back out of it.
	assert.match(fingerprintOf(first.local), /^[0-9a-f]{64}$/);
	assert.equal(fingerprintOf(first.local).includes("one"), false);
	// Two different entries of the same config are different connections.
	assert.notEqual(fingerprintOf(first.local), fingerprintOf(first.remote));
});

test("the fingerprint ignores key order but tracks every value, secrets included", () => {
	const base = fingerprintOf(connectionsFromMcpConfig(FINGERPRINT_CONFIG).local);
	const remoteBase = fingerprintOf(connectionsFromMcpConfig(FINGERPRINT_CONFIG).remote);

	// The same fields written in another order are the same entry.
	const reordered = connectionsFromMcpConfig({
		mcpServers: {
			local: {
				cwd: "/srv",
				timeout: 5,
				env: { API_KEY: "one" },
				args: ["server.js"],
				command: "node",
				type: "stdio",
			},
		},
	} as unknown as McpServersConfig);
	assert.equal(fingerprintOf(reordered.local), base);

	// A rotated credential is a change: that is exactly why the digest covers secret values.
	const rotated = connectionsFromMcpConfig({
		mcpServers: {
			local: { ...FINGERPRINT_CONFIG.mcpServers.local, env: { API_KEY: "two" } },
			remote: {
				...FINGERPRINT_CONFIG.mcpServers.remote,
				headers: { authorization: "Bearer two" },
			},
		},
	} as unknown as McpServersConfig);
	assert.notEqual(fingerprintOf(rotated.local), base);
	assert.notEqual(fingerprintOf(rotated.remote), remoteBase);

	// So is every other field of the entry.
	for (const change of [
		{ command: "node20" },
		{ args: ["server.js", "--port", "8080"] },
		{ cwd: "/opt" },
		{ timeout: 6 },
		{ type: "stdio", transport: "stdio" },
	]) {
		const edited = connectionsFromMcpConfig({
			mcpServers: { local: { ...FINGERPRINT_CONFIG.mcpServers.local, ...change } },
		} as unknown as McpServersConfig);
		assert.notEqual(fingerprintOf(edited.local), base, JSON.stringify(change));
	}

	// And so are the loader options that shape the definition.
	assert.notEqual(
		fingerprintOf(connectionsFromMcpConfig(FINGERPRINT_CONFIG, { tags: { team: "core" } }).local),
		base,
	);
	assert.notEqual(
		fingerprintOf(
			connectionsFromMcpConfig(FINGERPRINT_CONFIG, { defaults: { keepalive: true } }).local,
		),
		base,
	);
});

test("a substituted value, not the reference, is what the fingerprint covers", () => {
	const source = {
		mcpServers: { local: { command: "node", args: ["server.js"], env: { API_KEY: "${TOKEN}" } } },
	} as const satisfies McpServersConfig;
	const withOne = fingerprintOf(connectionsFromMcpConfig(source, { env: { TOKEN: "one" } }).local);
	const withTwo = fingerprintOf(connectionsFromMcpConfig(source, { env: { TOKEN: "two" } }).local);
	const again = fingerprintOf(connectionsFromMcpConfig(source, { env: { TOKEN: "one" } }).local);

	assert.notEqual(withOne, withTwo);
	assert.equal(withOne, again);
});
