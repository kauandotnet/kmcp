import {
	InMemoryTransport,
	type JSONRPCMessage,
	type Transport,
} from "@modelcontextprotocol/client";

/** Returned by a handler to leave a request unanswered (the client then times out). */
export const IGNORE = Symbol("ignore request");

export type RawHandler = (
	params: Record<string, unknown> | undefined,
	id: string | number,
) => unknown | Promise<unknown>;

export interface RawLegacyServer {
	/** The client side of the linked pair; hand it to a connection definition's `transport`. */
	readonly transport: Transport;
	readonly serverSide: InMemoryTransport;
	/** Every request and notification the server received, in order. */
	readonly received: { method: string; params: unknown }[];
	/** Sends a server→client notification. */
	notify(method: string, params?: Record<string, unknown>): Promise<void>;
}

export interface RawLegacyServerOptions {
	readonly capabilities?: Record<string, unknown>;
	readonly handlers?: Readonly<Record<string, RawHandler>>;
}

/**
 * A raw 2025-11-25 JSON-RPC responder over an in-memory pair. It answers `initialize` with the
 * given capabilities and dispatches every other request to `handlers`; unknown methods get a
 * `-32601` error. Used where the official server SDK has no runtime for a feature (tasks) or where
 * a specific wire shape must be produced (a draft-07 `outputSchema`).
 */
export function createRawLegacyServer(options: RawLegacyServerOptions = {}): RawLegacyServer {
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const received: { method: string; params: unknown }[] = [];
	const handlers: Record<string, RawHandler> = {
		initialize: () => ({
			protocolVersion: "2025-11-25",
			capabilities: options.capabilities ?? { tools: {} },
			serverInfo: { name: "raw-legacy", version: "0.0.0" },
		}),
		ping: () => ({}),
		...options.handlers,
	};
	serverSide.onmessage = (message: JSONRPCMessage) => {
		if (!("method" in message)) return;
		const params = (message as { params?: Record<string, unknown> }).params;
		received.push({ method: message.method, params });
		if (!("id" in message) || message.id === undefined) return;
		const id = message.id;
		const handler = handlers[message.method];
		void (async () => {
			try {
				if (handler === undefined) {
					await serverSide.send({
						jsonrpc: "2.0",
						id,
						error: { code: -32601, message: `Method not found: ${message.method}` },
					});
					return;
				}
				const result = await handler(params, id);
				if (result === IGNORE) return;
				await serverSide.send({ jsonrpc: "2.0", id, result: result as Record<string, unknown> });
			} catch (error) {
				await serverSide.send({
					jsonrpc: "2.0",
					id,
					error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
				});
			}
		})();
	};
	void serverSide.start();
	return {
		transport: clientSide,
		serverSide,
		received,
		notify: (method, params) =>
			serverSide.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }),
	};
}

interface FakeTask {
	taskId: string;
	status: "working" | "input_required" | "completed" | "failed" | "cancelled";
	ttl: number | null;
	createdAt: string;
	lastUpdatedAt: string;
	pollInterval?: number;
	statusMessage?: string;
}

export interface FakeTaskServerOptions {
	/** How long a task stays `working` before completing (ms). Default: 30. */
	readonly completeAfterMs?: number;
	/** Final status of created tasks. Default: `completed`. */
	readonly outcome?: "completed" | "failed";
}

/** A raw legacy server that implements task-augmented `tools/call` for a `slow` tool. */
export function createFakeTaskServer(options: FakeTaskServerOptions = {}): RawLegacyServer & {
	readonly tasks: Map<string, FakeTask>;
} {
	const tasks = new Map<string, FakeTask>();
	let counter = 0;
	const now = () => new Date().toISOString();
	const server = createRawLegacyServer({
		capabilities: {
			tools: {},
			tasks: { requests: { tools: { call: {} } }, list: {}, cancel: {} },
		},
		handlers: {
			"tools/list": () => ({
				tools: [{ name: "slow", inputSchema: { type: "object" } }],
			}),
			"tools/call": (params) => {
				const args = (params?.arguments ?? {}) as Record<string, unknown>;
				if (params?.task === undefined) {
					return { content: [{ type: "text", text: `sync:${String(args.value ?? "")}` }] };
				}
				counter += 1;
				const task: FakeTask = {
					taskId: `task-${counter}`,
					status: "working",
					ttl: (params.task as { ttl?: number }).ttl ?? null,
					createdAt: now(),
					lastUpdatedAt: now(),
					pollInterval: 5,
				};
				tasks.set(task.taskId, task);
				setTimeout(() => {
					if (task.status !== "working") return;
					task.status = options.outcome ?? "completed";
					task.lastUpdatedAt = now();
					if (task.status === "failed") task.statusMessage = "boom";
				}, options.completeAfterMs ?? 30);
				return { task };
			},
			"tasks/get": (params) => {
				const task = tasks.get(String(params?.taskId));
				if (task === undefined) throw new Error("unknown task");
				return task;
			},
			"tasks/result": (params) => {
				const task = tasks.get(String(params?.taskId));
				if (task === undefined) throw new Error("unknown task");
				return { content: [{ type: "text", text: `task:${task.taskId}` }] };
			},
			"tasks/list": () => ({ tasks: [...tasks.values()] }),
			"tasks/cancel": (params) => {
				const task = tasks.get(String(params?.taskId));
				if (task === undefined) throw new Error("unknown task");
				task.status = "cancelled";
				task.lastUpdatedAt = now();
				return task;
			},
		},
	});
	return Object.assign(server, { tasks });
}
