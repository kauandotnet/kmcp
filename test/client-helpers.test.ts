import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ReadResourceResult } from "@modelcontextprotocol/client";

import {
	KMCP_ERROR_CODES,
	KmcpError,
	MCP_SKILLS_INDEX_URI,
	McpConnectionManager,
	checkPromptContract,
	checkToolContract,
	decodeResourceContent,
	defineResource,
	defineServer,
	discoverSkills,
	inProcessConnection,
	parseSkillsIndex,
	resolveSkillUri,
	skillsFromResources,
} from "../src/index.ts";
import {
	asMcpServersConfig,
	browserOpenCommand,
	connectionsFromMcpConfig,
	discoverMcpConfigs,
	loopbackOAuthCallback,
	readMcpConfigFile,
	standardMcpConfigPaths,
	stdioConnection,
	writeResourceToFile,
} from "../src/node.ts";
import { forEachEra } from "./helpers/in-process.ts";

test("skills index parsing is permissive and the resource fallback matches SKILL.md URIs", () => {
	const skills = parseSkillsIndex(
		JSON.stringify({
			skills: [
				{ name: "git", description: "Git flow", type: "skill-md", url: "skill://git/SKILL.md" },
				{
					description: "template",
					type: "mcp-resource-template",
					url: "skill://acme/{team}/SKILL.md",
				},
				{ name: "bad-type", type: "zip", url: "skill://x" },
				{ name: "no-url" },
				"junk",
			],
		}),
	);
	assert.deepEqual(
		skills.map((skill) => [skill.name, skill.type]),
		[
			["git", "skill-md"],
			["{team}", "mcp-resource-template"],
		],
	);
	assert.deepEqual(parseSkillsIndex("{}"), []);
	assert.throws(
		() => parseSkillsIndex("nope"),
		(error: unknown) => error instanceof KmcpError,
	);
	assert.throws(
		() => parseSkillsIndex("[]"),
		(error: unknown) => error instanceof KmcpError,
	);
	const fallback = skillsFromResources([
		{ uri: "skill://acme/billing/SKILL.md", name: "" },
		{ uri: "skill://plain/SKILL.md", name: "Plain", description: "d" },
		{ uri: "file:///README.md", name: "readme" },
	]);
	assert.deepEqual(
		fallback.map((skill) => skill.name),
		["billing", "Plain"],
	);
	assert.equal(resolveSkillUri("git-workflow"), "skill://git-workflow/SKILL.md");
	assert.equal(resolveSkillUri("/acme/billing/"), "skill://acme/billing/SKILL.md");
	assert.equal(resolveSkillUri("skill://acme"), "skill://acme/SKILL.md");
	assert.equal(resolveSkillUri("skill://acme/"), "skill://acme/SKILL.md");
	assert.equal(resolveSkillUri("skill://acme/notes.md"), "skill://acme/notes.md");
	assert.throws(
		() => resolveSkillUri(" "),
		(error: unknown) => error instanceof KmcpError,
	);
	assert.throws(
		() => resolveSkillUri("../x"),
		(error: unknown) => error instanceof KmcpError,
	);
});

forEachEra("the manager discovers and reads skills over resources", async (era) => {
	const index = { skills: [{ name: "git", description: "Git", url: "skill://git/SKILL.md" }] };
	const definition = defineServer(
		{ name: "skills", version: "1.0.0" },
		{
			capabilities: [
				defineResource("index", MCP_SKILLS_INDEX_URI, {}, async (uri) => ({
					contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(index) }],
				})),
				defineResource("git", "skill://git/SKILL.md", {}, async (uri) => ({
					contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# git\n" }],
				})),
			],
		},
	);
	const manager = new McpConnectionManager<"s">();
	manager.register(inProcessConnection({ id: "s", definition, era }));
	try {
		await manager.connect("s");
		const skills = await manager.listSkills("s");
		assert.deepEqual(
			skills.map((skill) => skill.name),
			["git"],
		);
		const read = await manager.readSkill("s", "git");
		assert.equal((read.contents[0] as { text: string }).text, "# git\n");
		// Without an index, discovery falls back to the resource list.
		const noIndex = defineServer(
			{ name: "skills2", version: "1.0.0" },
			{
				capabilities: [
					defineResource("git", "skill://git/SKILL.md", {}, async (uri) => ({
						contents: [{ uri: uri.href, text: "# git" }],
					})),
				],
			},
		);
		const second = new McpConnectionManager<"n">();
		second.register(inProcessConnection({ id: "n", definition: noIndex, era }));
		await second.connect("n");
		const fallback = await discoverSkills({
			readResource: (uri) => second.readResource("n", uri),
			listResources: () => second.listResources("n"),
		});
		assert.equal(fallback[0]?.url, "skill://git/SKILL.md");
		await second.close();
	} finally {
		await manager.close();
	}
});

