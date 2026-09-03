import type { Icon, StandardSchemaWithJSON, ToolAnnotations } from "@modelcontextprotocol/server";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import type { McpDeepReadonly } from "../internal/value.ts";
import { transformInputSchema, type SchemaArgTransform } from "../internal/schema-transform.ts";
import {
	McpToolDefinition,
	type AnyMcpToolDefinition,
	type AnyMcpToolOptions,
} from "./capability.ts";
import { mapCapabilities, type McpDefinitionTransform } from "./transform.ts";

export type McpArgTransform = SchemaArgTransform;

export interface McpToolTransformOptions {
	readonly name?: string;
	readonly title?: string;
	readonly description?: string;
	readonly annotations?: McpDeepReadonly<ToolAnnotations>;
	readonly icons?: readonly McpDeepReadonly<Icon>[];
	readonly _meta?: McpDeepReadonly<Readonly<Record<string, unknown>>>;
	readonly tags?: readonly string[];
	/** Per-argument rewrites of the ADVERTISED input schema (rename / re-describe / hide). */
	readonly args?: Readonly<Record<string, McpArgTransform>>;
}

interface ErasedToolOptions extends AnyMcpToolOptions {
	readonly inputSchema?: StandardSchemaWithJSON;
	readonly outputSchema?: StandardSchemaWithJSON;
}

/**
 * Derives a new canonical tool from an existing one: metadata is patched, and argument transforms
 * are applied by wrapping the input schema (see `transformInputSchema`) — the original handler is
 * reused verbatim and keeps receiving underlying-shaped, validated arguments.
 */
export function transformTool(
	definition: AnyMcpToolDefinition,
	options: McpToolTransformOptions,
): AnyMcpToolDefinition {
	if (!(definition instanceof McpToolDefinition)) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			"transformTool requires a canonical McpToolDefinition.",
		);
	}
	const current = definition.options as unknown as ErasedToolOptions;
	let inputSchema = current.inputSchema;
	if (options.args !== undefined && Object.keys(options.args).length > 0) {
		if (inputSchema === undefined) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				`Tool '${definition.name}' has no inputSchema; there are no arguments to transform.`,
			);
		}
		inputSchema = transformInputSchema(inputSchema, options.args, `tool '${definition.name}'`);
	}
	const nextOptions = {
		...current,
		...(inputSchema === undefined ? {} : { inputSchema }),
		...(options.title === undefined ? {} : { title: options.title }),
		...(options.description === undefined ? {} : { description: options.description }),
		...(options.annotations === undefined ? {} : { annotations: options.annotations }),
		...(options.icons === undefined ? {} : { icons: options.icons }),
		...(options._meta === undefined ? {} : { _meta: options._meta }),
		...(options.tags === undefined ? {} : { tags: options.tags }),
	} as ErasedToolOptions;
	return new McpToolDefinition(
		options.name ?? definition.name,
		nextOptions as never,
		definition.handler as never,
	) as AnyMcpToolDefinition;
}

/**
 * A definition transform applying `transformTool` per tool name. Unknown names are refused
 * (`INVALID_DEFINITION`) — a transform that silently matches nothing hides configuration drift.
 */
export function transformTools(
	transforms: Readonly<Record<string, McpToolTransformOptions>>,
): McpDefinitionTransform {
	const pending = new Set(Object.keys(transforms));
	return (definition) => {
		for (const capability of definition.capabilities) {
			if (capability.kind === "tool") pending.delete(capability.name);
		}
		if (pending.size > 0) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				`transformTools names unknown tool(s): ${[...pending].join(", ")}.`,
			);
		}
		return mapCapabilities({
			tool: (tool) => {
				const options = transforms[tool.name];
				return options === undefined ? tool : transformTool(tool, options);
			},
		})(definition);
	};
}
