import {
	type CallToolResult,
	type CacheHint,
	type Icon,
	type InputRequiredResult,
	McpServer,
	type PromptCallback,
	type ReadResourceCallback,
	type ReadResourceTemplateCallback,
	type RegisteredPrompt,
	type RegisteredResource,
	type RegisteredResourceTemplate,
	type RegisteredTool,
	type ResourceMetadata,
	ResourceTemplate,
	type StandardSchemaWithJSON,
	type ToolAnnotations,
	type ToolCallback,
} from "@modelcontextprotocol/server";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import {
	assertNonEmpty,
	immutableProtocolClone,
	type MaybePromise,
	type McpDeepReadonly,
} from "../internal/value.ts";

export type { McpDeepReadonly } from "../internal/value.ts";

export type McpCapabilityKind = "prompt" | "resource" | "resource-template" | "tool";

export type McpRegistrationHandle =
	RegisteredPrompt | RegisteredResource | RegisteredResourceTemplate | RegisteredTool;

const capabilityConstructionToken: unique symbol = Symbol("McpCapabilityDefinition");

export abstract class McpCapabilityDefinition<
	const Kind extends McpCapabilityKind,
	const Name extends string,
> {
	declare private readonly capabilityDefinitionBrand: void;

	readonly kind: Kind;
	readonly name: Name;

	protected constructor(kind: Kind, name: Name, token: typeof capabilityConstructionToken) {
		if (token !== capabilityConstructionToken) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				"MCP capability definitions must be created by kmcp.",
			);
		}
		assertNonEmpty(name, `${kind} name`);
		this.kind = kind;
		this.name = name;
	}

	abstract install(server: McpServer): McpRegistrationHandle;
}

interface McpToolMetadataOptions {
	readonly title?: string;
	readonly description?: string;
	readonly annotations?: McpDeepReadonly<ToolAnnotations>;
	readonly icons?: readonly McpDeepReadonly<Icon>[];
	readonly _meta?: McpDeepReadonly<Readonly<Record<string, unknown>>>;
}

type SchemaSlot<
	Key extends "argsSchema" | "inputSchema" | "outputSchema",
	Schema extends StandardSchemaWithJSON | undefined,
> = [Schema] extends [never]
	? never
	: [Schema] extends [undefined]
		? { readonly [Property in Key]?: never }
		: [Schema] extends [StandardSchemaWithJSON]
			? { readonly [Property in Key]: Schema }
			: never;

export type McpToolOptions<
	Input extends StandardSchemaWithJSON | undefined = undefined,
	Output extends StandardSchemaWithJSON | undefined = undefined,
> = McpToolMetadataOptions & SchemaSlot<"inputSchema", Input> & SchemaSlot<"outputSchema", Output>;

type McpToolErrorResult = Omit<CallToolResult, "isError"> & {
	readonly isError: true;
};

export type McpToolSuccessResult<Output extends StandardSchemaWithJSON> = Omit<
	CallToolResult,
	"isError" | "structuredContent"
> & {
	readonly isError?: false;
	readonly structuredContent: StandardSchemaWithJSON.InferInput<Output>;
};

export type McpToolResult<Output extends StandardSchemaWithJSON | undefined = undefined> = [
	Output,
] extends [never]
	? never
	: [Output] extends [undefined]
		? CallToolResult | InputRequiredResult
		: [Output] extends [StandardSchemaWithJSON]
			? McpToolErrorResult | McpToolSuccessResult<Output> | InputRequiredResult
			: never;

export type McpToolHandler<
	Input extends StandardSchemaWithJSON | undefined = undefined,
	Output extends StandardSchemaWithJSON | undefined = undefined,
> = [Input] extends [never]
	? never
	: [Input] extends [undefined]
		? (context: Parameters<ToolCallback<undefined>>[0]) => MaybePromise<McpToolResult<Output>>
		: [Input] extends [StandardSchemaWithJSON]
			? (
					args: StandardSchemaWithJSON.InferOutput<Input>,
					context: Parameters<ToolCallback<StandardSchemaWithJSON>>[1],
				) => MaybePromise<McpToolResult<Output>>
			: never;

