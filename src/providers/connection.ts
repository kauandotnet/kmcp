import {
	fromJsonSchema,
	type JsonSchemaType,
	type McpRequestContext,
	type ServerContext,
} from "@modelcontextprotocol/server";

import {
	definePrompt,
	defineResource,
	defineResourceTemplate,
	defineTool,
	type AnyMcpCapabilityDefinition,
	type McpToolResult,
} from "../authoring/capability.ts";
import { progress } from "../authoring/context.ts";
import type { McpCapabilityProvider } from "../authoring/server-definition.ts";
import type { McpConnectionManager, McpConnectionOperationControl } from "../client/manager.ts";
import { gatewayProtocolError } from "../gateway/gateway.ts";
import {
	forwardedMeta,
	forwardedRound,
	promptArgumentsJsonSchema,
	stringArguments,
	PROJECTED_NAME_REGEX,
	type McpProjectionDrop,
} from "./shared.ts";

export interface McpConnectionProjectionOptions {
	/** Upstream tool names to project. Absent = every tool. */
	readonly tools?: readonly string[];
	/** Upstream prompt names to project. Absent = every prompt. */
	readonly prompts?: readonly string[];
	/** Upstream resource URIs to project. Absent = every resource. */
	readonly resources?: readonly string[];
	/** Upstream template URI templates to project. Absent = every template. */
	readonly resourceTemplates?: readonly string[];
	/** Optional name prefix (`prefix.name`) for projected tools and prompts. */
	readonly prefix?: string;
	/** Separator between prefix and name. Default: `"."`. */
	readonly separator?: string;
	/** Observability seam for upstream items skipped as unprojectable. */
	readonly onDropped?: (drop: McpProjectionDrop) => void;
}

/**
 * A capability provider projecting a managed connection's CURRENT catalog into the definition it
 * is attached to. Every projected handler is fenced on the catalog snapshot it was resolved from
 * (`expectedGeneration` + `expectedCatalogFingerprint`): a reconnect or refresh between listing
 * and call surfaces as an `InvalidParams` protocol error, never a call against the wrong
 * upstream. An offline or undiscovered connection contributes nothing. Downstream `authInfo` is
 * never forwarded upstream; the connection carries its own credentials.
 */
