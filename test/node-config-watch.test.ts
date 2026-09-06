import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { KMCP_ERROR_CODES, KmcpError } from "../src/index.ts";
import {
	type McpConfigChange,
	type McpConfigWatchOptions,
	type McpConfigWatcher,
	connectionsFromMcpConfig,
	watchMcpConfigs,
} from "../src/node.ts";

/** Collects watcher callbacks and hands them out one at a time, in order. */
class Recorder {
	readonly changes: McpConfigChange[] = [];
	readonly errors: { error: unknown; path: string }[] = [];
	#taken = 0;
	#takenErrors = 0;

	readonly onChange = (change: McpConfigChange): void => {
		this.changes.push(change);
	};

	readonly onError = (error: unknown, path: string): void => {
		this.errors.push({ error, path });
	};

	/**
	 * The next change, skipping any that `accept` rejects: a single write can legitimately reach
	 * `fs.watch` as more than one event, so a test waits for the state it asked for.
	 */
	async next(
		what = "a change",
		accept?: (change: McpConfigChange) => boolean,
	): Promise<McpConfigChange> {
		for (;;) {
			const change = await waitFor(() => this.changes[this.#taken], what);
			this.#taken += 1;
			if (accept === undefined || accept(change)) return change;
		}
	}

	async nextError(): Promise<{ error: unknown; path: string }> {
		const entry = await waitFor(() => this.errors[this.#takenErrors], "an error");
		this.#takenErrors += 1;
		return entry;
	}
}

async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Starts a watcher that is always closed, even when an assertion fails. */
function start(t: TestContext, options: McpConfigWatchOptions): McpConfigWatcher {
	const watcher = watchMcpConfigs({ debounceMs: 10, pollIntervalMs: 20, ...options });
	t.after(() => watcher.close());
	return watcher;
}

const CONFIG = (url: string) => JSON.stringify({ mcpServers: { alpha: { url } } });

/** The `alpha` entry's url in a delivered change, or `undefined` when there is no config. */
function alphaUrl(change: McpConfigChange): string | undefined {
	const entry = change.configs[0]?.config.mcpServers.alpha as { url?: string } | undefined;
	return entry?.url;
}

test("watchMcpConfigs reports creation, modification and deletion of a config file", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "kmcp-watch-"));
	const path = join(directory, "mcp.json");
	const recorder = new Recorder();
	const watcher = start(t, {
		paths: [path],
		onChange: recorder.onChange,
		onError: recorder.onError,
	});
	assert.deepEqual(watcher.paths, [path]);

	await writeFile(path, CONFIG("https://one.example.com/mcp"));
	const created = await recorder.next("the file to be created");
	assert.equal(created.path, path);
	assert.equal(created.configs.length, 1);
	assert.equal(alphaUrl(created), "https://one.example.com/mcp");
	// The change carries a parsed config, ready to become connections.
	const connections = connectionsFromMcpConfig(created.configs[0]!.config);
	assert.equal(connections.alpha!.transportKind, "streamable-http");
	assert.equal(created.configs[0]!.scope, "global");
	assert.equal(created.configs[0]!.client, "custom");

	await writeFile(path, CONFIG("https://two.example.com/mcp"));
	const modified = await recorder.next(
		"the file to be modified",
		(change) => alphaUrl(change) === "https://two.example.com/mcp",
	);
	assert.equal(modified.configs.length, 1);

	await rm(path);
	const deleted = await recorder.next(
		"the file to be deleted",
		(change) => change.configs.length === 0,
	);
	assert.deepEqual(deleted.configs, []);
	assert.deepEqual(recorder.errors, []);

	// Closing twice is one close, and nothing is reported afterwards.
	await watcher.close();
	await watcher.close();
	const seen = recorder.changes.length;
	await writeFile(path, CONFIG("https://three.example.com/mcp"));
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(recorder.changes.length, seen);
});

test("watchMcpConfigs reports a broken config through onError and keeps watching", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "kmcp-watch-"));
	const path = join(directory, "mcp.json");
	const recorder = new Recorder();
	start(t, { paths: [path], onChange: recorder.onChange, onError: recorder.onError });

	await writeFile(path, "{ not json");
	const failure = await recorder.nextError();
	assert.equal(failure.path, path);
	assert.ok(failure.error instanceof KmcpError);
	assert.equal((failure.error as KmcpError).code, KMCP_ERROR_CODES.INVALID_DEFINITION);
	assert.deepEqual(recorder.changes, []);

	// A file that parses but is not an MCP config is simply "no config here", not an error.
	await writeFile(path, JSON.stringify({ theme: "dark" }));
	const other = await recorder.next("a non-config file", (change) => change.configs.length === 0);
	assert.deepEqual(other.configs, []);

	// The watch survived both: a later valid write is still reported.
	await writeFile(path, CONFIG("https://recovered.example.com/mcp"));
	const recovered = await recorder.next(
		"the recovered config",
		(change) => alphaUrl(change) === "https://recovered.example.com/mcp",
	);
	assert.equal(recovered.configs.length, 1);
	assert.equal(recorder.errors.length, 1);
});

