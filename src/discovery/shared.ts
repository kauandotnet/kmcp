import {
	fromJsonSchema,
	type CallToolResult,
	type JsonSchemaType,
	type ServerContext,
	type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";

import type { AnyMcpToolDefinition } from "../authoring/capability.ts";
import { defineTool } from "../authoring/capability.ts";

export type McpToolSerialization = "brief" | "detailed";

interface ErasedSchemas {
	readonly inputSchema?: StandardSchemaWithJSON;
	readonly outputSchema?: StandardSchemaWithJSON;
}

export function toolInputSchema(tool: AnyMcpToolDefinition): StandardSchemaWithJSON | undefined {
	return (tool.options as unknown as ErasedSchemas).inputSchema;
}

/** The advertised JSON projection of a tool's input schema, or `undefined` when unprojectable. */
export function toolInputProjection(
	tool: AnyMcpToolDefinition,
): Record<string, unknown> | undefined {
	const schema = toolInputSchema(tool);
	if (schema === undefined) return undefined;
	try {
		return schema["~standard"].jsonSchema.input({ target: "draft-2020-12" });
	} catch {
		return undefined;
	}
}

export function searchableToolText(tool: AnyMcpToolDefinition): string {
	const parts: string[] = [tool.name];
	if (tool.options.title !== undefined) parts.push(tool.options.title);
	if (tool.options.description !== undefined) parts.push(tool.options.description);
	for (const tag of tool.tags) parts.push(tag);
	const projection = toolInputProjection(tool);
	const properties = projection?.["properties"];
	if (properties !== null && typeof properties === "object") {
		for (const [name, definition] of Object.entries(properties as Record<string, unknown>)) {
			parts.push(name);
			if (
				definition !== null &&
				typeof definition === "object" &&
				typeof (definition as Record<string, unknown>)["description"] === "string"
			) {
				parts.push((definition as Record<string, unknown>)["description"] as string);
			}
		}
	}
	return parts.join(" ");
}

export function serializeTool(
	tool: AnyMcpToolDefinition,
	serialization: McpToolSerialization,
): Record<string, unknown> {
	return {
		name: tool.name,
		...(tool.options.title === undefined ? {} : { title: tool.options.title }),
		...(tool.options.description === undefined ? {} : { description: tool.options.description }),
		...(serialization === "detailed"
			? { inputSchema: toolInputProjection(tool) ?? { type: "object" } }
			: {}),
	};
}

function issuePath(
	path: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined,
): string {
	if (path === undefined) return "";
	return path
		.map((segment) =>
			typeof segment === "object" && segment !== null ? String(segment.key) : String(segment),
		)
		.join(".");
}

function errorResult(text: string): CallToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

/**
 * The `call_tool` proxy: resolves `name` against the SAME per-request admitted array the search
 * tool saw, validates arguments against the target's input schema, and delegates to its handler.
 * Meta-tool names are refused so the proxy cannot recurse.
 */
export function callToolProxy(
	name: string,
	tools: readonly AnyMcpToolDefinition[],
	reservedNames: readonly string[],
): AnyMcpToolDefinition {
	const reserved = new Set(reservedNames);
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	return defineTool(
		name,
		{
			description: "Invokes one of this server's tools by name with the given arguments.",
			inputSchema: fromJsonSchema<{ name: string; arguments?: Record<string, unknown> }>({
				type: "object",
				properties: {
					name: { type: "string", description: "The tool name, as returned by search." },
					arguments: {
						type: "object",
						description: "The tool's arguments, matching its input schema.",
					},
				},
				required: ["name"],
			} as JsonSchemaType),
		},
		async ({ name: target, arguments: args }, ctx) =>
			invokeAdmittedTool(byName, reserved, target, args, ctx),
	) as AnyMcpToolDefinition;
}

export async function invokeAdmittedTool(
	byName: ReadonlyMap<string, AnyMcpToolDefinition>,
	reserved: ReadonlySet<string>,
	target: string,
	args: Record<string, unknown> | undefined,
	ctx: ServerContext,
): Promise<CallToolResult> {
	if (reserved.has(target)) return errorResult(`'${target}' cannot be called through the proxy.`);
	const tool = byName.get(target);
	if (tool === undefined) return errorResult(`Unknown tool '${target}'.`);
	const schema = toolInputSchema(tool);
	if (schema === undefined) {
		const handler = tool.handler as (ctx: ServerContext) => Promise<CallToolResult>;
		return handler(ctx);
	}
	const validated = await schema["~standard"].validate(args ?? {});
	if (validated.issues !== undefined) {
		return errorResult(
			`Invalid arguments for '${target}': ${validated.issues
				.map((issue) => `${issuePath(issue.path)} ${issue.message}`.trim())
				.join("; ")}`,
		);
	}
	const handler = tool.handler as (args: unknown, ctx: ServerContext) => Promise<CallToolResult>;
	return handler(validated.value, ctx);
}
