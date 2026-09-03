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
import { gatewayProtocolError } from "../gateway/gateway.ts";
import type { McpHubManager } from "../hub/hub.ts";
import {
	forwardedMeta,
	forwardedRound,
	promptArgumentsJsonSchema,
	stringArguments,
	PROJECTED_NAME_REGEX,
	type McpProjectionDrop,
} from "./shared.ts";

const URI_SCHEME_REGEX = /^[A-Za-z][A-Za-z0-9+.-]*$/;

export interface McpHubProjectionOptions {
	/** Hub tool routes (`namespace.name`) to project. Absent = every tool. */
	readonly tools?: readonly string[];
	/** Hub prompt routes to project. Absent = every prompt. */
	readonly prompts?: readonly string[];
	/** Hub resource routes (`namespace:uri`) to project. Absent = every resource. */
	readonly resources?: readonly string[];
	/** Hub template routes to project. Absent = every template. */
	readonly resourceTemplates?: readonly string[];
	/** Observability seam for routes skipped as unprojectable. */
	readonly onDropped?: (drop: McpProjectionDrop) => void;
}

/**
 * A capability provider projecting a hub's CURRENT catalog into the definition it is attached to,
 * using the hub's namespaced routes (`namespace.name` for tools and prompts, `namespace:uri` for
 * resources — the namespace must be a valid URI scheme or the route is dropped). Every call goes
 * through the hub's descriptor-fenced dispatch, so a stale route rejects instead of hitting the
 * wrong upstream. For projecting a WHOLE hub as a standalone downstream server prefer
 * `defineGateway`, which also reconciles pinned instances and pushes list-changed notifications.
 */
export function hubProvider<HubId extends string, ConnectionId extends string>(
	hubs: McpHubManager<HubId, ConnectionId>,
	hubId: HubId,
	options: McpHubProjectionOptions = {},
): McpCapabilityProvider {
	if (typeof hubs?.catalog !== "function") {
		throw new TypeError("hubProvider requires a hub manager.");
	}
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
		const catalog = hubs.catalog(hubId);
		const capabilities: AnyMcpCapabilityDefinition[] = [];

		for (const route of catalog.tools) {
			if (!allow(options.tools, route.route)) continue;
			if (!PROJECTED_NAME_REGEX.test(route.route)) {
				drop("tool", route.route, "invalid-name");
				continue;
			}
			const tool = route.tool;
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
				return hubs
					.callTool(hubId, route, args, {
						allowInputRequired: true,
						signal: ctx.mcpReq.signal,
						onprogress: (value) => {
							void report(value.progress, value.total, value.message).catch(() => undefined);
						},
						...forwardedRound(ctx),
					})
					.catch(gatewayProtocolError);
			};
			if (tool.outputSchema === undefined) {
				capabilities.push(defineTool(route.route, { ...metadata, inputSchema }, forward));
			} else {
				const outputSchema = fromJsonSchema<Record<string, unknown>>(
					tool.outputSchema as JsonSchemaType,
				);
				capabilities.push(
					defineTool(
						route.route,
						{ ...metadata, inputSchema, outputSchema },
						(args, ctx) => forward(args, ctx) as Promise<McpToolResult<typeof outputSchema>>,
					),
				);
			}
		}

		for (const route of catalog.prompts) {
			if (!allow(options.prompts, route.route)) continue;
			if (!PROJECTED_NAME_REGEX.test(route.route)) {
				drop("prompt", route.route, "invalid-name");
				continue;
			}
			const prompt = route.prompt;
			const metadata = {
				...(prompt.description === undefined ? {} : { description: prompt.description }),
				...(prompt.title === undefined ? {} : { title: prompt.title }),
				...(prompt.icons === undefined ? {} : { icons: prompt.icons }),
				...(prompt._meta === undefined ? {} : { _meta: prompt._meta }),
			};
			const forward = (values: Record<string, string> | undefined, ctx: ServerContext) =>
				hubs
					.getPrompt(hubId, route, values, {
						signal: ctx.mcpReq.signal,
						...forwardedMeta(ctx),
					})
					.catch(gatewayProtocolError);
			const args = prompt.arguments ?? [];
			capabilities.push(
				args.length === 0
					? definePrompt(route.route, metadata, (ctx) => forward(undefined, ctx))
					: definePrompt(
							route.route,
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

		for (const route of catalog.resources) {
			if (!allow(options.resources, route.route)) continue;
			if (!URI_SCHEME_REGEX.test(route.namespace)) {
				drop("resource", route.route, "namespace-not-uri-scheme");
				continue;
			}
			const resource = route.resource;
			const prefix = `${route.namespace}:`;
			capabilities.push(
				defineResource(
					`${route.namespace}.${resource.name}`,
					route.route,
					{
						...(resource.description === undefined ? {} : { description: resource.description }),
						...(resource.title === undefined ? {} : { title: resource.title }),
						...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
						...(resource.annotations === undefined ? {} : { annotations: resource.annotations }),
						...(resource.icons === undefined ? {} : { icons: resource.icons }),
						...(resource._meta === undefined ? {} : { _meta: resource._meta }),
						...(resource.size === undefined ? {} : { size: resource.size }),
					},
					async (_uri, ctx) =>
						prefixContents(
							await hubs
								.readResource(hubId, route, {
									signal: ctx.mcpReq.signal,
									...forwardedMeta(ctx),
								})
								.catch(gatewayProtocolError),
							prefix,
						),
				),
			);
		}

		for (const route of catalog.resourceTemplates) {
			if (!allow(options.resourceTemplates, route.route)) continue;
			if (!URI_SCHEME_REGEX.test(route.namespace)) {
				drop("resource-template", route.route, "namespace-not-uri-scheme");
				continue;
			}
			const template = route.resourceTemplate;
			const prefix = `${route.namespace}:`;
			try {
				capabilities.push(
					defineResourceTemplate(
						`${route.namespace}.${template.name}`,
						route.route,
						{
							...(template.description === undefined ? {} : { description: template.description }),
							...(template.title === undefined ? {} : { title: template.title }),
							...(template.mimeType === undefined ? {} : { mimeType: template.mimeType }),
							...(template.annotations === undefined ? {} : { annotations: template.annotations }),
							...(template.icons === undefined ? {} : { icons: template.icons }),
							...(template._meta === undefined ? {} : { _meta: template._meta }),
						},
						async (uri, _variables, ctx) => {
							const raw = uri.href;
							const sourceUri = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
							return prefixContents(
								await hubs
									.readResource(hubId, route.namespace, sourceUri, {
										signal: ctx.mcpReq.signal,
										...forwardedMeta(ctx),
									})
									.catch(gatewayProtocolError),
								prefix,
							);
						},
					),
				);
			} catch {
				drop("resource-template", route.route, "invalid-template");
			}
		}

		return capabilities;
	};
}

function prefixContents<Result extends { contents: readonly { uri: string }[] }>(
	result: Result,
	prefix: string,
): Result {
	return {
		...result,
		contents: result.contents.map((content) =>
			content.uri.startsWith(prefix) ? content : { ...content, uri: `${prefix}${content.uri}` },
		),
	};
}
