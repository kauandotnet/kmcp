import {
	isInputRequiredResult,
	ResourceTemplate,
	type CompleteResourceTemplateCallback,
	type ListResourcesCallback,
	type ReadResourceCallback,
	type ReadResourceResult,
	type ReadResourceTemplateCallback,
} from "@modelcontextprotocol/server";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import { assertNonEmpty } from "../internal/value.ts";
import {
	defineResource,
	defineResourceTemplate,
	type AnyMcpResourceDefinition,
	type AnyMcpResourceTemplateDefinition,
	type McpResourceOptions,
	type McpResourceTemplateOptions,
} from "./capability.ts";
import { mapCapabilities, type McpDefinitionTransform } from "./transform.ts";

export interface McpUriNamespaceOptions {
	/**
	 * URI schemes eligible for rewriting. Deliberately no default: rewriting an arbitrary URI can
	 * corrupt its meaning (an `https://` authority is not a path segment). A resource whose scheme
	 * is not listed throws `INVALID_DEFINITION`.
	 */
	readonly schemes: readonly string[];
}

const HIERARCHICAL_URI = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/;

/**
 * Namespaces resource and template URIs by prefixing the FIRST PATH SEGMENT
 * (`scheme://authority/ns/rest`) — never the scheme or authority. Only opt-in `schemes` are
 * rewritten; opaque forms (`scheme:body`) are refused. Derived handlers map the public URI back to
 * the original before delegating and re-project `contents[].uri` on the way out, so reads stay
 * consistent with listings.
 */
export function namespaceUris(
	namespace: string,
	options: McpUriNamespaceOptions,
): McpDefinitionTransform {
	assertNonEmpty(namespace, "URI namespace");
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(namespace)) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`URI namespace '${namespace}' must be alphanumeric (plus '_'/'-').`,
		);
	}
	const schemes = new Set((options?.schemes ?? []).map((scheme) => scheme.toLowerCase()));
	if (schemes.size === 0) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			"namespaceUris requires an explicit, non-empty scheme allowlist.",
		);
	}
	return mapCapabilities({
		resource: (definition) => namespaceResource(definition, namespace, schemes),
		resourceTemplate: (definition) => namespaceTemplate(definition, namespace, schemes),
	});
}

function rewriteUri(uri: string, namespace: string, schemes: ReadonlySet<string>): string {
	const match = HIERARCHICAL_URI.exec(uri);
	if (match === null) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`Cannot namespace opaque or relative URI '${uri}': only 'scheme://…' forms are rewritable.`,
		);
	}
	const [, scheme, authority, path = ""] = match;
	if (!schemes.has((scheme as string).toLowerCase())) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`URI scheme '${scheme}' is not in the namespaceUris allowlist.`,
		);
	}
	return `${scheme}://${authority}/${namespace}${path}`;
}

function unwriteUri(publicUri: string, namespace: string): string {
	const match = HIERARCHICAL_URI.exec(publicUri);
	if (match === null) return publicUri;
	const [, scheme, authority, path = ""] = match;
	const marker = `/${namespace}`;
	if (path === marker) return `${scheme}://${authority}`;
	if (path.startsWith(`${marker}/`)) {
		return `${scheme}://${authority}${path.slice(marker.length)}`;
	}
	return publicUri;
}

function reprojectContents(
	result: ReadResourceResult,
	namespace: string,
	schemes: ReadonlySet<string>,
): ReadResourceResult {
	return {
		...result,
		contents: result.contents.map((content) => {
			const match = HIERARCHICAL_URI.exec(content.uri);
			if (match === null || !schemes.has((match[1] as string).toLowerCase())) return content;
			return { ...content, uri: rewriteUri(content.uri, namespace, schemes) };
		}),
	};
}

function namespaceResource(
	definition: AnyMcpResourceDefinition,
	namespace: string,
	schemes: ReadonlySet<string>,
): AnyMcpResourceDefinition {
	const publicUri = rewriteUri(definition.uri, namespace, schemes);
	const handler = definition.handler as ReadResourceCallback;
	return defineResource(
		definition.name,
		publicUri,
		definition.options as McpResourceOptions,
		async (uri, ctx) => {
			const result = await handler(new URL(unwriteUri(uri.href, namespace)), ctx);
			if (isInputRequiredResult(result)) return result;
			return reprojectContents(result, namespace, schemes);
		},
	);
}

function namespaceTemplate(
	definition: AnyMcpResourceTemplateDefinition,
	namespace: string,
	schemes: ReadonlySet<string>,
): AnyMcpResourceTemplateDefinition {
	const template = definition.template;
	const publicTemplate = rewriteUri(template.uriTemplate.toString(), namespace, schemes);
	const options = definition.options as McpResourceTemplateOptions;
	const list = template.listCallback;
	const wrappedList: ListResourcesCallback | undefined =
		list === undefined
			? undefined
			: async (ctx) => {
					const result = await list(ctx);
					return {
						...result,
						resources: result.resources.map((resource) => ({
							...resource,
							uri: rewriteUri(resource.uri, namespace, schemes),
						})),
					};
				};
	const complete: Record<string, CompleteResourceTemplateCallback> = {};
	for (const variable of template.uriTemplate.variableNames) {
		const completer = template.completeCallback(variable);
		if (completer !== undefined) complete[variable] = completer;
	}
	const rebuilt = new ResourceTemplate(publicTemplate, {
		list: wrappedList,
		...(Object.keys(complete).length === 0 ? {} : { complete }),
	});
	const handler = definition.handler as ReadResourceTemplateCallback;
	return defineResourceTemplate(definition.name, rebuilt, options, async (uri, variables, ctx) => {
		const result = await handler(new URL(unwriteUri(uri.href, namespace)), variables, ctx);
		if (isInputRequiredResult(result)) return result;
		return reprojectContents(result, namespace, schemes);
	});
}
