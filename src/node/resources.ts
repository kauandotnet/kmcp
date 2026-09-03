import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import type { ReadResourceResult } from "@modelcontextprotocol/client";

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
