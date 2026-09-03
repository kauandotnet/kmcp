import {
	fromJsonSchema,
	type CallToolResult,
	type JsonSchemaType,
} from "@modelcontextprotocol/server";

import type { AnyMcpToolDefinition } from "../authoring/capability.ts";
import type { McpServerDefinition } from "../authoring/server-definition.ts";
import { defineTool } from "../authoring/capability.ts";
import { stableFingerprint } from "../internal/value.ts";
import { Bm25Index } from "./bm25.ts";
import { deriveProviderDefinition, FingerprintCache } from "./derive.ts";
import { regexSearch } from "./regex.ts";
import {
	callToolProxy,
	searchableToolText,
	serializeTool,
	type McpToolSerialization,
} from "./shared.ts";

export interface McpSearchToolsOptions {
	/** `"bm25"` (default) ranks by Okapi BM25; `"regex"` matches a caller-supplied pattern. */
	readonly scorer?: "bm25" | "regex";
	/** Maximum results per search. Default: 5. */
	readonly maxResults?: number;
	/** Tool names that stay directly listed (and directly callable) besides the meta-tools. */
	readonly alwaysVisible?: readonly string[];
	/** Default: `"search_tools"`. */
	readonly searchToolName?: string;
	/** Default: `"call_tool"`. */
	readonly callToolName?: string;
	/** How matched tools are serialized. Default: `"brief"` (name/title/description only). */
	readonly serialize?: McpToolSerialization;
}

/**
 * Replaces the tool catalog with two meta-tools — `search_tools` and `call_tool` — so a large
 * catalog costs two schemas instead of hundreds. Both resolve against the per-request ADMITTED
 * set (`base.admit`), so visibility and per-capability auth keep holding: a tool the principal
 * cannot see cannot be found or called through the proxy. Prompts, resources, and templates pass
 * through unchanged.
 */
export function searchTools(
	base: McpServerDefinition,
	options: McpSearchToolsOptions = {},
): McpServerDefinition {
	const scorer = options.scorer ?? "bm25";
	const maxResults = options.maxResults ?? 5;
	if (!Number.isSafeInteger(maxResults) || maxResults <= 0) {
		throw new RangeError("maxResults must be a positive integer.");
	}
	const searchToolName = options.searchToolName ?? "search_tools";
	const callToolName = options.callToolName ?? "call_tool";
	if (searchToolName === callToolName) {
		throw new RangeError("searchToolName and callToolName must differ.");
	}
	const alwaysVisible = new Set(options.alwaysVisible ?? []);
	const serialization = options.serialize ?? "brief";
	const indexes = new FingerprintCache<Bm25Index>();

	const provider = async (context: Parameters<McpServerDefinition["admit"]>[0]) => {
		const admitted = await base.admit(context);
		const tools = admitted.filter(
			(capability): capability is AnyMcpToolDefinition => capability.kind === "tool",
		);
		const rest = admitted.filter((capability) => capability.kind !== "tool");
		const pinned = tools.filter((tool) => alwaysVisible.has(tool.name));
		const documents = tools.map((tool) => ({ id: tool.name, text: searchableToolText(tool) }));
		const search = defineTool(
			searchToolName,
			{
				description:
					scorer === "bm25"
						? `Searches this server's tools by keyword relevance. Call ${callToolName} with a result's name to invoke it.`
						: `Searches this server's tools with a regular expression. Call ${callToolName} with a result's name to invoke it.`,
				annotations: { readOnlyHint: true },
				inputSchema: fromJsonSchema<{ query: string; limit?: number }>({
					type: "object",
					properties: {
						query:
							scorer === "bm25"
								? { type: "string", description: "Keywords describing the needed tool." }
								: {
										type: "string",
										description: "A regular expression matched case-insensitively.",
									},
						limit: {
							type: "integer",
							minimum: 1,
							maximum: maxResults,
							description: `Maximum results (default ${maxResults}).`,
						},
					},
					required: ["query"],
				} as JsonSchemaType),
			},
			async ({ query, limit }) => {
				const cap = Math.min(maxResults, limit ?? maxResults);
				const ids =
					scorer === "bm25"
						? indexes
								.get(stableFingerprint(documents), () => new Bm25Index(documents))
								.search(query, cap)
						: regexSearch(documents, query, cap);
				const byName = new Map(tools.map((tool) => [tool.name, tool]));
				const results = ids
					.map((id) => byName.get(id))
					.filter((tool): tool is AnyMcpToolDefinition => tool !== undefined)
					.map((tool) => serializeTool(tool, serialization));
				return {
					content: [{ type: "text", text: JSON.stringify({ tools: results }, undefined, "\t") }],
				} satisfies CallToolResult;
			},
		);
		const call = callToolProxy(callToolName, tools, [searchToolName, callToolName]);
		return [...rest, ...pinned, search, call];
	};
	return deriveProviderDefinition(base, provider, ["tool"]);
}