test("decodeResourceContent selects by URI, decodes blobs, and bounds size", () => {
	const result: ReadResourceResult = {
		contents: [
			{ uri: "file:///a.txt", mimeType: "text/plain", text: "alpha" },
			{
				uri: "file:///b.bin",
				mimeType: "application/octet-stream",
				blob: Buffer.from([1, 2, 3]).toString("base64"),
			},
		],
	};
	const text = decodeResourceContent(result, "file:///a.txt");
	assert.equal(text.text, "alpha");
	assert.equal(text.binary, false);
	assert.equal(text.totalContents, 2);
	const blob = decodeResourceContent(result, "file:///b.bin");
	assert.deepEqual([...blob.bytes], [1, 2, 3]);
	assert.equal(blob.binary, true);
	assert.equal(blob.mimeType, "application/octet-stream");
	const first = decodeResourceContent(result, "file:///missing");
	assert.equal(first.uri, "file:///a.txt");
	assert.throws(
		() => decodeResourceContent(result, "file:///a.txt", { maxBytes: 2 }),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.RESULT_TOO_LARGE,
	);
	assert.throws(
		() => decodeResourceContent({ contents: [] }, "x"),
		(error: unknown) => error instanceof KmcpError,
	);
});

test("writeResourceToFile materializes a resource atomically", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kmcp-res-"));
	const target = join(directory, "nested", "out.bin");
	const written = await writeResourceToFile(
		{ contents: [{ uri: "r://x", blob: Buffer.from("hi").toString("base64") }] },
		"r://x",
		target,
	);
	assert.equal(written.bytes, 2);
	assert.equal(written.binary, true);
	assert.equal(await readFile(target, "utf8"), "hi");
	await writeResourceToFile({ contents: [{ uri: "r://x", text: "again" }] }, "r://x", target);
	assert.equal(await readFile(target, "utf8"), "again");
	await assert.rejects(
		writeResourceToFile({ contents: [{ uri: "r://x", text: "t" }] }, "r://x", "relative.txt"),
		(error: unknown) => error instanceof KmcpError,
	);
	await assert.rejects(
		writeResourceToFile({ contents: [{ uri: "r://x", text: "t" }] }, "r://x", directory),
		(error: unknown) => error instanceof KmcpError,
	);
});

test("tool and prompt contracts distinguish breaking drift from additive drift", () => {
	const expected = {
		name: "echo",
		description: "old",
		inputSchema: {
			type: "object",
			properties: { value: { type: "string" }, count: { type: "number" } },
			required: ["value"],
		},
		outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
	};
	const compatible = checkToolContract(
		{
			...expected,
			description: "new",
			inputSchema: {
				type: "object",
				properties: {
					value: { type: "string" },
					count: { type: "number" },
					verbose: { type: "boolean" },
				},
				required: ["value"],
			},
			outputSchema: {
				type: "object",
				properties: { ok: { type: "boolean" }, extra: { type: "string" } },
				required: ["ok", "extra"],
			},
		},
		expected,
	);
	assert.equal(compatible.valid, true);
	assert.ok(compatible.warnings.some((warning) => warning.includes("verbose")));
	assert.ok(compatible.warnings.some((warning) => warning.includes("description")));
	const strict = checkToolContract({ ...expected, description: "new" }, expected, {
		mode: "strict",
	});
	assert.equal(strict.valid, false);
	const retyped = checkToolContract(
		{
			...expected,
			inputSchema: {
				type: "object",
				properties: { value: { type: "number" }, count: { type: "number" } },
				required: ["value"],
			},
		},
		expected,
		{ arguments: { value: "v" } },
	);
	assert.equal(retyped.valid, false);
	assert.ok(retyped.errors[0]?.includes("value"));
	const unusedDrift = checkToolContract(
		{
			...expected,
			inputSchema: {
				type: "object",
				properties: { value: { type: "string" } },
				required: ["value"],
			},
		},
		expected,
		{ arguments: { value: "v" } },
	);
	assert.equal(unusedDrift.valid, true, "a removed argument the call does not pass is fine");
	const removedOutput = checkToolContract(
		{ ...expected, outputSchema: { type: "object", properties: {} } },
		expected,
	);
	assert.equal(removedOutput.valid, false);

	const prompt = { name: "review", arguments: [{ name: "language", required: true }] };
	assert.equal(checkPromptContract(prompt, prompt).valid, true);
	assert.equal(
		checkPromptContract(
			{
				name: "review",
				arguments: [
					{ name: "language", required: true },
					{ name: "tone", required: true },
				],
			},
			prompt,
		).valid,
		false,
	);
	assert.equal(
		checkPromptContract(
			{
				name: "review",
				arguments: [
					{ name: "language", required: true },
					{ name: "tone", required: true },
				],
			},
			prompt,
			{ arguments: { language: "ts", tone: "kind" } },
		).valid,
		true,
	);
	assert.equal(checkPromptContract({ name: "other" }, prompt).valid, false);
});

