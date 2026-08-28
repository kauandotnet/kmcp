import {
	type GetPromptResult,
	type Implementation,
	type InputRequiredResult,
	type PromptCallback,
	type ReadResourceCallback,
	type ReadResourceResult,
	type ReadResourceTemplateCallback,
	ResourceTemplate,
	type ServerContext,
	type StandardSchemaWithJSON,
	type Variables,
} from "@modelcontextprotocol/server";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import { immutableProtocolClone, type MaybePromise } from "../internal/value.ts";
import {
	McpPromptDefinition,
	type McpPromptOptions,
	McpResourceDefinition,
	type McpResourceOptions,
	McpResourceTemplateDefinition,
	type McpResourceTemplateOptions,
	McpToolDefinition,
	type McpToolHandler,
	type McpToolResult,
	type McpToolOptions,
	type AnyMcpCapabilityDefinition,
} from "./capability.ts";
import { McpServerDefinition, type McpServerDefinitionOptions } from "./server-definition.ts";

type PromptResult = MaybePromise<GetPromptResult | InputRequiredResult>;
type ResourceResult = MaybePromise<ReadResourceResult | InputRequiredResult>;

type ToolMethod<
	This,
	Input extends StandardSchemaWithJSON | undefined,
	Output extends StandardSchemaWithJSON | undefined,
> = [Input] extends [never]
	? never
	: [Input] extends [StandardSchemaWithJSON]
		? (
				this: This,
				args: StandardSchemaWithJSON.InferOutput<Input>,
				context: ServerContext,
			) => MaybePromise<McpToolResult<Output>>
		: [Input] extends [undefined]
			? (this: This, context: ServerContext) => MaybePromise<McpToolResult<Output>>
			: never;

type PromptMethod<This, Args extends StandardSchemaWithJSON | undefined> = [Args] extends [never]
	? never
	: [Args] extends [StandardSchemaWithJSON]
		? (
				this: This,
				args: StandardSchemaWithJSON.InferOutput<Args>,
				context: ServerContext,
			) => PromptResult
		: [Args] extends [undefined]
			? (this: This, context: ServerContext) => PromptResult
			: never;

export interface McpServerAppOptions extends McpServerDefinitionOptions {
	readonly serverInfo: Implementation;
}

type CapabilityRecipe = (instance: object) => AnyMcpCapabilityDefinition;

const recipes = new WeakMap<object, readonly CapabilityRecipe[]>();
const materialized = new WeakMap<object, readonly AnyMcpCapabilityDefinition[]>();
const serverOptions = new WeakMap<Function, McpServerAppOptions>();

export function McpTool<
	const Name extends string,
	const Input extends StandardSchemaWithJSON | undefined = undefined,
	const Output extends StandardSchemaWithJSON | undefined = undefined,
>(options: McpToolOptions<Input, Output> & { readonly name: Name }) {
	return function <This extends object>(
		_value: ToolMethod<This, Input, Output>,
		context: ClassMethodDecoratorContext<This, ToolMethod<This, Input, Output>>,
	): void {
		assertPublicMethod(context, "McpTool");
		const access = context.access;
		context.addInitializer(function (this: This): void {
			appendRecipe(this, (instance) => {
				const method = access.get(instance as This) as unknown as (
					this: This,
					...args: never[]
				) => unknown;
				const bound = method.bind(instance as This) as unknown as McpToolHandler<Input, Output>;
				return new McpToolDefinition(options.name, options, bound);
			});
		});
	};
}

export function McpPrompt<
	const Name extends string,
	const Args extends StandardSchemaWithJSON | undefined = undefined,
>(options: McpPromptOptions<Args> & { readonly name: Name }) {
	return function <This extends object>(
		_value: PromptMethod<This, Args>,
		context: ClassMethodDecoratorContext<This, PromptMethod<This, Args>>,
	): void {
		assertPublicMethod(context, "McpPrompt");
		const access = context.access;
		context.addInitializer(function (this: This): void {
			appendRecipe(this, (instance) => {
				const method = access.get(instance as This) as unknown as (
					this: This,
					...args: never[]
				) => unknown;
				const bound = method.bind(instance as This) as unknown as PromptCallback<Args>;
				return new McpPromptDefinition(options.name, options, bound);
			});
		});
	};
}