export class McpToolDefinition<
	const Name extends string,
	Input extends StandardSchemaWithJSON | undefined = undefined,
	Output extends StandardSchemaWithJSON | undefined = undefined,
> extends McpCapabilityDefinition<"tool", Name> {
	declare private readonly toolDefinitionBrand: void;

	readonly options: McpToolOptions<Input, Output>;
	readonly handler: McpToolHandler<Input, Output>;

	constructor(
		name: Name,
		options: McpToolOptions<Input, Output>,
		handler: NoInfer<McpToolHandler<Input, Output>>,
	) {
		super("tool", name, capabilityConstructionToken);
		this.options = normalizeToolOptions(options);
		this.handler = handler;
		assertHandler(handler, "tool handler");
		registerCapability(
			this,
			(server) => installTool(server, this.name, this.options, this.handler),
			canonicalToolInstall,
		);
		Object.freeze(this);
	}

	override install(server: McpServer): RegisteredTool {
		return installCanonicalCapability(this, server);
	}
}

interface McpPromptMetadataOptions {
	readonly title?: string;
	readonly description?: string;
	readonly icons?: readonly McpDeepReadonly<Icon>[];
	readonly _meta?: McpDeepReadonly<Readonly<Record<string, unknown>>>;
}

export type McpPromptOptions<Args extends StandardSchemaWithJSON | undefined = undefined> =
	McpPromptMetadataOptions & SchemaSlot<"argsSchema", Args>;

export class McpPromptDefinition<
	const Name extends string,
	Args extends StandardSchemaWithJSON | undefined = undefined,
> extends McpCapabilityDefinition<"prompt", Name> {
	declare private readonly promptDefinitionBrand: void;

	readonly options: McpPromptOptions<Args>;
	readonly handler: PromptCallback<Args>;

	constructor(name: Name, options: McpPromptOptions<Args>, handler: NoInfer<PromptCallback<Args>>) {
		super("prompt", name, capabilityConstructionToken);
		this.options = normalizePromptOptions(options);
		this.handler = handler;
		assertHandler(handler, "prompt handler");
		registerCapability(
			this,
			(server) => installPrompt(server, this.name, this.options, this.handler),
			canonicalPromptInstall,
		);
		Object.freeze(this);
	}

	override install(server: McpServer): RegisteredPrompt {
		return installCanonicalCapability(this, server);
	}
}

export interface McpResourceOptions {
	readonly title?: string;
	readonly description?: string;
	readonly mimeType?: string;
	readonly icons?: readonly McpDeepReadonly<Icon>[];
	readonly _meta?: McpDeepReadonly<Readonly<Record<string, unknown>>>;
	readonly cacheHint?: McpDeepReadonly<CacheHint>;
}

export class McpResourceDefinition<
	const Name extends string,
	const Uri extends string,
> extends McpCapabilityDefinition<"resource", Name> {
	declare private readonly resourceDefinitionBrand: void;

	readonly uri: Uri;
	readonly options: McpResourceOptions;
	readonly handler: ReadResourceCallback;

	constructor(name: Name, uri: Uri, options: McpResourceOptions, handler: ReadResourceCallback) {
		super("resource", name, capabilityConstructionToken);
		assertNonEmpty(uri, "resource URI");
		this.uri = uri;
		this.options = normalizeResourceOptions(options);
		this.handler = handler;
		assertHandler(handler, "resource handler");
		registerCapability(
			this,
			(server) =>
				server.registerResource(this.name, this.uri, resourceConfig(this.options), this.handler),
			canonicalResourceInstall,
		);
		Object.freeze(this);
	}

	override install(server: McpServer): RegisteredResource {
		return installCanonicalCapability(this, server);
	}
}