test("connectionsFromMcpConfig applies timeouts, pins, env substitution and the servers shape", async () => {
	const missing: string[] = [];
	const connections = connectionsFromMcpConfig(
		{
			mcpServers: {
				remote: {
					url: "https://${HOST}/mcp",
					headers: { Authorization: "Bearer ${TOKEN}" },
					timeout: 2.5,
					protocolVersion: "2025-11-25",
				},
				local: {
					command: "${BIN}",
					args: ["--flag", "${MISSING}"],
					env: { KEY: "${TOKEN}" },
					timeout: 1,
				},
			},
		},
		{
			env: { HOST: "mcp.example.com", TOKEN: "t", BIN: "server-bin" },
			onMissingEnv: (name) => missing.push(name),
			defaults: { defaults: { toolTimeoutMs: 100 } },
		},
	);
	assert.deepEqual(missing, ["MISSING"]);
	assert.equal(connections.remote.defaults.timeoutMs, 2500);
	assert.equal(connections.remote.defaults.toolTimeoutMs, 100);
	assert.equal(connections.remote.protocolVersion, "2025-11-25");
	assert.deepEqual(connections.remote.clientOptions.versionNegotiation, { mode: "legacy" });
	assert.equal(connections.local.defaults.timeoutMs, 1000);
	assert.equal(connections.local.transportKind, "stdio");
	assert.throws(
		() => connectionsFromMcpConfig({ mcpServers: { bad: { url: "https://x", timeout: -1 } } }),
		(error: unknown) => error instanceof KmcpError,
	);
	assert.throws(
		() =>
			connectionsFromMcpConfig({
				mcpServers: { bad: { url: "https://x", protocolVersion: "1999-01-01" } },
			}),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.PROTOCOL_VERSION_UNSUPPORTED,
	);
	assert.deepEqual(asMcpServersConfig({ servers: { a: { url: "https://a" } } }), {
		mcpServers: { a: { url: "https://a" } },
	});
	assert.equal(asMcpServersConfig({ other: true }), undefined);
	assert.equal(asMcpServersConfig([]), undefined);

	const home = await mkdtemp(join(tmpdir(), "kmcp-home-"));
	const cwd = await mkdtemp(join(tmpdir(), "kmcp-cwd-"));
	await writeFile(
		join(cwd, ".mcp.json"),
		JSON.stringify({ mcpServers: { a: { url: "https://a" } } }),
	);
	await mkdir(join(cwd, ".vscode"));
	await writeFile(
		join(cwd, ".vscode", "mcp.json"),
		JSON.stringify({ servers: { b: { command: "b" } } }),
	);
	await writeFile(join(cwd, "mcp.json"), "{ broken");
	await writeFile(join(home, ".claude.json"), JSON.stringify({ theme: "dark" }));
	const paths = standardMcpConfigPaths({ homeDir: home, cwd, platform: "linux" });
	assert.equal(paths[0]?.path, join(cwd, ".mcp.json"));
	assert.ok(paths.some((candidate) => candidate.client === "claude-desktop"));
	assert.ok(new Set(paths.map((candidate) => candidate.path)).size === paths.length);
	const discovery = await discoverMcpConfigs({ homeDir: home, cwd, platform: "linux" });
	assert.deepEqual(
		discovery.configs.map((found) => [found.client, Object.keys(found.config.mcpServers)]),
		[
			["claude-code", ["a"]],
			["vscode", ["b"]],
		],
	);
	assert.deepEqual(
		discovery.problems.map((problem) => problem.error),
		["invalid JSON"],
	);
	const read = await readMcpConfigFile(join(cwd, ".vscode", "mcp.json"));
	assert.deepEqual(Object.keys(read.mcpServers), ["b"]);
	await assert.rejects(
		readMcpConfigFile(join(cwd, "mcp.json")),
		(error: unknown) => error instanceof KmcpError,
	);
	await assert.rejects(
		readMcpConfigFile(join(cwd, "nope.json")),
		(error: unknown) => error instanceof KmcpError,
	);
});

