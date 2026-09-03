import {
	fromJsonSchema,
	isInputRequiredResult,
	UriTemplate,
	type CallToolResult,
	type GetPromptResult,
	type JsonSchemaType,
	type ReadResourceCallback,
	type ReadResourceResult,
	type ReadResourceTemplateCallback,
	type ServerContext,
	type StandardSchemaWithJSON,
	type Variables,
} from "@modelcontextprotocol/server";

import {
	defineTool,
	type AnyMcpPromptDefinition,
	type AnyMcpResourceDefinition,
	type AnyMcpResourceTemplateDefinition,
} from "../authoring/capability.ts";
import type { McpServerDefinition } from "../authoring/server-definition.ts";
import { deriveProviderDefinition } from "./derive.ts";

export interface McpAsToolsOptions {
	/** Keep the original capabilities listed alongside the synthesized tools. Default: `true`. */
	readonly keep?: boolean;
}

export interface McpResourcesAsToolsOptions extends McpAsToolsOptions {
	/** Default: `"list_resources"`. */
	readonly listToolName?: string;
	/** Default: `"read_resource"`. */
	readonly readToolName?: string;
}

/**
 * Synthesizes `list_resources` and `read_resource` tools over the per-request ADMITTED resources
 * and templates, for clients that only speak tools. Reads resolve static URIs exactly and
 * template URIs via the SDK `UriTemplate` matcher. Middleware sees these calls once — as tool
 * calls, not additionally as resource reads.
 */
export function resourcesAsTools(
	base: McpServerDefinition,
	options: McpResourcesAsToolsOptions = {},
): McpServerDefinition {
	const keep = options.keep !== false;
	const listToolName = options.listToolName ?? "list_resources";
	const readToolName = options.readToolName ?? "read_resource";
	const provider = async (context: Parameters<McpServerDefinition["admit"]>[0]) => {
		const admitted = await base.admit(context);
		const resources = admitted.filter(
			(capability): capability is AnyMcpResourceDefinition => capability.kind === "resource",
		);
		const templates = admitted.filter(
			(capability): capability is AnyMcpResourceTemplateDefinition =>
				capability.kind === "resource-template",
		);
		const rest = admitted.filter(
			(capability) =>
				keep || (capability.kind !== "resource" && capability.kind !== "resource-template"),
		);
		const list = defineTool(
			listToolName,
			{
				description: `Lists this server's resources and resource templates. Read one with ${readToolName}.`,
				annotations: { readOnlyHint: true },
			},
			async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								resources: resources.map((resource) => ({
									uri: resource.uri,
									name: resource.name,
									...(resource.options.title === undefined
										? {}
										: { title: resource.options.title }),
									...(resource.options.description === undefined
										? {}
										: { description: resource.options.description }),
									...(resource.options.mimeType === undefined
										? {}
										: { mimeType: resource.options.mimeType }),
								})),
								resourceTemplates: templates.map((template) => ({
									uriTemplate: template.uriTemplate,
									name: template.name,
									...(template.options.title === undefined
										? {}
										: { title: template.options.title }),
									...(template.options.description === undefined
										? {}
										: { description: template.options.description }),
									...(template.options.mimeType === undefined
										? {}
										: { mimeType: template.options.mimeType }),
								})),
							},
							undefined,
							"\t",
						),
					},
				],
			}),
		);
		const read = defineTool(
			readToolName,
			{
				description: "Reads a resource by URI (a listed resource or a template expansion).",
				annotations: { readOnlyHint: true },
				inputSchema: fromJsonSchema<{ uri: string }>({
					type: "object",
					properties: { uri: { type: "string", description: "The resource URI to read." } },
					required: ["uri"],
				} as JsonSchemaType),
			},
			async ({ uri }, ctx) => readAdmittedResource(resources, templates, uri, ctx),
		);
		return [...rest, list, read];
	};
	return deriveProviderDefinition(base, provider, ["tool"]);
}

async function readAdmittedResource(
	resources: readonly AnyMcpResourceDefinition[],
	templates: readonly AnyMcpResourceTemplateDefinition[],
	uri: string,
	ctx: ServerContext,
): Promise<CallToolResult> {
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return { content: [{ type: "text", text: `Invalid URI '${uri}'.` }], isError: true };
	}
	const resource = resources.find((candidate) => candidate.uri === uri);
	if (resource !== undefined) {
		const handler = resource.handler as ReadResourceCallback;
		return resourceToolResult(await handler(url, ctx));
	}
	for (const template of templates) {
		let variables: Variables | null;
		try {
			variables = new UriTemplate(template.uriTemplate).match(uri);
		} catch {
			variables = null;
		}
		if (variables === null) continue;
		const handler = template.handler as ReadResourceTemplateCallback;
		return resourceToolResult(await handler(url, variables, ctx));
	}
	return { content: [{ type: "text", text: `Unknown resource '${uri}'.` }], isError: true };
}

