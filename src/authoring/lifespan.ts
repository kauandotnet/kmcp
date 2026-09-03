import type { MaybePromise } from "../internal/value.ts";

/**
 * A process-level resource scope for a serving entry (`handler()`, `serveMcpHttp`,
 * `serveMcpStdio`): `start()` runs before the entry begins serving; `stop(state)` runs after the
 * returned handle's `close()` completes.
 */
export interface McpLifespan<State = void> {
	start(): MaybePromise<State>;
	stop?(state: State): MaybePromise<void>;
}

/**
 * Runs `serve` inside `lifespan`. The returned handle's `close()` is composed so `stop(state)`
 * runs after the underlying close settles; when both fail, an `AggregateError` carries both. A
 * `serve` failure still runs `stop` before rethrowing.
 */
export async function serveWithLifespan<State, Handle extends { close(): Promise<void> }>(
	lifespan: McpLifespan<State>,
	serve: (state: State) => MaybePromise<Handle>,
): Promise<Handle> {
	if (typeof lifespan?.start !== "function") throw new TypeError("lifespan.start is required.");
	if (typeof serve !== "function") throw new TypeError("serve must be a function.");
	const state = await lifespan.start();
	let handle: Handle;
	try {
		handle = await serve(state);
	} catch (error) {
		try {
			await lifespan.stop?.(state);
		} catch (stopError) {
			throw new AggregateError([error, stopError], "Serve and lifespan stop both failed.");
		}
		throw error;
	}
	const close = handle.close.bind(handle);
	let closing: Promise<void> | undefined;
	handle.close = () => {
		closing ??= (async () => {
			let closeError: unknown;
			let closeFailed = false;
			try {
				await close();
			} catch (error) {
				closeError = error;
				closeFailed = true;
			}
			try {
				await lifespan.stop?.(state);
			} catch (stopError) {
				if (closeFailed) {
					throw new AggregateError([closeError, stopError], "Close and lifespan stop both failed.");
				}
				throw stopError;
			}
			if (closeFailed) throw closeError;
		})();
		return closing;
	};
	return handle;
}