test("watchMcpConfigs coalesces a burst of writes into one change", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "kmcp-watch-"));
	const path = join(directory, "mcp.json");
	const recorder = new Recorder();
	start(t, {
		paths: [path],
		debounceMs: 150,
		onChange: recorder.onChange,
		onError: recorder.onError,
	});

	for (let index = 0; index < 5; index += 1) {
		await writeFile(path, CONFIG(`https://burst-${index}.example.com/mcp`));
	}
	// The very first delivery already carries the last write: the burst was one change, not five.
	const change = await recorder.next("the coalesced change");
	assert.equal(alphaUrl(change), "https://burst-4.example.com/mcp");
	await new Promise((resolve) => setTimeout(resolve, 350));
	assert.equal(recorder.changes.length, 1);
});

test("watchMcpConfigs can poll instead of using fs.watch", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "kmcp-watch-"));
	const path = join(directory, "mcp.json");
	const recorder = new Recorder();
	start(t, {
		paths: [path],
		poll: true,
		pollIntervalMs: 20,
		onChange: recorder.onChange,
		onError: recorder.onError,
	});

	await writeFile(path, CONFIG("https://polled.example.com/mcp"));
	const created = await recorder.next(
		"the polled creation",
		(change) => change.configs.length === 1,
	);
	assert.equal(alphaUrl(created), "https://polled.example.com/mcp");
	await rm(path);
	const deleted = await recorder.next(
		"the polled deletion",
		(change) => change.configs.length === 0,
	);
	assert.deepEqual(deleted.configs, []);
	assert.deepEqual(recorder.errors, []);
});

test("watchMcpConfigs watches the standard locations by default", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "kmcp-watch-cwd-"));
	const home = await mkdtemp(join(tmpdir(), "kmcp-watch-home-"));
	const recorder = new Recorder();
	const watcher = start(t, {
		pathOptions: { cwd, homeDir: home, platform: "linux" },
		onChange: recorder.onChange,
		onError: recorder.onError,
	});
	assert.ok(watcher.paths.includes(join(cwd, ".mcp.json")));

	await writeFile(join(cwd, ".mcp.json"), CONFIG("https://project.example.com/mcp"));
	const change = await recorder.next(
		"the project config",
		(candidate) => candidate.path === join(cwd, ".mcp.json") && candidate.configs.length === 1,
	);
	assert.equal(change.path, join(cwd, ".mcp.json"));
	assert.equal(change.configs[0]!.scope, "project");
	assert.equal(change.configs[0]!.client, "claude-code");
});

test("watchMcpConfigs validates its options", () => {
	const invalid = (error: unknown) =>
		error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION;
	assert.throws(() => watchMcpConfigs({} as unknown as McpConfigWatchOptions), invalid);
	assert.throws(() => watchMcpConfigs({ onChange: () => {}, debounceMs: -1 }), invalid);
	assert.throws(() => watchMcpConfigs({ onChange: () => {}, pollIntervalMs: 0 }), invalid);
});
