import {
	isInputRequiredResult,
	type McpRequestContext,
	type ServerContext,
} from "@modelcontextprotocol/server";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import type { MaybePromise } from "../internal/value.ts";
import type {
	AnyMcpCapabilityDefinition,
	McpCapabilityInstallWrap,
	McpCapabilityKind,
} from "./capability.ts";
import { contextOf } from "./handler-decorators.ts";

/**
 * The per-call view a middleware receives. Unlike `decorateHandlers` (which bakes wrappers into a
 * definition at authoring time), middleware runs through the install seam of
 * `McpServerDefinition.instantiate`, so it also sees the request context (`era`, `authInfo`,
 * `requestInfo`) the per-request factory was materialized with.
 */
export interface McpMiddlewareContext {
	readonly kind: McpCapabilityKind;
	readonly name: string;
	readonly definition: AnyMcpCapabilityDefinition;
	/** The materialization context: protocol era, verified `authInfo`, request info. */
	readonly request: McpRequestContext;
	/** The SDK `ServerContext` of the current call. */
	readonly server: ServerContext;
	/** The leading SDK-shaped arguments, without the trailing `ServerContext`. */
	readonly args: readonly unknown[];
}

export type McpMiddlewareNext = (context: McpMiddlewareContext) => Promise<unknown>;

/**
 * A capability-call middleware. Call `next(context)` to continue; pass a derived context
 * (`next({ ...context, args })`) to rewrite the arguments the handler receives. Middleware MUST
 * pass an `InputRequiredResult` through unchanged so the SDK's multi-round-trip handling applies.
 */
export type McpMiddleware = (
	context: McpMiddlewareContext,
	next: McpMiddlewareNext,
) => MaybePromise<unknown>;

/**
 * Builds the install-time wrap for a middleware chain. The chain is composed once per capability
 * per materialization; `middleware[0]` is outermost.
 */
export function middlewareInstallWrap(
	middleware: readonly McpMiddleware[],
	request: McpRequestContext,
): McpCapabilityInstallWrap {
	for (const entry of middleware) {
		if (typeof entry !== "function") throw new TypeError("middleware must be functions.");
	}
	const chain = Object.freeze([...middleware]);
	return (handler, definition) => {
		const terminal: McpMiddlewareNext = (context) =>
			Promise.resolve(handler(...([...context.args, context.server] as never[])));
		const composed = chain.reduceRight<McpMiddlewareNext>(
			(next, entry) => (context) => Promise.resolve(entry(context, next)),
			terminal,
		);
		return (...args: never[]) => {
			const server = contextOf(args);
			return composed(
				Object.freeze({
					kind: definition.kind,
					name: definition.name,
					definition,
					request,
					server,
					args: Object.freeze(args.slice(0, -1)),
				}),
			);
		};
	};
}

export interface McpMiddlewareLogEntry {
	readonly kind: McpCapabilityKind;
	readonly name: string;
	readonly era: McpRequestContext["era"];
	readonly durationMs: number;
	readonly ok: boolean;
	readonly error?: unknown;
}

/** Reports every call with its outcome and duration (no default sink: on stdio, stdout is the protocol). */
export function logMiddleware(emit: (entry: McpMiddlewareLogEntry) => void): McpMiddleware {
	if (typeof emit !== "function") throw new TypeError("emit must be a function.");
	return async (context, next) => {
		const started = performance.now();
		const base = { kind: context.kind, name: context.name, era: context.request.era };
		try {
			const result = await next(context);
			emit({ ...base, durationMs: performance.now() - started, ok: true });
			return result;
		} catch (error) {
			emit({ ...base, durationMs: performance.now() - started, ok: false, error });
			throw error;
		}
	};
}

export interface McpTimingEntry {
	readonly kind: McpCapabilityKind;
	readonly name: string;
	readonly durationMs: number;
}

/** Reports the wall-clock duration of every call, success or failure. */
export function timingMiddleware(emit: (entry: McpTimingEntry) => void): McpMiddleware {
	if (typeof emit !== "function") throw new TypeError("emit must be a function.");
	return async (context, next) => {
		const started = performance.now();
		try {
			return await next(context);
		} finally {
			emit({
				kind: context.kind,
				name: context.name,
				durationMs: performance.now() - started,
			});
		}
	};
}

