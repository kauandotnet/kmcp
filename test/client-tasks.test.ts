import assert from "node:assert/strict";
import test from "node:test";

import { type Client, InMemoryTransport } from "@modelcontextprotocol/client";

import {
	KMCP_ERROR_CODES,
	KmcpError,
	MCP_CLIENT_CREDENTIALS_EXTENSION,
	McpConnectionManager,
	McpTaskClient,
	McpTaskFailedError,
	clientCredentialsAuth,
	defineConnection,
	defineServer,
	httpConnection,
	inProcessConnection,
	resolveProtocolPin,
	type McpTaskUpdate,
} from "../src/index.ts";
import { createFakeTaskServer } from "./helpers/raw-server.ts";

function hasCode(code: string) {
	return (error: unknown) => error instanceof KmcpError && error.code === code;
}

test("task-augmented tool calls run through the 2025-11-25 vocabulary on a legacy connection", async (t) => {
	const server = createFakeTaskServer({ completeAfterMs: 20 });
	const manager = new McpConnectionManager<"tasks">();
	t.after(() => manager.close());
	manager.register(
		defineConnection({
			id: "tasks",
			transport: () => server.transport,
			protocolVersion: "2025-11-25",
		}),
	);
	const snapshot = await manager.connect("tasks");
	assert.equal(snapshot.protocolVersion, "2025-11-25");
	assert.equal(snapshot.protocolEra, "legacy");
	assert.equal(snapshot.transportKind, "custom");
	assert.equal(manager.supportsToolTasks("tasks"), true);

	const created = await manager.callToolTask("tasks", "slow", { value: "x" }, { ttlMs: 60_000 });
	assert.equal(created.task.status, "working");
	assert.equal(created.task.ttl, 60_000);
	const createRequest = server.received.find(
		(message) =>
			message.method === "tools/call" && (message.params as { task?: unknown }).task !== undefined,
	);
	assert.ok(createRequest, "the create request carried a task param");

	const updates: McpTaskUpdate[] = [];
	const result = await manager.waitForTask("tasks", created.task.taskId, {
		pollIntervalMs: 5,
		onUpdate: (update) => updates.push(update),
	});
	assert.equal(result.content[0]?.type, "text");
	assert.equal((result.content[0] as { text: string }).text, `task:${created.task.taskId}`);
	assert.ok(updates.length >= 1);
	assert.equal(updates.at(-1)?.status, "completed");

	const listed = await manager.listTasks("tasks");
	assert.equal(listed.tasks.length, 1);
	const fetched = await manager.getTask("tasks", created.task.taskId);
	assert.equal(fetched.status, "completed");

	const viaTask = await manager.callToolViaTask(
		"tasks",
		"slow",
		{ value: "y" },
		{ pollIntervalMs: 5 },
	);
	assert.equal((viaTask.content[0] as { text: string }).text, "task:task-2");

	const third = await manager.callToolTask("tasks", "slow", {});
	const cancelled = await manager.cancelTask("tasks", third.task.taskId);
	assert.equal(cancelled.status, "cancelled");
	await assert.rejects(
		manager.waitForTask("tasks", third.task.taskId, { pollIntervalMs: 5 }),
		(error: unknown) => error instanceof McpTaskFailedError && error.task.status === "cancelled",
	);

	// A plain call still works next to the task path.
	const sync = await manager.callTool("tasks", "slow", { value: "z" });
	assert.equal((sync.content[0] as { text: string }).text, "sync:z");
});

test("a failed task rejects with its final snapshot and an aborted wait stops polling", async (t) => {
	const server = createFakeTaskServer({ completeAfterMs: 10, outcome: "failed" });
	const manager = new McpConnectionManager<"tasks">();
	t.after(() => manager.close());
	manager.register(
		defineConnection({
			id: "tasks",
			transport: () => server.transport,
			protocolVersion: "2025-11-25",
		}),
	);
	await manager.connect("tasks");
	await assert.rejects(
		manager.callToolViaTask("tasks", "slow", {}, { pollIntervalMs: 5 }),
		(error: unknown) =>
			error instanceof McpTaskFailedError &&
			error.task.status === "failed" &&
			error.task.statusMessage === "boom",
	);
	const controller = new AbortController();
	const created = await manager.callToolTask("tasks", "slow", {});
	const waiting = manager.waitForTask("tasks", created.task.taskId, {
		pollIntervalMs: 1000,
		signal: controller.signal,
	});
	controller.abort(new Error("stop"));
	await assert.rejects(
		waiting,
		(error: unknown) => error instanceof Error && error.message === "stop",
	);
});

