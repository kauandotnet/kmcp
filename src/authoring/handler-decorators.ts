import { isInputRequiredResult, type ServerContext } from "@modelcontextprotocol/server";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import { stableFingerprint } from "../internal/value.ts";
import type { AnyMcpCapabilityDefinition } from "./capability.ts";
import type { McpHandlerDecorator } from "./transform.ts";

/** Built-in handler decorators for `decorateHandlers`. Instances keep state on the definition, so counters and caches persist across per-request servers. */

/** Extracts the trailing SDK `ServerContext` from a raw handler argument list. */
export function contextOf(args: readonly unknown[]): ServerContext {
	const last = args[args.length - 1];
	if (typeof last !== "object" || last === null || !("mcpReq" in last)) {
		throw new TypeError(
			"A capability handler must receive the SDK ServerContext as its last argument.",
		);
	}
	return last as ServerContext;
}

function withContext(args: readonly unknown[], context: ServerContext): never[] {
	return [...args.slice(0, -1), context] as never[];
}

/**
 * Aborts a handler after `ms` milliseconds. The handler receives a derived context whose
 * `mcpReq.signal` fires on timeout (and on the original request's cancellation), and the call is
 * raced so a handler that ignores its signal still terminates the request with
 * `HANDLER_TIMEOUT` (an `isError` result for tools via the SDK's own catch).
 */
export function timeout(ms: number): McpHandlerDecorator {
	if (!Number.isFinite(ms) || ms <= 0)
		throw new RangeError("timeout must be a positive number of milliseconds.");
	return (handler, capability) =>
		async (...args: never[]) => {
			const context = contextOf(args);
			const controller = new AbortController();
			const upstream = context.mcpReq.signal;
			const forward = () => controller.abort(upstream.reason);
			if (upstream.aborted) forward();
			else upstream.addEventListener("abort", forward, { once: true });
			let timer: ReturnType<typeof setTimeout> | undefined;
			const expired = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					const error = new KmcpError(
						KMCP_ERROR_CODES.HANDLER_TIMEOUT,
						`${capability.kind} '${capability.name}' timed out after ${ms}ms.`,
					);
					controller.abort(error);
					reject(error);
				}, ms);
			});
			const derived: ServerContext = {
				...context,
				mcpReq: { ...context.mcpReq, signal: controller.signal },
			};
			try {
				return await Promise.race([handler(...withContext(args, derived)), expired]);
			} finally {
				clearTimeout(timer);
				upstream.removeEventListener("abort", forward);
			}
		};
}

