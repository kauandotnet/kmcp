import type { ReadResourceResult } from "@modelcontextprotocol/client";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import { decodeBase64 } from "../internal/base64.ts";

/** One `resources/read` content item materialized to bytes. */
export interface McpDecodedResourceContent {
	/** URI of the selected item, which may differ from the requested URI. */
	readonly uri: string;
	readonly mimeType?: string;
	/** UTF-8 bytes for `text` items, base64-decoded bytes for `blob` items. */
	readonly bytes: Uint8Array;
	/** The text for `text` items; absent for `blob` items. */
	readonly text?: string;
	/** True when the item carried base64 `blob` content. */
	readonly binary: boolean;
	/** Number of content items in the result the item was selected from. */
	readonly totalContents: number;
}

export interface McpDecodeResourceOptions {
	/** Reject payloads larger than this many bytes. Default: 64 MiB. */
	readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();

/**
 * Selects one content item from a `resources/read` result and decodes it to bytes: the item
 * whose `uri` matches the requested URI, else the first item. A read MAY return several items
 * (a directory URI expanding to files); callers that need all of them consume the raw result.
 */
export function decodeResourceContent(
	result: ReadResourceResult,
	requestedUri: string,
	options: McpDecodeResourceOptions = {},
): McpDecodedResourceContent {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const first = result.contents[0];
	if (first === undefined) {
		throw new KmcpError(
			KMCP_ERROR_CODES.OPERATION_FAILED,
			`Resource '${requestedUri}' returned no contents.`,
		);
	}
	const item = result.contents.find((candidate) => candidate.uri === requestedUri) ?? first;
	let bytes: Uint8Array;
	let text: string | undefined;
	let binary: boolean;
	if ("blob" in item && typeof item.blob === "string") {
		if (item.blob.length > (maxBytes * 4) / 3 + 4) throw tooLarge(requestedUri, maxBytes);
		bytes = decodeBase64(item.blob);
		binary = true;
	} else if ("text" in item && typeof item.text === "string") {
		text = item.text;
		bytes = encoder.encode(text);
		binary = false;
	} else {
		throw new KmcpError(
			KMCP_ERROR_CODES.OPERATION_FAILED,
			`Resource '${requestedUri}' returned a content item with neither text nor blob.`,
		);
	}
	if (bytes.byteLength > maxBytes) throw tooLarge(requestedUri, maxBytes);
	return Object.freeze({
		uri: item.uri || requestedUri,
		...(typeof item.mimeType === "string" && item.mimeType.length > 0
			? { mimeType: item.mimeType }
			: {}),
		bytes,
		...(text === undefined ? {} : { text }),
		binary,
		totalContents: result.contents.length,
	});
}

function tooLarge(uri: string, maxBytes: number): KmcpError {
	return new KmcpError(
		KMCP_ERROR_CODES.RESULT_TOO_LARGE,
		`Resource '${uri}' exceeds the ${maxBytes}-byte decode limit.`,
	);
}
