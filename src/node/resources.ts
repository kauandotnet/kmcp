import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import type { ReadResourceResult } from "@modelcontextprotocol/client";

import type { McpConnectionManager } from "../client/manager.ts";
import {
	type McpDecodeResourceOptions,
	type McpDecodedResourceContent,
	decodeResourceContent,
} from "../client/resources.ts";
import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";

export interface McpWriteResourceFileOptions extends McpDecodeResourceOptions {
	/** File mode for the written file. Default: the process umask applies (`0o666`). */
	readonly mode?: number;
}

export interface McpWrittenResourceFile {
	readonly path: string;
	readonly bytes: number;
	readonly mimeType?: string;
	readonly binary: boolean;
}

/**
 * Materializes one `resources/read` content item into a local file, atomically (temporary file
 * in the same directory plus `rename`), creating parent directories as needed. The target is a
 * copy of the resource, so an existing file is overwritten; a directory at the path is refused.
 * Pair it with the manager's `resource.updated` events to keep a file in sync.
 */
export async function writeResourceToFile(
	result: ReadResourceResult,
	requestedUri: string,
	path: string,
	options: McpWriteResourceFileOptions = {},
): Promise<McpWrittenResourceFile> {
	const decoded = decodeResourceContent(result, requestedUri, options);
	await writeDecodedResource(decoded, path, options);
	return Object.freeze({
		path,
		bytes: decoded.bytes.byteLength,
		...(decoded.mimeType === undefined ? {} : { mimeType: decoded.mimeType }),
		binary: decoded.binary,
	});
}

/** Writes already-decoded resource bytes to `path` with the same atomic discipline. */
export async function writeDecodedResource(
	decoded: McpDecodedResourceContent,
	path: string,
	options: Pick<McpWriteResourceFileOptions, "mode"> = {},
): Promise<void> {
	if (!isAbsolute(path)) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`The resource target path must be absolute: '${path}'.`,
		);
	}
	try {
		if ((await stat(path)).isDirectory()) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				`The resource target path is a directory: '${path}'.`,
			);
		}
	} catch (error) {
		if (error instanceof KmcpError) throw error;
		// Absent target: the write below creates it.
	}
	const directory = dirname(path);
	await mkdir(directory, { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(
			temporary,
			decoded.bytes,
			options.mode === undefined ? {} : { mode: options.mode },
		);
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

export interface McpResourceFileSyncOptions extends McpWriteResourceFileOptions {
	/** Observes every successful write, including the initial one. */
	readonly onSynced?: (result: McpWrittenResourceFile) => void;
	/** Observes a failed re-sync; the previous file content stays in place. */
	readonly onError?: (error: unknown) => void;
}

/** A live resource-to-file synchronization (see {@link syncResourceToFile}). */
export interface McpResourceFileSync extends AsyncDisposable {
	readonly connectionId: string;
	readonly uri: string;
	readonly path: string;
	/** ISO timestamp of the last successful write. */
	readonly lastSyncedAt: string | undefined;
	/** The last re-sync failure, cleared by the next success. */
	readonly lastError: unknown;
	/** Successful writes so far. */
	readonly syncs: number;
	/**
	 * Re-reads and rewrites now, resolving on a read taken no earlier than this call. Concurrent
	 * callers coalesce into ONE follow-up run rather than joining the read already in flight. A
	 * no-op after `stop()`.
	 */
	sync(): Promise<void>;
	/** Stops following updates and drops the subscription; the file is kept. */
	stop(): Promise<void>;
}

/**
 * Keeps a local file in step with a resource: subscribes to it, writes it once, rewrites it on
 * every `resource.updated` event for the URI (bursts coalesce into one follow-up sync), and
 * re-subscribes after the connection comes back on a new generation (subscriptions are
 * generation-scoped). A removed connection stops the sync. The initial write must succeed; a
 * later failure is reported through `onError` and `lastError` while the previous file stays.
 */
export async function syncResourceToFile<Id extends string>(
	manager: McpConnectionManager<Id>,
	id: Id,
	uri: string,
	path: string,
	options: McpResourceFileSyncOptions = {},
): Promise<McpResourceFileSync> {
	let generation = manager.state(id).generation;
	let lastSyncedAt: string | undefined;
	let lastError: unknown;
	let syncs = 0;
	let inFlight: Promise<void> | undefined;
	let pending: PromiseWithResolvers<void> | undefined;
	let resubscribing: Promise<void> | undefined;
	let stopped = false;

	const write = async (): Promise<void> => {
		const result = await manager.readResource(id, uri, { cacheMode: "refresh" });
		const written = await writeResourceToFile(result, uri, path, options);
		syncs += 1;
		lastSyncedAt = new Date().toISOString();
		lastError = undefined;
		options.onSynced?.(written);
	};

	const run = (): Promise<void> => {
		if (stopped) return Promise.resolve();
		if (inFlight !== undefined) {
			// The in-flight read was taken BEFORE this caller asked, so its result cannot answer
			// them. Hand back the coalesced follow-up instead, which reads after this moment.
			pending ??= Promise.withResolvers<void>();
			return pending.promise;
		}
		inFlight = write()
			.catch((error: unknown) => {
				lastError = error;
				options.onError?.(error);
			})
			.finally(() => {
				inFlight = undefined;
				const waiting = pending;
				pending = undefined;
				if (waiting === undefined) return;
				// Not awaited: the follow-up must not extend the run its waiters are chained off.
				const settle = (): void => waiting.resolve();
				void run().then(settle, settle);
			});
		return inFlight;
	};

	await manager.subscribeResource(id, uri);
	try {
		await write();
	} catch (error) {
		await manager.unsubscribeResource(id, uri).catch(() => undefined);
		throw error;
	}

	const unsubscribe = manager.subscribe((event) => {
		if (stopped || event.connection.id !== id) return;
		if (event.type === "resource.updated") {
			if (event.resource?.uri === uri) void run();
			return;
		}
		if (event.type === "connection.removed") {
			void stop();
			return;
		}
		if (
			event.type === "connection.state.changed" &&
			(event.connection.phase === "online" || event.connection.phase === "degraded") &&
			event.connection.generation !== generation
		) {
			generation = event.connection.generation;
			// Held so `stop()` can await it: the re-subscribe resolves on the manager's turn, and
			// without the handle a `stop()` in between would rewrite the file and strand the
			// server-side subscription this call just opened.
			resubscribing = manager
				.subscribeResource(id, uri)
				.then(async () => {
					if (stopped) return;
					await run();
				})
				.catch((error: unknown) => {
					if (stopped) return;
					lastError = error;
					options.onError?.(error);
				});
		}
	});

	async function stop(): Promise<void> {
		if (stopped) return;
		stopped = true;
		unsubscribe();
		await inFlight?.catch(() => undefined);
		await resubscribing?.catch(() => undefined);
		const phase = safeState(manager, id)?.phase;
		if (phase === "online" || phase === "degraded") {
			await manager.unsubscribeResource(id, uri).catch(() => undefined);
		}
	}

	return Object.freeze({
		connectionId: id,
		uri,
		path,
		get lastSyncedAt() {
			return lastSyncedAt;
		},
		get lastError() {
			return lastError;
		},
		get syncs() {
			return syncs;
		},
		sync: run,
		stop,
		[Symbol.asyncDispose]: stop,
	});
}

function safeState<Id extends string>(manager: McpConnectionManager<Id>, id: Id) {
	try {
		return manager.state(id);
	} catch {
		return undefined;
	}
}