/** Rejects promptly when the request's own `mcpReq.signal` aborts (the modern-era cancellation channel). */
export function abortable(): McpHandlerDecorator {
	return (handler) =>
		async (...args: never[]) => {
			const { signal } = contextOf(args).mcpReq;
			signal.throwIfAborted();
			let onAbort: (() => void) | undefined;
			const aborted = new Promise<never>((_, reject) => {
				onAbort = () => reject(signal.reason ?? new Error("The request was cancelled."));
				signal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				return await Promise.race([handler(...args), aborted]);
			} finally {
				if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
			}
		};
}

export interface McpCallLogEntry {
	readonly kind: AnyMcpCapabilityDefinition["kind"];
	readonly name: string;
	readonly durationMs: number;
	readonly ok: boolean;
	readonly error?: unknown;
}

/** Reports every call with its outcome and duration to `emit` (no default sink: on stdio, stdout is the protocol). */
export function logCalls(emit: (entry: McpCallLogEntry) => void): McpHandlerDecorator {
	if (typeof emit !== "function") throw new TypeError("emit must be a function.");
	return (handler, capability) =>
		async (...args: never[]) => {
			const started = performance.now();
			try {
				const result = await handler(...args);
				emit({
					kind: capability.kind,
					name: capability.name,
					durationMs: performance.now() - started,
					ok: true,
				});
				return result;
			} catch (error) {
				emit({
					kind: capability.kind,
					name: capability.name,
					durationMs: performance.now() - started,
					ok: false,
					error,
				});
				throw error;
			}
		};
}

export type McpCallKeyFn = (
	context: ServerContext,
	capability: AnyMcpCapabilityDefinition,
) => Promise<string> | string;

/** The default partition key: `sha256(bearer token)` for authenticated requests, `anon` otherwise — never the raw token. */
export async function principalPartition(context: ServerContext): Promise<string> {
	const token = context.http?.authInfo?.token;
	if (token === undefined || token === "") return "anon";
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface RateLimitOptions {
	readonly limit: number;
	readonly windowMs: number;
	/** Partition key; defaults to the principal partition. */
	readonly key?: McpCallKeyFn;
}

/** Fixed-window counter per partition (not a token bucket: up to 2× `limit` can cross a window boundary). */
export function rateLimit(options: RateLimitOptions): McpHandlerDecorator {
	const { limit, windowMs } = options;
	if (!Number.isSafeInteger(limit) || limit <= 0)
		throw new RangeError("limit must be a positive integer.");
	if (!Number.isFinite(windowMs) || windowMs <= 0)
		throw new RangeError("windowMs must be positive.");
	const windows = new Map<string, { readonly startedAt: number; count: number }>();
	return (handler, capability) =>
		async (...args: never[]) => {
			const context = contextOf(args);
			const key = await (options.key ?? principalPartition)(context, capability);
			const now = Date.now();
			let window = windows.get(key);
			if (window === undefined || now - window.startedAt >= windowMs) {
				window = { startedAt: now, count: 0 };
				windows.set(key, window);
			}
			if (window.count >= limit) {
				throw new KmcpError(
					KMCP_ERROR_CODES.RATE_LIMITED,
					`Rate limit of ${limit} per ${windowMs}ms exceeded for ${capability.kind} '${capability.name}'.`,
				);
			}
			window.count += 1;
			return handler(...args);
		};
}

/** Rejects results whose JSON serialization exceeds `maxBytes` (UTF-8). */
export function sizeLimit(maxBytes: number): McpHandlerDecorator {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
		throw new RangeError("maxBytes must be a positive integer.");
	const encoder = new TextEncoder();
	return (handler, capability) =>
		async (...args: never[]) => {
			const result = await handler(...args);
			const size = encoder.encode(JSON.stringify(result)).byteLength;
			if (size > maxBytes) {
				throw new KmcpError(
					KMCP_ERROR_CODES.RESULT_TOO_LARGE,
					`${capability.kind} '${capability.name}' produced ${size} bytes; the limit is ${maxBytes}.`,
				);
			}
			return result;
		};
}

export interface CacheCallsOptions {
	readonly ttlMs: number;
	/** Maximum cached entries; the oldest is evicted first. Default: 1000. */
	readonly maxEntries?: number;
	/** Partition key; defaults to the principal partition. Replacing it makes the caller own identity partitioning. */
	readonly key?: McpCallKeyFn;
}

/**
 * Caches results per `(capability, partition, arguments)` for `ttlMs`. Multi-round-trip rounds are
 * never cached: a request carrying `inputResponses`/`requestState` bypasses the cache and an
 * `input_required` result is never stored (each embeds a single-use flow token).
 */
export function cacheCalls(options: CacheCallsOptions): McpHandlerDecorator {
	const { ttlMs } = options;
	if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs must be positive.");
	const maxEntries = options.maxEntries ?? 1000;
	if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0)
		throw new RangeError("maxEntries must be a positive integer.");
	const entries = new Map<string, { readonly value: unknown; readonly expiresAt: number }>();
	return (handler, capability) =>
		async (...args: never[]) => {
			const context = contextOf(args);
			if (
				context.mcpReq.inputResponses !== undefined ||
				context.mcpReq.requestState() !== undefined
			) {
				return handler(...args);
			}
			const partition = await (options.key ?? principalPartition)(context, capability);
			const key = `${capability.kind}:${capability.name}:${partition}:${stableFingerprint(cacheArguments(args))}`;
			const now = Date.now();
			const cached = entries.get(key);
			if (cached !== undefined && cached.expiresAt > now) return cached.value;
			entries.delete(key);
			const value = await handler(...args);
			if (!isInputRequiredResult(value)) {
				if (entries.size >= maxEntries) {
					const oldest = entries.keys().next().value;
					if (oldest !== undefined) entries.delete(oldest);
				}
				entries.set(key, { value, expiresAt: now + ttlMs });
			}
			return value;
		};
}

function cacheArguments(args: readonly unknown[]): unknown[] {
	return args.slice(0, -1).map((argument) => (argument instanceof URL ? argument.href : argument));
}
