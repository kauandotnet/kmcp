import type {
	Annotations,
	AudioContent,
	BlobResourceContents,
	CallToolResult,
	ContentBlock,
	EmbeddedResource,
	GetPromptResult,
	ImageContent,
	PromptMessage,
	ReadResourceResult,
	ResourceLink,
	TextContent,
	TextResourceContents,
} from "@modelcontextprotocol/server";

import { toBase64 } from "../internal/base64.ts";

type ContentExtras = {
	readonly annotations?: Annotations;
	readonly _meta?: Record<string, unknown>;
};

function extras(options: ContentExtras | undefined): ContentExtras {
	return {
		...(options?.annotations === undefined ? {} : { annotations: options.annotations }),
		...(options?._meta === undefined ? {} : { _meta: options._meta }),
	};
}

/** A `text` content block. */
export function textContent(text: string, options?: ContentExtras): TextContent {
	return { type: "text", text, ...extras(options) };
}

/** An `image` content block; `data` may be raw bytes or already-encoded base64. */
export function imageContent(
	data: Uint8Array | string,
	mimeType: string,
	options?: ContentExtras,
): ImageContent {
	return { type: "image", data: toBase64(data), mimeType, ...extras(options) };
}

/** An `audio` content block; `data` may be raw bytes or already-encoded base64. */
export function audioContent(
	data: Uint8Array | string,
	mimeType: string,
	options?: ContentExtras,
): AudioContent {
	return { type: "audio", data: toBase64(data), mimeType, ...extras(options) };
}

export interface ResourceLinkOptions extends ContentExtras {
	readonly title?: string;
	readonly description?: string;
	readonly mimeType?: string;
	readonly size?: number;
}

/** A `resource_link` content block pointing at a resource the client may read later. */
export function resourceLink(
	uri: string,
	name: string,
	options?: ResourceLinkOptions,
): ResourceLink {
	return {
		type: "resource_link",
		uri,
		name,
		...(options?.title === undefined ? {} : { title: options.title }),
		...(options?.description === undefined ? {} : { description: options.description }),
		...(options?.mimeType === undefined ? {} : { mimeType: options.mimeType }),
		...(options?.size === undefined ? {} : { size: options.size }),
		...extras(options),
	};
}

/** Text contents for `resources/read` results and embedded resources. */
export function textResourceContents(
	uri: string,
	text: string,
	options?: { readonly mimeType?: string; readonly _meta?: Record<string, unknown> },
): TextResourceContents {
	return {
		uri,
		text,
		...(options?.mimeType === undefined ? {} : { mimeType: options.mimeType }),
		...(options?._meta === undefined ? {} : { _meta: options._meta }),
	};
}

/** Binary contents for `resources/read` results and embedded resources; `blob` may be raw bytes or base64. */
export function blobResourceContents(
	uri: string,
	blob: Uint8Array | string,
	options?: { readonly mimeType?: string; readonly _meta?: Record<string, unknown> },
): BlobResourceContents {
	return {
		uri,
		blob: toBase64(blob),
		...(options?.mimeType === undefined ? {} : { mimeType: options.mimeType }),
		...(options?._meta === undefined ? {} : { _meta: options._meta }),
	};
}

/** An embedded `resource` content block carrying text. */
export function embeddedTextResource(
	uri: string,
	text: string,
	options?: { readonly mimeType?: string } & ContentExtras,
): EmbeddedResource {
	return {
		type: "resource",
		resource: textResourceContents(uri, text, options),
		...extras(options),
	};
}

/** An embedded `resource` content block carrying bytes. */
export function embeddedBlobResource(
	uri: string,
	blob: Uint8Array | string,
	options?: { readonly mimeType?: string } & ContentExtras,
): EmbeddedResource {
	return {
		type: "resource",
		resource: blobResourceContents(uri, blob, options),
		...extras(options),
	};
}

export type McpToolSuccess = CallToolResult & { readonly isError?: false };

export type McpToolErrorResult = CallToolResult & { readonly isError: true };

/** A successful tool result made of the given content blocks. */
export function toolResult(...content: readonly ContentBlock[]): McpToolSuccess {
	return { content: [...content] };
}

export type McpJsonResult<Value> = CallToolResult & {
	readonly isError?: false;
	readonly structuredContent: Value;
};

/**
 * A successful tool result whose `structuredContent` is `value`. When no content blocks are
 * given, a JSON text block of the value is emitted so clients without structured-content support
 * still see it. The value type is preserved so the result stays assignable to a schema-typed
 * `McpToolSuccessResult<Output>`.
 */
export function jsonResult<const Value extends Readonly<Record<string, unknown>>>(
	value: Value,
	...content: readonly ContentBlock[]
): McpJsonResult<Value> {
	return {
		content: content.length === 0 ? [textContent(JSON.stringify(value))] : [...content],
		structuredContent: value,
	};
}

/** A tool execution error (`isError: true`) with a text message and optional extra content. */
export function errorResult(
	message: string,
	...content: readonly ContentBlock[]
): McpToolErrorResult {
	return { content: [textContent(message), ...content], isError: true };
}

/** A user-role prompt message; a bare string becomes a text block. */
export function userMessage(content: string | PromptMessage["content"]): PromptMessage {
	return { role: "user", content: typeof content === "string" ? textContent(content) : content };
}

/** An assistant-role prompt message; a bare string becomes a text block. */
export function assistantMessage(content: string | PromptMessage["content"]): PromptMessage {
	return {
		role: "assistant",
		content: typeof content === "string" ? textContent(content) : content,
	};
}

/** A `prompts/get` result. */
export function promptResult(
	messages: PromptMessage | readonly PromptMessage[],
	description?: string,
): GetPromptResult {
	return {
		messages: Array.isArray(messages) ? [...messages] : [messages as PromptMessage],
		...(description === undefined ? {} : { description }),
	};
}

/** A `resources/read` result with a single text or blob contents entry. */
export function resourceResult(
	uri: string,
	contents:
		| { readonly text: string; readonly mimeType?: string }
		| { readonly blob: Uint8Array | string; readonly mimeType?: string },
): ReadResourceResult {
	const mimeType = contents.mimeType;
	const entry =
		"text" in contents
			? textResourceContents(uri, contents.text, mimeType === undefined ? undefined : { mimeType })
			: blobResourceContents(uri, contents.blob, mimeType === undefined ? undefined : { mimeType });
	return { contents: [entry] };
}