function resourceToolResult(result: Awaited<ReturnType<ReadResourceCallback>>): CallToolResult {
	if (isInputRequiredResult(result)) return result as unknown as CallToolResult;
	return {
		content: (result as ReadResourceResult).contents.map((contents) => ({
			type: "resource",
			resource: contents,
		})),
	};
}

export interface McpPromptsAsToolsOptions extends McpAsToolsOptions {
	/** Default: `"list_prompts"`. */
	readonly listToolName?: string;
	/** Default: `"get_prompt"`. */
	readonly getToolName?: string;
}

interface ErasedPromptOptions {
	readonly argsSchema?: StandardSchemaWithJSON;
}

/**
 * Synthesizes `list_prompts` and `get_prompt` tools over the per-request ADMITTED prompts, for
 * clients that only speak tools. Arguments are validated against the prompt's own schema; the
 * rendered prompt is returned as JSON text.
 */
export function promptsAsTools(
	base: McpServerDefinition,
	options: McpPromptsAsToolsOptions = {},
): McpServerDefinition {
	const keep = options.keep !== false;
	const listToolName = options.listToolName ?? "list_prompts";
	const getToolName = options.getToolName ?? "get_prompt";
	const provider = async (context: Parameters<McpServerDefinition["admit"]>[0]) => {
		const admitted = await base.admit(context);
		const prompts = admitted.filter(
			(capability): capability is AnyMcpPromptDefinition => capability.kind === "prompt",
		);
		const rest = admitted.filter((capability) => keep || capability.kind !== "prompt");
		const list = defineTool(
			listToolName,
			{
				description: `Lists this server's prompts. Render one with ${getToolName}.`,
				annotations: { readOnlyHint: true },
			},
			async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								prompts: prompts.map((prompt) => ({
									name: prompt.name,
									...(prompt.options.title === undefined ? {} : { title: prompt.options.title }),
									...(prompt.options.description === undefined
										? {}
										: { description: prompt.options.description }),
									arguments: promptArgumentsProjection(prompt),
								})),
							},
							undefined,
							"\t",
						),
					},
				],
			}),
		);
		const get = defineTool(
			getToolName,
			{
				description: "Renders a prompt by name with the given arguments.",
				annotations: { readOnlyHint: true },
				inputSchema: fromJsonSchema<{ name: string; arguments?: Record<string, string> }>({
					type: "object",
					properties: {
						name: { type: "string", description: "The prompt name." },
						arguments: {
							type: "object",
							additionalProperties: { type: "string" },
							description: "The prompt's arguments, matching its declared schema.",
						},
					},
					required: ["name"],
				} as JsonSchemaType),
			},
			async ({ name, arguments: args }, ctx) => renderPrompt(prompts, name, args, ctx),
		);
		return [...rest, list, get];
	};
	return deriveProviderDefinition(base, provider, ["tool"]);
}

function promptArgumentsProjection(prompt: AnyMcpPromptDefinition): Record<string, unknown> {
	const schema = (prompt.options as unknown as ErasedPromptOptions).argsSchema;
	if (schema === undefined) return {};
	try {
		return schema["~standard"].jsonSchema.input({ target: "draft-2020-12" });
	} catch {
		return {};
	}
}

async function renderPrompt(
	prompts: readonly AnyMcpPromptDefinition[],
	name: string,
	args: Record<string, string> | undefined,
	ctx: ServerContext,
): Promise<CallToolResult> {
	const prompt = prompts.find((candidate) => candidate.name === name);
	if (prompt === undefined) {
		return { content: [{ type: "text", text: `Unknown prompt '${name}'.` }], isError: true };
	}
	const schema = (prompt.options as unknown as ErasedPromptOptions).argsSchema;
	let result: GetPromptResult | { readonly resultType: string };
	if (schema === undefined) {
		const handler = prompt.handler as (ctx: ServerContext) => Promise<GetPromptResult>;
		result = await handler(ctx);
	} else {
		const validated = await schema["~standard"].validate(args ?? {});
		if (validated.issues !== undefined) {
			return {
				content: [
					{
						type: "text",
						text: `Invalid arguments for '${name}': ${validated.issues
							.map((issue) => issue.message)
							.join("; ")}`,
					},
				],
				isError: true,
			};
		}
		const handler = prompt.handler as (
			args: unknown,
			ctx: ServerContext,
		) => Promise<GetPromptResult>;
		result = await handler(validated.value, ctx);
	}
	if (isInputRequiredResult(result)) return result as unknown as CallToolResult;
	return {
		content: [{ type: "text", text: JSON.stringify(result, undefined, "\t") }],
	};
}