export class McpResourceTemplateDefinition<
	const Name extends string,
> extends McpCapabilityDefinition<"resource-template", Name> {
	declare private readonly resourceTemplateDefinitionBrand: void;

	readonly template: ResourceTemplate;
	readonly options: McpResourceOptions;
	readonly handler: ReadResourceTemplateCallback;

	constructor(
		name: Name,
		template: ResourceTemplate,
		options: McpResourceOptions,
		handler: ReadResourceTemplateCallback,
	) {
		super("resource-template", name, capabilityConstructionToken);
		this.template = template;
		this.options = normalizeResourceOptions(options);
		this.handler = handler;
		assertHandler(handler, "resource-template handler");
		registerCapability(
			this,
			(server) =>
				server.registerResource(
					this.name,
					this.template,
					resourceConfig(this.options),
					this.handler,
				),
			canonicalResourceTemplateInstall,
		);
		Object.freeze(this);
	}

	override install(server: McpServer): RegisteredResourceTemplate {
		return installCanonicalCapability(this, server);
	}
}

export interface AnyMcpToolDefinition extends McpCapabilityDefinition<"tool", string> {
	readonly options: unknown;
	readonly handler: unknown;
}

export interface AnyMcpPromptDefinition extends McpCapabilityDefinition<"prompt", string> {
	readonly options: unknown;
	readonly handler: unknown;
}

export interface AnyMcpResourceDefinition extends McpCapabilityDefinition<"resource", string> {
	readonly uri: string;
	readonly options: McpResourceOptions;
	readonly handler: unknown;
}

export interface AnyMcpResourceTemplateDefinition extends McpCapabilityDefinition<
	"resource-template",
	string
> {
	readonly template: ResourceTemplate;
	readonly options: McpResourceOptions;
	readonly handler: unknown;
}

export type AnyMcpCapabilityDefinition =
	| AnyMcpToolDefinition
	| AnyMcpPromptDefinition
	| AnyMcpResourceDefinition
	| AnyMcpResourceTemplateDefinition;

export type McpCapabilityKey<Capability extends AnyMcpCapabilityDefinition> =
	`${Capability["kind"]}:${Capability["name"]}`;

export function defineTool<
	const Name extends string,
	const Input extends StandardSchemaWithJSON | undefined = undefined,
	const Output extends StandardSchemaWithJSON | undefined = undefined,
>(
	name: Name,
	options: McpToolOptions<Input, Output>,
	handler: NoInfer<McpToolHandler<Input, Output>>,
): McpToolDefinition<Name, Input, Output> {
	return new McpToolDefinition(name, options, handler);
}

export function definePrompt<
	const Name extends string,
	const Args extends StandardSchemaWithJSON | undefined = undefined,
>(
	name: Name,
	options: McpPromptOptions<Args>,
	handler: NoInfer<PromptCallback<Args>>,
): McpPromptDefinition<Name, Args> {
	return new McpPromptDefinition(name, options, handler);
}

export function defineResource<const Name extends string, const Uri extends string>(
	name: Name,
	uri: Uri,
	options: McpResourceOptions,
	handler: ReadResourceCallback,
): McpResourceDefinition<Name, Uri> {
	return new McpResourceDefinition(name, uri, options, handler);
}

export function defineResourceTemplate<const Name extends string>(
	name: Name,
	template: ResourceTemplate,
	options: McpResourceOptions,
	handler: ReadResourceTemplateCallback,
): McpResourceTemplateDefinition<Name> {
	return new McpResourceTemplateDefinition(name, template, options, handler);
}

interface CapabilityState {
	readonly install: (server: McpServer) => McpRegistrationHandle;
	readonly publicInstall: McpCapabilityDefinition<McpCapabilityKind, string>["install"];
}