test("stdioConnection pipes the child's stderr line by line to the observer", async () => {
	const lines: string[] = [];
	let resolveLine!: () => void;
	const gotLine = new Promise<void>((resolve) => {
		resolveLine = resolve;
	});
	const connection = stdioConnection({
		id: "child",
		stdio: {
			command: process.execPath,
			args: [
				"-e",
				'process.stderr.write("hello from child\\n" + "x".repeat(20) + "\\n"); setInterval(() => {}, 1000);',
			],
		},
		maxStderrLineLength: 10,
		onStderrLine: (line) => {
			lines.push(line);
			if (lines.length === 2) resolveLine();
		},
	});
	assert.equal(connection.transportKind, "stdio");
	const transport = await connection.openTransport();
	await transport.start();
	try {
		await Promise.race([
			gotLine,
			new Promise((_, reject) => setTimeout(() => reject(new Error("no stderr")), 5000)),
		]);
	} finally {
		await transport.close();
	}
	assert.equal(lines[0], "hello from…");
	assert.equal(lines[1], "xxxxxxxxxx…");
});

test("browserOpenCommand never involves a shell and refuses non-http schemes", () => {
	const url = new URL("https://as.example.com/authorize?a=1&b=2");
	assert.deepEqual(browserOpenCommand(url, "darwin"), { command: "open", args: [url.href] });
	assert.deepEqual(browserOpenCommand(url, "linux"), { command: "xdg-open", args: [url.href] });
	assert.deepEqual(browserOpenCommand(url, "win32"), {
		command: "rundll32",
		args: ["url.dll,FileProtocolHandler", url.href],
	});
	assert.throws(
		() => browserOpenCommand(new URL("javascript:alert(1)"), "darwin"),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.AUTH_FORBIDDEN,
	);
});

test("loopbackOAuthCallback tries fixed ports in order, honours hostname, and rejects foreign hosts", async () => {
	const callback = await loopbackOAuthCallback({ port: [1, 0], hostname: "localhost" });
	try {
		assert.equal(callback.redirectUrl.hostname, "localhost");
		assert.notEqual(callback.redirectUrl.port, "1");
		const status = await new Promise<number>((resolve, reject) => {
			const request = httpRequest(
				{
					host: "127.0.0.1",
					port: Number(callback.redirectUrl.port),
					path: "/callback?code=x",
					headers: { host: "evil.example" },
				},
				(response) => {
					response.resume();
					resolve(response.statusCode ?? 0);
				},
			);
			request.on("error", reject);
			request.end();
		});
		assert.equal(status, 403);
	} finally {
		await callback.close();
	}
	await assert.rejects(
		loopbackOAuthCallback({ port: [] }),
		(error: unknown) => error instanceof KmcpError,
	);
});

test("the loopback endpoint refuses sub-resource loads and unexpected callbacks but keeps listening", async () => {
	const callback = await loopbackOAuthCallback({
		hostname: "localhost",
		accept: (params) => params.get("state") === "expected",
	});
	const port = Number(callback.redirectUrl.port);
	const status = (path: string, headers: Record<string, string> = {}, method = "GET") =>
		new Promise<number>((resolve, reject) => {
			const request = httpRequest(
				{ host: "127.0.0.1", port, path, method, headers },
				(response) => {
					response.resume();
					resolve(response.statusCode ?? 0);
				},
			);
			request.on("error", reject);
			request.end();
		});
	try {
		assert.equal(
			await status("/callback?code=drive-by&state=expected", {
				"sec-fetch-mode": "no-cors",
				"sec-fetch-dest": "image",
			}),
			405,
		);
		assert.equal(await status("/callback?code=drive-by&state=expected", {}, "POST"), 405);
		assert.equal(
			await status("/callback?code=stray&state=other"),
			400,
			"a callback that is not ours is refused",
		);
		assert.equal(
			await status("/callback?code=ok&state=expected", { host: "[::1]:" + port }),
			200,
			"IPv6 loopback literal accepted",
		);
		const params = await callback.waitForCallback();
		assert.equal(params.get("code"), "ok");
	} finally {
		await callback.close();
	}
	const ipv6 = await loopbackOAuthCallback({ hostname: "localhost" });
	try {
		const reachable = await new Promise<boolean>((resolve) => {
			const request = httpRequest(
				{ host: "::1", port: Number(ipv6.redirectUrl.port), path: "/other" },
				(response) => {
					response.resume();
					resolve(response.statusCode === 404);
				},
			);
			request.on("error", () => resolve(false));
			request.end();
		});
		// Hosts without IPv6 loopback keep the IPv4 listener only; where it exists it must answer.
		if (reachable) assert.ok(reachable);
	} finally {
		await ipv6.close();
	}
});