export function McpResource<const Name extends string, const Uri extends string>(
	options: McpResourceOptions & { readonly name: Name; readonly uri: Uri },
) {
	return function <This extends object>(
		_value: (this: This, uri: URL, context: ServerContext) => ResourceResult,
		context: ClassMethodDecoratorContext<
			This,
			(this: This, uri: URL, context: ServerContext) => ResourceResult
		>,
	): void {
		assertPublicMethod(context, "McpResource");
		const access = context.access;
		context.addInitializer(function (this: This): void {
			appendRecipe(this, (instance) => {
				const bound = access.get(instance as This).bind(instance as This) as ReadResourceCallback;
				return new McpResourceDefinition(options.name, options.uri, options, bound);
			});
		});
	};
}

export function McpResourceTemplate<const Name extends string>(
	options: McpResourceTemplateOptions & {
		readonly name: Name;
		readonly template: ResourceTemplate | string;
	},
) {
	return function <This extends object>(
		_value: (this: This, uri: URL, variables: Variables, context: ServerContext) => ResourceResult,
		context: ClassMethodDecoratorContext<
			This,
			(this: This, uri: URL, variables: Variables, context: ServerContext) => ResourceResult
		>,
	): void {
		assertPublicMethod(context, "McpResourceTemplate");
		const access = context.access;
		context.addInitializer(function (this: This): void {
			appendRecipe(this, (instance) => {
				const bound = access
					.get(instance as This)
					.bind(instance as This) as ReadResourceTemplateCallback;
				return new McpResourceTemplateDefinition(options.name, options.template, options, bound);
			});
		});
	};
}

export function McpServerApp(options: McpServerAppOptions) {
	const normalized = Object.freeze({
		...options,
		serverInfo: immutableProtocolClone(options.serverInfo, "server info"),
		...(options.capabilities === undefined
			? {}
			: { capabilities: Object.freeze([...options.capabilities]) }),
	});
	return function <Class extends abstract new (...args: never[]) => object>(
		_value: Class,
		context: ClassDecoratorContext<Class>,
	): void {
		context.addInitializer(function (this: Function): void {
			serverOptions.set(this, normalized);
		});
	};
}

export function capabilitiesOf(instance: object): readonly AnyMcpCapabilityDefinition[] {
	const cached = materialized.get(instance);
	if (cached !== undefined) return cached;
	const capabilities = Object.freeze(
		(recipes.get(instance) ?? []).map((recipe) => recipe(instance)),
	);
	materialized.set(instance, capabilities);
	return capabilities;
}

export function serverFrom(instance: object): McpServerDefinition {
	const options = decoratedServerOptions(instance);
	if (options === undefined) throw missingDecoratorMetadata();
	const { serverInfo, capabilities = [], ...definitionOptions } = options;
	return new McpServerDefinition(serverInfo, {
		...definitionOptions,
		capabilities: [...capabilities, ...capabilitiesOf(instance)],
	});
}

/** Walks the prototype chain so subclasses of a decorated app class inherit its server options. */
function decoratedServerOptions(instance: object): McpServerAppOptions | undefined {
	let constructor: unknown = Object.getPrototypeOf(instance)?.constructor;
	while (typeof constructor === "function") {
		const options = serverOptions.get(constructor);
		if (options !== undefined) return options;
		constructor = Object.getPrototypeOf(constructor);
	}
	return undefined;
}

function appendRecipe(instance: object, recipe: CapabilityRecipe): void {
	recipes.set(instance, Object.freeze([...(recipes.get(instance) ?? []), recipe]));
	materialized.delete(instance);
}

function assertPublicMethod(
	context: { readonly private: boolean; readonly static: boolean },
	decorator: string,
): void {
	if (context.private || context.static) {
		throw new TypeError(`${decorator} can decorate only public instance methods.`);
	}
}

function missingDecoratorMetadata(): KmcpError {
	return new KmcpError(
		KMCP_ERROR_CODES.DECORATOR_METADATA_MISSING,
		"The instance's class is not decorated with @McpServerApp.",
	);
}