const capabilityStates = new WeakMap<object, CapabilityState>();
const canonicalToolInstall = McpToolDefinition.prototype.install;
const canonicalPromptInstall = McpPromptDefinition.prototype.install;
const canonicalResourceInstall = McpResourceDefinition.prototype.install;
const canonicalResourceTemplateInstall = McpResourceTemplateDefinition.prototype.install;

export function assertCanonicalCapability(
	definition: AnyMcpCapabilityDefinition,
): asserts definition is AnyMcpCapabilityDefinition {
	const state = capabilityStates.get(definition);
	if (state === undefined || definition.install !== state.publicInstall) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			"MCP capabilities must be unmodified canonical definitions created by kmcp.",
		);
	}
}

export function installCanonicalCapability(
	definition: AnyMcpToolDefinition,
	server: McpServer,
): RegisteredTool;
export function installCanonicalCapability(
	definition: AnyMcpPromptDefinition,
	server: McpServer,
): RegisteredPrompt;
export function installCanonicalCapability(
	definition: AnyMcpResourceDefinition,
	server: McpServer,
): RegisteredResource;
export function installCanonicalCapability(
	definition: AnyMcpResourceTemplateDefinition,
	server: McpServer,
): RegisteredResourceTemplate;
export function installCanonicalCapability(
	definition: AnyMcpCapabilityDefinition,
	server: McpServer,
): McpRegistrationHandle;
export function installCanonicalCapability(
	definition: AnyMcpCapabilityDefinition,
	server: McpServer,
): McpRegistrationHandle {
	assertCanonicalCapability(definition);
	const state = capabilityStates.get(definition);
	if (state === undefined) throw new TypeError("Unreachable canonical capability state.");
	return state.install(server);
}

function registerCapability(
	definition: object,
	install: (server: McpServer) => McpRegistrationHandle,
	publicInstall: McpCapabilityDefinition<McpCapabilityKind, string>["install"],
): void {
	capabilityStates.set(definition, Object.freeze({ install, publicInstall }));
}

function installTool<
	Input extends StandardSchemaWithJSON | undefined,
	Output extends StandardSchemaWithJSON | undefined,
>(
	server: McpServer,
	name: string,
	options: McpToolOptions<Input, Output>,
	handler: McpToolHandler<Input, Output>,
): RegisteredTool {
	const config = toolConfig(options);
	if (options.inputSchema === undefined) {
		return server.registerTool<StandardSchemaWithJSON, undefined>(
			name,
			config,
			handler as ToolCallback<undefined>,
		);
	}
	return server.registerTool<StandardSchemaWithJSON, StandardSchemaWithJSON>(
		name,
		{ ...config, inputSchema: options.inputSchema },
		handler as ToolCallback<StandardSchemaWithJSON>,
	);
}

function installPrompt<Args extends StandardSchemaWithJSON | undefined>(
	server: McpServer,
	name: string,
	options: McpPromptOptions<Args>,
	handler: PromptCallback<Args>,
): RegisteredPrompt {
	const config = promptConfig(options);
	if (options.argsSchema === undefined) {
		const registerPrompt = server.registerPrompt.bind(server) as unknown as (
			name: string,
			options: ReturnType<typeof promptConfig>,
			handler: PromptCallback<undefined>,
		) => RegisteredPrompt;
		return registerPrompt(name, config, handler as PromptCallback<undefined>);
	}
	return server.registerPrompt<StandardSchemaWithJSON>(
		name,
		{ ...config, argsSchema: options.argsSchema },
		handler as PromptCallback<StandardSchemaWithJSON>,
	);
}

function normalizeToolOptions<
	Input extends StandardSchemaWithJSON | undefined,
	Output extends StandardSchemaWithJSON | undefined,