export type McpMiddlewareKeyFn = (context: McpMiddlewareContext) => MaybePromise<string>;

/** The default rate/partition key: `sha256(bearer token)` for authenticated requests, `anon` otherwise. */
export async function middlewarePrincipal(context: McpMiddlewareContext): Promise<string> {
	const token = context.request.authInfo?.token ?? context.server.http?.authInfo?.token;
	if (token === undefined || token === "") return "anon";
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface TokenBucketOptions {
	/** Maximum burst size (whole tokens). */
	readonly capacity: number;
	/** Sustained refill rate, tokens per second. */
	readonly refillPerSecond: number;
	/** Partition key; defaults to the principal partition. */
	readonly key?: McpMiddlewareKeyFn;
	/** Injectable clock (ms), for tests. */
	readonly now?: () => number;
}

/**
 * A token bucket per partition, shared by every capability the chain wraps. Unlike the
 * fixed-window `rateLimit` decorator, bursts are bounded by `capacity` even across window edges.
 */
export function tokenBucketMiddleware(options: TokenBucketOptions): McpMiddleware {
	const { capacity, refillPerSecond } = options;
	if (!Number.isSafeInteger(capacity) || capacity <= 0) {
		throw new RangeError("capacity must be a positive integer.");
	}
	if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
		throw new RangeError("refillPerSecond must be positive.");
	}
	const now = options.now ?? Date.now;
	const buckets = new Map<string, { tokens: number; refilledAt: number }>();
	return async (context, next) => {
		const key = await (options.key ?? middlewarePrincipal)(context);
		const at = now();
		let bucket = buckets.get(key);
		if (bucket === undefined) {
			bucket = { tokens: capacity, refilledAt: at };
			buckets.set(key, bucket);
		} else {
			const elapsed = Math.max(0, at - bucket.refilledAt);
			bucket.tokens = Math.min(capacity, bucket.tokens + (elapsed / 1000) * refillPerSecond);
			bucket.refilledAt = at;
		}
		if (bucket.tokens < 1) {
			throw new KmcpError(
				KMCP_ERROR_CODES.RATE_LIMITED,
				`Rate limit exceeded for ${context.kind} '${context.name}'.`,
			);
		}
		bucket.tokens -= 1;
		return next(context);
	};
}

export interface MaskErrorOptions {
	/** The replacement message. Default: `"Internal error."`. */
	readonly message?: string;
	/** Observability seam receiving the original error before it is masked. */
	readonly onerror?: (error: unknown, context: McpMiddlewareContext) => void;
	/** Errors for which the original message is safe to expose (they re-throw unmasked). */
	readonly passthrough?: (error: unknown) => boolean;
}

/**
 * Replaces thrown error messages with a generic one, so stack details and internal state never
 * reach the client (for tools the SDK turns the throw into an `isError` result whose text is the
 * message). The original error is only observable through `onerror`.
 */
export function maskErrorDetails(options: MaskErrorOptions = {}): McpMiddleware {
	const message = options.message ?? "Internal error.";
	return async (context, next) => {
		try {
			return await next(context);
		} catch (error) {
			if (options.passthrough?.(error) === true) throw error;
			try {
				options.onerror?.(error, context);
			} catch {
				// The observability seam cannot alter the masking outcome.
			}
			throw new Error(message);
		}
	};
}

/**
 * Rejects results whose JSON serialization exceeds `maxBytes` (UTF-8). `InputRequiredResult`s
 * pass through unmeasured: rejecting one mid-flow would strand a multi-round-trip call.
 */
export function responseLimit(maxBytes: number): McpMiddleware {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
		throw new RangeError("maxBytes must be a positive integer.");
	}
	const encoder = new TextEncoder();
	return async (context, next) => {
		const result = await next(context);
		if (isInputRequiredResult(result)) return result;
		const size = encoder.encode(JSON.stringify(result)).byteLength;
		if (size > maxBytes) {
			throw new KmcpError(
				KMCP_ERROR_CODES.RESULT_TOO_LARGE,
				`${context.kind} '${context.name}' produced ${size} bytes; the limit is ${maxBytes}.`,
			);
		}
		return result;
	};
}