test("tasks are refused on the modern era and on servers without the capability", async (t) => {
	const definition = defineServer({ name: "no-tasks", version: "1.0.0" });
	const manager = new McpConnectionManager<"modern" | "legacy">();
	t.after(() => manager.close());
	manager.register(inProcessConnection({ id: "modern", definition, era: "modern" }));
	manager.register(inProcessConnection({ id: "legacy", definition, era: "legacy" }));
	await manager.connectAll(["modern", "legacy"]);
	assert.equal(manager.supportsToolTasks("modern"), false);
	assert.equal(manager.supportsToolTasks("legacy"), false);
	await assert.rejects(
		manager.callToolTask("modern", "slow", {}),
		hasCode(KMCP_ERROR_CODES.TASKS_UNAVAILABLE),
	);
	await assert.rejects(manager.listTasks("modern"), hasCode(KMCP_ERROR_CODES.TASKS_UNAVAILABLE));
	await assert.rejects(
		manager.callToolTask("legacy", "slow", {}),
		hasCode(KMCP_ERROR_CODES.TASKS_UNAVAILABLE),
	);
});

test("McpTaskClient hands the SDK's own result schemas to the requester", async () => {
	const schemasSeen: string[] = [];
	const requester = {
		request: async (
			request: { method: string },
			schema: {
				readonly "~standard": { validate(value: unknown): { issues?: unknown[]; value?: unknown } };
			},
		) => {
			const payload =
				request.method === "tasks/get"
					? { taskId: "t", status: "bogus", ttl: null, createdAt: "x", lastUpdatedAt: "x" }
					: { tasks: [] };
			const outcome = schema["~standard"].validate(payload);
			schemasSeen.push(request.method);
			if (outcome.issues !== undefined) throw new Error("invalid result");
			return outcome.value;
		},
		getProtocolEra: () => "legacy" as const,
		getNegotiatedProtocolVersion: () => "2025-11-25",
		getServerCapabilities: () => ({ tasks: { requests: { tools: { call: {} } } } }),
	};
	const client = new McpTaskClient(requester as unknown as Client);
	await assert.rejects(client.getTask("t"), /invalid result/);
	const listed = await client.listTasks();
	assert.deepEqual(listed.tasks, []);
	assert.deepEqual(schemasSeen, ["tasks/get", "tasks/list"]);
});

test("protocolVersion pins resolve to strict negotiation and invalid pins fail at definition time", () => {
	assert.deepEqual(resolveProtocolPin("2026-07-28"), {
		versionNegotiation: { mode: { pin: "2026-07-28" } },
	});
	assert.deepEqual(resolveProtocolPin("2025-06-18"), {
		versionNegotiation: { mode: "legacy" },
		supportedProtocolVersions: ["2025-06-18"],
	});
	assert.throws(
		() => resolveProtocolPin("2019-01-01"),
		hasCode(KMCP_ERROR_CODES.PROTOCOL_VERSION_UNSUPPORTED),
	);
	assert.throws(
		() =>
			defineConnection({
				id: "x",
				transport: () => InMemoryTransport.createLinkedPair()[0],
				protocolVersion: "2025-11-25",
				clientOptions: { versionNegotiation: { mode: "auto" } },
			}),
		hasCode(KMCP_ERROR_CODES.INVALID_DEFINITION),
	);
	const pinned = defineConnection({
		id: "x",
		transport: () => InMemoryTransport.createLinkedPair()[0],
		protocolVersion: "2025-03-26",
	});
	assert.deepEqual(pinned.clientOptions.versionNegotiation, { mode: "legacy" });
	assert.deepEqual(pinned.clientOptions.supportedProtocolVersions, ["2025-03-26"]);
});

test("a modern pin against a legacy-only server fails loudly instead of falling back", async (t) => {
	const server = createFakeTaskServer();
	const manager = new McpConnectionManager<"pinned">();
	t.after(() => manager.close());
	manager.register(
		defineConnection({
			id: "pinned",
			transport: () => server.transport,
			protocolVersion: "2026-07-28",
			defaults: { timeoutMs: 200 },
		}),
	);
	await assert.rejects(
		manager.connect("pinned"),
		hasCode(KMCP_ERROR_CODES.CONNECTION_CONNECT_FAILED),
	);
	assert.equal(manager.state("pinned").phase, "failed");
});

test("client capabilities advertise tasks by default and grant-derived extensions", () => {
	const transport = () => InMemoryTransport.createLinkedPair()[0];
	const withTasks = defineConnection({ id: "a", transport });
	assert.deepEqual(withTasks.clientOptions.capabilities?.tasks, { list: {}, cancel: {} });
	const withoutTasks = defineConnection({ id: "b", transport, tasks: false });
	assert.equal(withoutTasks.clientOptions.capabilities?.tasks, undefined);
	const withExtension = defineConnection({
		id: "c",
		transport,
		extensions: { "io.example/thing": { enabled: true } },
	});
	assert.deepEqual(withExtension.clientOptions.capabilities?.extensions, {
		"io.example/thing": { enabled: true },
	});
	const m2m = httpConnection({
		id: "d",
		url: "https://mcp.example.com/mcp",
		auth: clientCredentialsAuth({ clientId: "m2m", clientSecret: "secret" }),
	});
	assert.deepEqual(m2m.clientOptions.capabilities?.extensions, {
		[MCP_CLIENT_CREDENTIALS_EXTENSION]: {},
	});
	assert.equal(
		m2m.interactiveOAuth,
		false,
		"a client-credentials provider never parks in authorizing",
	);
	assert.equal(m2m.transportKind, "streamable-http");
});
