import {
	type CallToolResult,
	type CancelTaskResult,
	type CreateTaskResult,
	type GetTaskResult,
	type ListTasksResult,
	type RequestOptions,
	type Task,
	specTypeSchemas,
} from "@modelcontextprotocol/client";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";

/**
 * Task-augmented tool calls (SEP-1686, protocol revision 2025-11-25).
 *
 * Revision 2026-07-28 moved tasks into the `io.modelcontextprotocol/tasks` extension, which the
 * official SDK v2 does not implement yet, and the SDK dropped its v1 experimental task client. The
 * 2025-11-25 wire vocabulary is still part of the SDK's neutral schema set, so kmcp issues the
 * task requests through `Client.request()` with the SDK's own result validators. Every task
 * round trip goes through {@link McpTaskClient}; adopting the SDK's extension API once it ships is
 * a change to this module only.
 */

/** A task status snapshot delivered to `onUpdate` while a task is polled. */
export interface McpTaskUpdate {
	readonly taskId: string;
	readonly status: Task["status"];
	readonly statusMessage?: string;
	readonly createdAt?: string;
	readonly lastUpdatedAt?: string;
	readonly pollCount: number;
}

export interface McpTaskPollOptions {
	/** Delay between two `tasks/get` polls (ms). Default: 2000. */
	readonly pollIntervalMs?: number;
	/** Called after every poll, including the terminal one. */
	readonly onUpdate?: (update: McpTaskUpdate) => void;
	readonly signal?: AbortSignal;
	/** Per-request options applied to every task request. */
	readonly request?: RequestOptions;
}

/** Extra params for a task-augmented `tools/call` (`task.ttl` is the requested retention, ms). */
export interface McpCreateToolTaskOptions {
	readonly ttlMs?: number;
	readonly meta?: Readonly<Record<string, unknown>>;
	readonly request?: RequestOptions;
}

/** The transport-neutral request seam the task helpers drive (an official `Client` satisfies it). */
export interface McpTaskRequester {
	request<Schema extends { readonly "~standard": unknown }>(
		request: { readonly method: string; readonly params?: Record<string, unknown> },
		resultSchema: Schema,
		options?: RequestOptions,
	): Promise<unknown>;
	getProtocolEra(): "legacy" | "modern" | undefined;
	getNegotiatedProtocolVersion(): string | undefined;
	getServerCapabilities(): { readonly tasks?: unknown } | undefined;
}

export const MCP_TASK_TERMINAL_STATUSES: ReadonlySet<Task["status"]> = new Set([
	"completed",
	"failed",
	"cancelled",
]);

/** Thrown when a polled task ends in `failed` or `cancelled`; carries the final task snapshot. */
export class McpTaskFailedError extends KmcpError {
	readonly task: Task;

	constructor(task: Task) {
		super(
			KMCP_ERROR_CODES.OPERATION_FAILED,
			`Task '${task.taskId}' ended with status '${task.status}'${task.statusMessage === undefined ? "" : `: ${task.statusMessage}`}.`,
		);
		this.name = "McpTaskFailedError";
		this.task = task;
	}
}

/** Asserts the connection negotiated a revision that carries the 2025-11-25 task vocabulary. */
export function assertTasksAvailable(requester: McpTaskRequester): void {
	if (requester.getProtocolEra() === "modern") {
		throw new KmcpError(
			KMCP_ERROR_CODES.TASKS_UNAVAILABLE,
			`Tasks are unavailable on this connection: MCP ${requester.getNegotiatedProtocolVersion() ?? "2026-07-28"} moved them to the io.modelcontextprotocol/tasks extension, which the SDK does not support yet. Task requests work on servers speaking 2025-11-25.`,
		);
	}
}

/** Whether the upstream advertises task-augmented `tools/call` (`capabilities.tasks.requests.tools.call`). */
export function supportsToolTasks(requester: McpTaskRequester): boolean {
	if (requester.getProtocolEra() === "modern") return false;
	const tasks = requester.getServerCapabilities()?.tasks;
	if (typeof tasks !== "object" || tasks === null) return false;
	const requests = (tasks as { readonly requests?: unknown }).requests;
	if (typeof requests !== "object" || requests === null) return false;
	const tools = (requests as { readonly tools?: unknown }).tools;
	if (typeof tools !== "object" || tools === null) return false;
	return (tools as { readonly call?: unknown }).call !== undefined;
}

/** A thin, era-checked client for the 2025-11-25 task methods over one requester. */
export class McpTaskClient {
	readonly #requester: McpTaskRequester;

	constructor(requester: McpTaskRequester) {
		this.#requester = requester;
	}

