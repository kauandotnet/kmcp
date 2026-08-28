import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import { assertNonEmpty } from "../internal/value.ts";
import type {
	AnyMcpCapabilityDefinition,
	AnyMcpPromptDefinition,
	AnyMcpResourceDefinition,
	AnyMcpResourceTemplateDefinition,
	AnyMcpToolDefinition,
} from "./capability.ts";
import type { McpServerDefinition } from "./server-definition.ts";

/**
 * A pure projection from one frozen definition to another. Applied via
 * `McpServerDefinition.transform(...)` — never on the typed builder, whose compile-time duplicate
 * key guard cannot follow an arbitrary function.
 */
export type McpDefinitionTransform = (definition: McpServerDefinition) => McpServerDefinition;

export interface McpCapabilityMappers {
	readonly tool?: (definition: AnyMcpToolDefinition) => AnyMcpToolDefinition;
	readonly prompt?: (definition: AnyMcpPromptDefinition) => AnyMcpPromptDefinition;
	readonly resource?: (definition: AnyMcpResourceDefinition) => AnyMcpResourceDefinition;
	readonly resourceTemplate?: (
		definition: AnyMcpResourceTemplateDefinition,
	) => AnyMcpResourceTemplateDefinition;
}

export interface McpCapabilityPredicates {
	readonly tool?: (definition: AnyMcpToolDefinition) => boolean;
	readonly prompt?: (definition: AnyMcpPromptDefinition) => boolean;
	readonly resource?: (definition: AnyMcpResourceDefinition) => boolean;
	readonly resourceTemplate?: (definition: AnyMcpResourceTemplateDefinition) => boolean;
}

/** Rewrites capabilities per kind; kinds without a mapper pass through unchanged. */
export function mapCapabilities(mappers: McpCapabilityMappers): McpDefinitionTransform {
	return (definition) =>
		definition.withCapabilities(
			definition.capabilities.map((capability) => mapOne(capability, mappers)),
		);
}

/** Keeps only the capabilities whose predicate returns `true`; kinds without a predicate are kept. */
export function filterCapabilities(
	predicates: McpCapabilityPredicates | ((definition: AnyMcpCapabilityDefinition) => boolean),
): McpDefinitionTransform {
	return (definition) =>
		definition.withCapabilities(
			definition.capabilities.filter((capability) =>
				typeof predicates === "function" ? predicates(capability) : keepOne(capability, predicates),
			),
		);
}

export interface PrefixNamesOptions {
	/** Separator between the prefix and the original name. Default: `"."` (valid in SDK tool names, matches hub routes). */
	readonly separator?: string;
}

/**
 * Prefixes every tool, prompt, resource and template **name**. Resource URIs are never rewritten:
 * prefixing a URI scheme or authority violates RFC 3986, and routing already works by URI.
 */
export function prefixNames(
	prefix: string,
	options: PrefixNamesOptions = {},
): McpDefinitionTransform {
	assertNonEmpty(prefix, "name prefix");
	const separator = options.separator ?? ".";
	const rename = <Definition extends AnyMcpCapabilityDefinition>(definition: Definition) =>
		definition.withName(`${prefix}${separator}${definition.name}`) as Definition;
	return mapCapabilities({
		tool: rename,
		prompt: rename,
		resource: rename,
		resourceTemplate: rename,
	});
}

/**
 * A handler decorator. `handler` is the raw SDK-shaped callback of the capability
 * (`(args, ctx)`, `(ctx)`, `(uri, ctx)` or `(uri, variables, ctx)` — the `ServerContext` is always
 * the last argument). Decorators MUST pass an `InputRequiredResult` through unwrapped so the
 * outermost server applies its own multi-round-trip handling.
 */
export type McpHandlerDecorator = (
	handler: (...args: never[]) => unknown,
	capability: AnyMcpCapabilityDefinition,
) => (...args: never[]) => unknown;

/** Wraps every capability handler with `decorator`; the single interception seam kmcp offers. */
export function decorateHandlers(decorator: McpHandlerDecorator): McpDefinitionTransform {
	if (typeof decorator !== "function") throw new TypeError("decorator must be a function.");
	const decorate = <Definition extends AnyMcpCapabilityDefinition>(definition: Definition) =>
		definition.withHandler(
			decorator(definition.handler as (...args: never[]) => unknown, definition),
		) as Definition;
	return mapCapabilities({
		tool: decorate,
		prompt: decorate,
		resource: decorate,
		resourceTemplate: decorate,
	});
}

/** Composes transforms left to right. */
export function composeTransforms(
	...transforms: readonly McpDefinitionTransform[]
): McpDefinitionTransform {
	return (definition) => transforms.reduce((current, transform) => transform(current), definition);
}

function mapOne(
	capability: AnyMcpCapabilityDefinition,
	mappers: McpCapabilityMappers,
): AnyMcpCapabilityDefinition {
	switch (capability.kind) {
		case "tool":
			return checkMapped(capability, mappers.tool?.(capability));
		case "prompt":
			return checkMapped(capability, mappers.prompt?.(capability));
		case "resource":
			return checkMapped(capability, mappers.resource?.(capability));
		case "resource-template":
			return checkMapped(capability, mappers.resourceTemplate?.(capability));
	}
}

function keepOne(
	capability: AnyMcpCapabilityDefinition,
	predicates: McpCapabilityPredicates,
): boolean {
	switch (capability.kind) {
		case "tool":
			return predicates.tool?.(capability) ?? true;
		case "prompt":
			return predicates.prompt?.(capability) ?? true;
		case "resource":
			return predicates.resource?.(capability) ?? true;
		case "resource-template":
			return predicates.resourceTemplate?.(capability) ?? true;
	}
}

function checkMapped(
	original: AnyMcpCapabilityDefinition,
	mapped: AnyMcpCapabilityDefinition | undefined,
): AnyMcpCapabilityDefinition {
	if (mapped === undefined) return original;
	if (mapped.kind !== original.kind) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`A capability mapper must return the same kind (${original.kind}); got ${mapped.kind}.`,
		);
	}
	return mapped;
}