>(options: McpToolOptions<Input, Output>): McpToolOptions<Input, Output> {
	return Object.freeze({
		...(options.title === undefined ? {} : { title: options.title }),
		...(options.description === undefined ? {} : { description: options.description }),
		...(options.inputSchema === undefined ? {} : { inputSchema: options.inputSchema }),
		...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
		...(options.annotations === undefined
			? {}
			: { annotations: immutableProtocolClone(options.annotations, "tool annotations") }),
		...(options.icons === undefined
			? {}
			: { icons: immutableProtocolClone(options.icons, "tool icons") }),
		...(options._meta === undefined
			? {}
			: { _meta: immutableProtocolClone(options._meta, "tool _meta") }),
	}) as McpToolOptions<Input, Output>;
}

function normalizePromptOptions<Args extends StandardSchemaWithJSON | undefined>(
	options: McpPromptOptions<Args>,
): McpPromptOptions<Args> {
	return Object.freeze({
		...(options.title === undefined ? {} : { title: options.title }),
		...(options.description === undefined ? {} : { description: options.description }),
		...(options.argsSchema === undefined ? {} : { argsSchema: options.argsSchema }),
		...(options.icons === undefined
			? {}
			: { icons: immutableProtocolClone(options.icons, "prompt icons") }),
		...(options._meta === undefined
			? {}
			: { _meta: immutableProtocolClone(options._meta, "prompt _meta") }),
	}) as McpPromptOptions<Args>;
}

function normalizeResourceOptions(options: McpResourceOptions): McpResourceOptions {
	return Object.freeze({
		...(options.title === undefined ? {} : { title: options.title }),
		...(options.description === undefined ? {} : { description: options.description }),
		...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
		...(options.icons === undefined
			? {}
			: { icons: immutableProtocolClone(options.icons, "resource icons") }),
		...(options._meta === undefined
			? {}
			: { _meta: immutableProtocolClone(options._meta, "resource _meta") }),
		...(options.cacheHint === undefined
			? {}
			: { cacheHint: immutableProtocolClone(options.cacheHint, "resource cacheHint") }),
	});
}

function assertHandler(value: unknown, label: string): asserts value is CallableFunction {
	if (typeof value !== "function") throw new TypeError(`${label} must be a function.`);
}

function toolConfig(
	options: McpToolMetadataOptions & { readonly outputSchema?: StandardSchemaWithJSON },
) {
	return {
		...(options.title === undefined ? {} : { title: options.title }),
		...(options.description === undefined ? {} : { description: options.description }),
		...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
		...(options.annotations === undefined
			? {}
			: { annotations: mutableProtocolClone<ToolAnnotations>(options.annotations) }),
		...(options.icons === undefined
			? {}
			: { icons: options.icons.map((icon) => mutableProtocolClone<Icon>(icon)) }),
		...(options._meta === undefined
			? {}
			: { _meta: mutableProtocolClone<Record<string, unknown>>(options._meta) }),
	};
}

function promptConfig(options: McpPromptMetadataOptions) {
	return {
		...(options.title === undefined ? {} : { title: options.title }),
		...(options.description === undefined ? {} : { description: options.description }),
		...(options.icons === undefined
			? {}
			: { icons: options.icons.map((icon) => mutableProtocolClone<Icon>(icon)) }),
		...(options._meta === undefined
			? {}
			: { _meta: mutableProtocolClone<Record<string, unknown>>(options._meta) }),
	};
}

function resourceConfig(options: McpResourceOptions): ResourceMetadata & { cacheHint?: CacheHint } {
	return {
		...(options.title === undefined ? {} : { title: options.title }),
		...(options.description === undefined ? {} : { description: options.description }),
		...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
		...(options.icons === undefined
			? {}
			: { icons: options.icons.map((icon) => mutableProtocolClone<Icon>(icon)) }),
		...(options._meta === undefined
			? {}
			: { _meta: mutableProtocolClone<Record<string, unknown>>(options._meta) }),
		...(options.cacheHint === undefined
			? {}
			: { cacheHint: mutableProtocolClone<CacheHint>(options.cacheHint) }),
	};
}

function mutableProtocolClone<Value>(value: McpDeepReadonly<Value>): Value {
	return structuredClone(value) as Value;
}