	/** Issues a task-augmented `tools/call`; the tool keeps running after this resolves. */
	async createToolTask(
		name: string,
		arguments_: Readonly<Record<string, unknown>> = {},
		options: McpCreateToolTaskOptions = {},
	): Promise<CreateTaskResult> {
		assertTasksAvailable(this.#requester);
		if (!supportsToolTasks(this.#requester)) {
			throw new KmcpError(
				KMCP_ERROR_CODES.TASKS_UNAVAILABLE,
				"This server does not advertise task-augmented tool calls (no tasks.requests.tools.call capability).",
			);
		}
		const params: Record<string, unknown> = {
			name,
			arguments: { ...arguments_ },
			task: options.ttlMs === undefined ? {} : { ttl: options.ttlMs },
		};
		if (options.meta !== undefined) params._meta = { ...options.meta };
		return (await this.#requester.request(
			{ method: "tools/call", params },
			specTypeSchemas.CreateTaskResult,
			options.request,
		)) as CreateTaskResult;
	}

	async getTask(taskId: string, options?: RequestOptions): Promise<GetTaskResult> {
		assertTasksAvailable(this.#requester);
		return (await this.#requester.request(
			{ method: "tasks/get", params: { taskId } },
			specTypeSchemas.GetTaskResult,
			options,
		)) as GetTaskResult;
	}

	/** Blocks on the server until the task is terminal, then returns the tool result. */
	async getTaskResult(taskId: string, options?: RequestOptions): Promise<CallToolResult> {
		assertTasksAvailable(this.#requester);
		return (await this.#requester.request(
			{ method: "tasks/result", params: { taskId } },
			specTypeSchemas.CallToolResult,
			options,
		)) as CallToolResult;
	}

	async listTasks(cursor?: string, options?: RequestOptions): Promise<ListTasksResult> {
		assertTasksAvailable(this.#requester);
		return (await this.#requester.request(
			{ method: "tasks/list", ...(cursor === undefined ? {} : { params: { cursor } }) },
			specTypeSchemas.ListTasksResult,
			options,
		)) as ListTasksResult;
	}

	async cancelTask(taskId: string, options?: RequestOptions): Promise<CancelTaskResult> {
		assertTasksAvailable(this.#requester);
		return (await this.#requester.request(
			{ method: "tasks/cancel", params: { taskId } },
			specTypeSchemas.CancelTaskResult,
			options,
		)) as CancelTaskResult;
	}

	/**
	 * Polls `tasks/get` until the task is terminal. A `completed` task resolves with its
	 * `tasks/result`; `failed` and `cancelled` reject with {@link McpTaskFailedError}. An
	 * `input_required` task delegates to `tasks/result`, which delivers the queued server
	 * messages and blocks until the task settles.
	 */
	async waitForTask(taskId: string, options: McpTaskPollOptions = {}): Promise<CallToolResult> {
		assertTasksAvailable(this.#requester);
		const interval = options.pollIntervalMs ?? 2000;
		if (!Number.isFinite(interval) || interval < 0) {
			throw new RangeError("pollIntervalMs must be a non-negative number.");
		}
		let pollCount = 0;
		for (;;) {
			throwIfAborted(options.signal);
			const task = await this.getTask(taskId, options.request);
			pollCount += 1;
			options.onUpdate?.(toUpdate(task, pollCount));
			if (task.status === "completed") return this.getTaskResult(taskId, options.request);
			if (MCP_TASK_TERMINAL_STATUSES.has(task.status)) throw new McpTaskFailedError(task);
			if (task.status === "input_required") return this.getTaskResult(taskId, options.request);
			await sleep(interval, options.signal);
		}
	}

	/** `createToolTask` followed by `waitForTask`; the created task is reported as the first update. */
	async callToolViaTask(
		name: string,
		arguments_: Readonly<Record<string, unknown>> = {},
		options: McpCreateToolTaskOptions & McpTaskPollOptions = {},
	): Promise<CallToolResult> {
		const created = await this.createToolTask(name, arguments_, options);
		options.onUpdate?.(toUpdate(created.task, 0));
		return this.waitForTask(created.task.taskId, options);
	}
}

function toUpdate(task: Task, pollCount: number): McpTaskUpdate {
	return Object.freeze({
		taskId: task.taskId,
		status: task.status,
		...(task.statusMessage === undefined ? {} : { statusMessage: task.statusMessage }),
		...(task.createdAt === undefined ? {} : { createdAt: task.createdAt }),
		...(task.lastUpdatedAt === undefined ? {} : { lastUpdatedAt: task.lastUpdatedAt }),
		pollCount,
	});
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted === true) {
		throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