export function connectionProvider<Id extends string>(
	manager: McpConnectionManager<Id>,
	connectionId: Id,
	options: McpConnectionProjectionOptions = {},
): McpCapabilityProvider {
	if (typeof manager?.state !== "function") {
		throw new TypeError("connectionProvider requires a connection manager.");
	}
	const separator = options.separator ?? ".";
	const projectedName = (name: string) =>
		options.prefix === undefined ? name : `${options.prefix}${separator}${name}`;
	const allow = (list: readonly string[] | undefined, value: string) =>
		list === undefined || list.includes(value);
	const drop = (
		kind: McpProjectionDrop["kind"],
		source: string,
		reason: McpProjectionDrop["reason"],
	) => {
		try {
			options.onDropped?.(Object.freeze({ kind, source, reason }));
		} catch {
			// Observability only.
		}
	};

	return (_context: McpRequestContext) => {
		const snapshot = manager.state(connectionId);
		const catalog = snapshot.catalog;
		if (catalog === undefined) return [];
		const control: McpConnectionOperationControl = {
			expectedGeneration: catalog.generation,
			expectedCatalogFingerprint: catalog.fingerprint,
		};
		const capabilities: AnyMcpCapabilityDefinition[] = [];

		for (const tool of catalog.tools.items) {
			if (!allow(options.tools, tool.name)) continue;
			const name = projectedName(tool.name);
			if (!PROJECTED_NAME_REGEX.test(name)) {
				drop("tool", tool.name, "invalid-name");
				continue;
			}
			const metadata = {
				...(tool.description === undefined ? {} : { description: tool.description }),
				...(tool.title === undefined ? {} : { title: tool.title }),
				...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
				...(tool.icons === undefined ? {} : { icons: tool.icons }),
				...(tool._meta === undefined ? {} : { _meta: tool._meta }),
			};
			const inputSchema = fromJsonSchema<Record<string, unknown>>(
				tool.inputSchema as JsonSchemaType,
			);
			const forward = (args: Record<string, unknown>, ctx: ServerContext) => {
				const report = progress(ctx);
				return manager
					.callTool(
						connectionId,
						tool.name,
						args,
						{
							allowInputRequired: true,
							signal: ctx.mcpReq.signal,
							onprogress: (value) => {
								void report(value.progress, value.total, value.message).catch(() => undefined);
							},
							...forwardedRound(ctx),
						},
						control,
					)
					.catch(gatewayProtocolError);
			};
			if (tool.outputSchema === undefined) {
				capabilities.push(defineTool(name, { ...metadata, inputSchema }, forward));
			} else {
				const outputSchema = fromJsonSchema<Record<string, unknown>>(
					tool.outputSchema as JsonSchemaType,
				);
				capabilities.push(
					defineTool(
						name,
						{ ...metadata, inputSchema, outputSchema },
						(args, ctx) => forward(args, ctx) as Promise<McpToolResult<typeof outputSchema>>,
					),
				);
			}
		}

		for (const prompt of catalog.prompts.items) {
			if (!allow(options.prompts, prompt.name)) continue;
			const name = projectedName(prompt.name);
			if (!PROJECTED_NAME_REGEX.test(name)) {
				drop("prompt", prompt.name, "invalid-name");
				continue;
			}
			const metadata = {
				...(prompt.description === undefined ? {} : { description: prompt.description }),
				...(prompt.title === undefined ? {} : { title: prompt.title }),
				...(prompt.icons === undefined ? {} : { icons: prompt.icons }),
				...(prompt._meta === undefined ? {} : { _meta: prompt._meta }),
			};
			const forward = (values: Record<string, string> | undefined, ctx: ServerContext) =>
				manager
					.getPrompt(
						connectionId,
						prompt.name,
						values,
						{ signal: ctx.mcpReq.signal, ...forwardedMeta(ctx) },
						control,
					)
					.catch(gatewayProtocolError);
			const args = prompt.arguments ?? [];
			capabilities.push(
				args.length === 0
					? definePrompt(name, metadata, (ctx) => forward(undefined, ctx))
					: definePrompt(
							name,
							{
								...metadata,
								argsSchema: fromJsonSchema<Record<string, string>>(
									promptArgumentsJsonSchema(args) as JsonSchemaType,
								),
							},
							(values, ctx) => forward(stringArguments(values), ctx),
						),
			);
		}

		for (const resource of catalog.resources.items) {
			if (!allow(options.resources, resource.uri)) continue;
			capabilities.push(
				defineResource(
					projectedName(resource.name),
					resource.uri,
					{
						...(resource.description === undefined ? {} : { description: resource.description }),
						...(resource.title === undefined ? {} : { title: resource.title }),
						...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
						...(resource.annotations === undefined ? {} : { annotations: resource.annotations }),
						...(resource.icons === undefined ? {} : { icons: resource.icons }),
						...(resource._meta === undefined ? {} : { _meta: resource._meta }),
						...(resource.size === undefined ? {} : { size: resource.size }),
					},
					(uri, ctx) =>
						manager
							.readResource(
								connectionId,
								uri.href,
								{ signal: ctx.mcpReq.signal, ...forwardedMeta(ctx) },
								control,
							)
							.catch(gatewayProtocolError),
				),
			);
		}

		for (const template of catalog.resourceTemplates.items) {
			if (!allow(options.resourceTemplates, template.uriTemplate)) continue;
			try {
				capabilities.push(
					defineResourceTemplate(
						projectedName(template.name),
						template.uriTemplate,
						{
							...(template.description === undefined ? {} : { description: template.description }),
							...(template.title === undefined ? {} : { title: template.title }),
							...(template.mimeType === undefined ? {} : { mimeType: template.mimeType }),
							...(template.annotations === undefined ? {} : { annotations: template.annotations }),
							...(template.icons === undefined ? {} : { icons: template.icons }),
							...(template._meta === undefined ? {} : { _meta: template._meta }),
						},
						(uri, _variables, ctx) =>
							manager
								.readResource(
									connectionId,
									uri.href,
									{ signal: ctx.mcpReq.signal, ...forwardedMeta(ctx) },
									control,
								)
								.catch(gatewayProtocolError),
					),
				);
			} catch {
				drop("resource-template", template.uriTemplate, "invalid-template");
			}
		}

		return capabilities;
	};
}
