import {
	type Annotations,
	type AuthInfo,
	type CacheHint,
	type CallToolResult,
	type CompleteResourceTemplateCallback,
	type Icon,
	type InputRequiredResult,
	type ListResourcesCallback,
	McpServer,
	type McpRequestContext,
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

/** The raw SDK-shaped callback of a capability, as seen by an install-time wrapper. */
export type McpWrappableHandler = (...args: never[]) => unknown;

/**
 * An install-time handler wrapper. Only `McpServerDefinition.instantiate` supplies one (it is how
 * the definition-level middleware chain reaches every handler with the request context); the
 * public `definition.install(server)` path never wraps, so canonicality checks are unaffected.
 */
export type McpCapabilityInstallWrap = (
	handler: McpWrappableHandler,
	definition: AnyMcpCapabilityDefinition,
) => McpWrappableHandler;

/** The outcome of a per-capability authorization check. A bare `boolean` is accepted as shorthand. */
export type McpAuthVerdict =
	| { readonly allowed: true }
	| {
			readonly allowed: false;
			readonly reason: string;
			/** The scopes still missing, when the failure is scope-shaped (drives 403 challenges). */
			readonly missingScopes?: readonly string[];
	  };

/**
 * Per-capability authorization, evaluated when a server is materialized for a request. A denied
 * capability is simply not installed, so it is absent from lists and answers "not found" — never
 * "disabled" — with zero request-time code. `anonymous` has no default: it decides what happens
 * when the request carries no `authInfo` (stdio, or an HTTP entry without an auth gate).
 */
export interface McpCapabilityAuth {
	readonly check: (
		authInfo: AuthInfo,
		context: McpRequestContext,
	) => MaybePromise<McpAuthVerdict | boolean>;
	readonly anonymous: "allow" | "deny";
}

/** A check that passes only when every listed scope is present on the token. */
export function requireScopes(...scopes: readonly string[]): McpCapabilityAuth["check"] {
	const required = Object.freeze([...scopes]);
	return (authInfo) => {
		const missing = required.filter((scope) => !authInfo.scopes.includes(scope));
		return missing.length === 0
			? { allowed: true }
			: {
					allowed: false,
					reason: `missing scope(s): ${missing.join(", ")}`,
					missingScopes: Object.freeze(missing),
				};
	};
}

interface McpCommonCapabilityOptions {
	/** Server-side labels for transforms and filters; never advertised on the wire. */
	readonly tags?: readonly string[];
	readonly auth?: McpCapabilityAuth;
}

export interface McpCapabilityMetadataPatch {
	readonly title?: string;
	readonly description?: string;
	readonly tags?: readonly string[];
}

const capabilityConstructionToken: unique symbol = Symbol("McpCapabilityDefinition");

export abstract class McpCapabilityDefinition<
	const Kind extends McpCapabilityKind,
	const Name extends string,
> {
	declare private readonly capabilityDefinitionBrand: void;

	readonly kind: Kind;
	readonly name: Name;
	readonly tags: readonly string[];
	readonly auth: McpCapabilityAuth | undefined;

	protected constructor(
		kind: Kind,
		name: Name,
		token: typeof capabilityConstructionToken,
		common: McpCommonCapabilityOptions = {},
	) {
		if (token !== capabilityConstructionToken) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				"MCP capability definitions must be created by kmcp.",
			);
		}
		assertNonEmpty(name, `${kind} name`);
		this.kind = kind;
		this.name = name;
		this.tags = Object.freeze(normalizeTags(common.tags));
		this.auth = common.auth === undefined ? undefined : normalizeAuth(common.auth);
	}

	abstract readonly handler: unknown;

	abstract install(server: McpServer): McpRegistrationHandle;

	/** A copy of this definition under another name (handlers and schemas stay live). */
	abstract withName(name: string): McpCapabilityDefinition<Kind, string>;

	/** A copy of this definition with replaced display metadata. */
	abstract withMetadata(patch: McpCapabilityMetadataPatch): McpCapabilityDefinition<Kind, Name>;

	/** A copy of this definition whose handler is replaced (used by `decorateHandlers`). */
	abstract withHandler(handler: unknown): McpCapabilityDefinition<Kind, Name>;

	/** A copy of this definition with its authorization replaced (used by `restrictTag`). */
	abstract withAuth(auth: McpCapabilityAuth): McpCapabilityDefinition<Kind, Name>;
}

interface McpToolMetadataOptions extends McpCommonCapabilityOptions {
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

// Intersections, not `Omit`: `CallToolResult` carries a string index signature, so `Omit` would
// collapse it to `{ [x: string]: unknown }` and stop requiring `content`.
export type McpToolErrorResult = CallToolResult & {
	readonly isError: true;
};

export type McpToolSuccessResult<Output extends StandardSchemaWithJSON> = CallToolResult & {
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
		super("tool", name, capabilityConstructionToken, options);
		this.options = normalizeToolOptions(options);
		this.handler = handler;
		assertHandler(handler, "tool handler");
		registerCapability(
			this,
			(server, wrap) =>
				installTool(
					server,
					this.name,
					this.options,
					wrapHandler(wrap, this.handler, this) as McpToolHandler<Input, Output>,
				),
			canonicalToolInstall,
		);
		Object.freeze(this);
	}

	override install(server: McpServer): RegisteredTool {
		return installCanonicalCapability(this, server);
	}

	override withName<const Next extends string>(name: Next): McpToolDefinition<Next, Input, Output> {
		return new McpToolDefinition(name, this.options, this.handler);
	}

	override withMetadata(patch: McpCapabilityMetadataPatch): McpToolDefinition<Name, Input, Output> {
		return new McpToolDefinition(
			this.name,
			{ ...this.options, ...metadataPatch(patch) } as McpToolOptions<Input, Output>,
			this.handler,
		);
	}

	override withHandler(
		handler: McpToolHandler<Input, Output>,
	): McpToolDefinition<Name, Input, Output> {
		return new McpToolDefinition(this.name, this.options, handler);
	}

	override withAuth(auth: McpCapabilityAuth): McpToolDefinition<Name, Input, Output> {
		return new McpToolDefinition(
			this.name,
			{ ...this.options, auth } as McpToolOptions<Input, Output>,
			this.handler,
		);
	}
}

/**
 * Argument completion callback for a prompt argument. Receives the partial value and the other
 * arguments the client already resolved; returns suggestions (capped at 100 on the wire).
 */
export type McpArgumentCompleter = (
	value: string,
	context?: { readonly arguments?: Readonly<Record<string, string>> },
) => MaybePromise<readonly string[]>;

interface McpPromptMetadataOptions extends McpCommonCapabilityOptions {
	readonly title?: string;
	readonly description?: string;
	readonly icons?: readonly McpDeepReadonly<Icon>[];
	readonly _meta?: McpDeepReadonly<Readonly<Record<string, unknown>>>;
	/**
	 * Per-argument completion. The SDK's own `completable()` lookup only works for Zod schemas; this
	 * map works for any `StandardSchemaWithJSON` (including `fromJsonSchema`) because kmcp serves
	 * `completion/complete` itself whenever a prompt declares it.
	 */
	readonly complete?: Readonly<Record<string, McpArgumentCompleter>>;
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
		super("prompt", name, capabilityConstructionToken, options);
		this.options = normalizePromptOptions(options);
		this.handler = handler;
		assertHandler(handler, "prompt handler");
		registerCapability(
			this,
			(server, wrap) =>
				installPrompt(
					server,
					this.name,
					this.options,
					wrapHandler(wrap, this.handler, this) as PromptCallback<Args>,
				),
			canonicalPromptInstall,
		);
		Object.freeze(this);
	}

	override install(server: McpServer): RegisteredPrompt {
		return installCanonicalCapability(this, server);
	}

	override withName<const Next extends string>(name: Next): McpPromptDefinition<Next, Args> {
		return new McpPromptDefinition(name, this.options, this.handler);
	}

	override withMetadata(patch: McpCapabilityMetadataPatch): McpPromptDefinition<Name, Args> {
		return new McpPromptDefinition(
			this.name,
			{ ...this.options, ...metadataPatch(patch) } as McpPromptOptions<Args>,
			this.handler,
		);
	}

	override withHandler(handler: PromptCallback<Args>): McpPromptDefinition<Name, Args> {
		return new McpPromptDefinition(this.name, this.options, handler);
	}

	override withAuth(auth: McpCapabilityAuth): McpPromptDefinition<Name, Args> {
		return new McpPromptDefinition(
			this.name,
			{ ...this.options, auth } as McpPromptOptions<Args>,
			this.handler,
		);
	}
}

interface McpResourceMetadataOptions extends McpCommonCapabilityOptions {
	readonly title?: string;
	readonly description?: string;
	readonly mimeType?: string;
	readonly icons?: readonly McpDeepReadonly<Icon>[];
	readonly annotations?: McpDeepReadonly<Annotations>;
	readonly _meta?: McpDeepReadonly<Readonly<Record<string, unknown>>>;
	readonly cacheHint?: McpDeepReadonly<CacheHint>;
}

export interface McpResourceOptions extends McpResourceMetadataOptions {
	/** Size in bytes, if known. Static resources only — the wire template schema has no `size`. */
	readonly size?: number;
}

export interface McpResourceTemplateOptions extends McpResourceMetadataOptions {
	/** Enumerates concrete resources matching the template for `resources/list`. */
	readonly list?: ListResourcesCallback;
	/** Per-variable completion callbacks for `completion/complete`. */
	readonly complete?: Readonly<Record<string, CompleteResourceTemplateCallback>>;
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
		super("resource", name, capabilityConstructionToken, options);
		assertNonEmpty(uri, "resource URI");
		this.uri = uri;
		this.options = normalizeResourceOptions(options);
		this.handler = handler;
		assertHandler(handler, "resource handler");
		registerCapability(
			this,
			(server, wrap) =>
				server.registerResource(
					this.name,
					this.uri,
					resourceConfig(this.options),
					wrapHandler(wrap, this.handler, this) as ReadResourceCallback,
				),
			canonicalResourceInstall,
		);
		Object.freeze(this);
	}

	override install(server: McpServer): RegisteredResource {
		return installCanonicalCapability(this, server);
	}

	override withName<const Next extends string>(name: Next): McpResourceDefinition<Next, Uri> {
		return new McpResourceDefinition(name, this.uri, this.options, this.handler);
	}

	override withMetadata(patch: McpCapabilityMetadataPatch): McpResourceDefinition<Name, Uri> {
		return new McpResourceDefinition(
			this.name,
			this.uri,
			{ ...this.options, ...metadataPatch(patch) },
			this.handler,
		);
	}

	override withHandler(handler: ReadResourceCallback): McpResourceDefinition<Name, Uri> {
		return new McpResourceDefinition(this.name, this.uri, this.options, handler);
	}

	override withAuth(auth: McpCapabilityAuth): McpResourceDefinition<Name, Uri> {
		return new McpResourceDefinition(this.name, this.uri, { ...this.options, auth }, this.handler);
	}
}

export class McpResourceTemplateDefinition<
	const Name extends string,
> extends McpCapabilityDefinition<"resource-template", Name> {
	declare private readonly resourceTemplateDefinitionBrand: void;

	readonly template: ResourceTemplate;
	readonly options: McpResourceTemplateOptions;
	readonly handler: ReadResourceTemplateCallback;

	constructor(
		name: Name,
		template: ResourceTemplate | string,
		options: McpResourceTemplateOptions,
		handler: ReadResourceTemplateCallback,
	) {
		super("resource-template", name, capabilityConstructionToken, options);
		this.template =
			typeof template === "string"
				? new ResourceTemplate(template, {
						list: options.list,
						...(options.complete === undefined ? {} : { complete: { ...options.complete } }),
					})
				: template;
		this.options = normalizeResourceTemplateOptions(options);
		this.handler = handler;
		assertHandler(handler, "resource-template handler");
		registerCapability(
			this,
			(server, wrap) =>
				server.registerResource(
					this.name,
					this.template,
					resourceConfig(this.options),
					wrapHandler(wrap, this.handler, this) as ReadResourceTemplateCallback,
				),
			canonicalResourceTemplateInstall,
		);
		Object.freeze(this);
	}

	get uriTemplate(): string {
		return this.template.uriTemplate.toString();
	}

	override install(server: McpServer): RegisteredResourceTemplate {
		return installCanonicalCapability(this, server);
	}

	override withName<const Next extends string>(name: Next): McpResourceTemplateDefinition<Next> {
		return new McpResourceTemplateDefinition(name, this.template, this.options, this.handler);
	}

	override withMetadata(patch: McpCapabilityMetadataPatch): McpResourceTemplateDefinition<Name> {
		return new McpResourceTemplateDefinition(
			this.name,
			this.template,
			{ ...this.options, ...metadataPatch(patch) },
			this.handler,
		);
	}

	override withHandler(handler: ReadResourceTemplateCallback): McpResourceTemplateDefinition<Name> {
		return new McpResourceTemplateDefinition(this.name, this.template, this.options, handler);
	}

	override withAuth(auth: McpCapabilityAuth): McpResourceTemplateDefinition<Name> {
		return new McpResourceTemplateDefinition(
			this.name,
			this.template,
			{ ...this.options, auth },
			this.handler,
		);
	}
}

/**
 * Schema-erased tool options, as seen through `AnyMcpToolDefinition`. Schema slots are deliberately
 * absent: naming them here would let contextual typing infer a tool's schema generics from the
 * erased view. Narrow with `instanceof McpToolDefinition` to reach `inputSchema`/`outputSchema`.
 */
export type AnyMcpToolOptions = McpToolMetadataOptions;

/** Schema-erased prompt options, as seen through `AnyMcpPromptDefinition` (see `AnyMcpToolOptions`). */
export type AnyMcpPromptOptions = McpPromptMetadataOptions;

export interface AnyMcpToolDefinition extends McpCapabilityDefinition<"tool", string> {
	readonly options: AnyMcpToolOptions;
	readonly handler: unknown;
	withName(name: string): AnyMcpToolDefinition;
	withMetadata(patch: McpCapabilityMetadataPatch): AnyMcpToolDefinition;
	withHandler(handler: unknown): AnyMcpToolDefinition;
	withAuth(auth: McpCapabilityAuth): AnyMcpToolDefinition;
}

export interface AnyMcpPromptDefinition extends McpCapabilityDefinition<"prompt", string> {
	readonly options: AnyMcpPromptOptions;
	readonly handler: unknown;
	withName(name: string): AnyMcpPromptDefinition;
	withMetadata(patch: McpCapabilityMetadataPatch): AnyMcpPromptDefinition;
	withHandler(handler: unknown): AnyMcpPromptDefinition;
	withAuth(auth: McpCapabilityAuth): AnyMcpPromptDefinition;
}

export interface AnyMcpResourceDefinition extends McpCapabilityDefinition<"resource", string> {
	readonly uri: string;
	readonly options: McpResourceOptions;
	readonly handler: unknown;
	withName(name: string): AnyMcpResourceDefinition;
	withMetadata(patch: McpCapabilityMetadataPatch): AnyMcpResourceDefinition;
	withHandler(handler: unknown): AnyMcpResourceDefinition;
	withAuth(auth: McpCapabilityAuth): AnyMcpResourceDefinition;
}

export interface AnyMcpResourceTemplateDefinition extends McpCapabilityDefinition<
	"resource-template",
	string
> {
	readonly template: ResourceTemplate;
	readonly uriTemplate: string;
	readonly options: McpResourceTemplateOptions;
	readonly handler: unknown;
	withName(name: string): AnyMcpResourceTemplateDefinition;
	withMetadata(patch: McpCapabilityMetadataPatch): AnyMcpResourceTemplateDefinition;
	withHandler(handler: unknown): AnyMcpResourceTemplateDefinition;
	withAuth(auth: McpCapabilityAuth): AnyMcpResourceTemplateDefinition;
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

/**
 * Defines a resource template. Pass an RFC 6570 URI template string plus optional `list` /
 * `complete` callbacks, or a prebuilt SDK `ResourceTemplate`.
 */
export function defineResourceTemplate<const Name extends string>(
	name: Name,
	template: ResourceTemplate | string,
	options: McpResourceTemplateOptions,
	handler: ReadResourceTemplateCallback,
): McpResourceTemplateDefinition<Name> {
	return new McpResourceTemplateDefinition(name, template, options, handler);
}

interface CapabilityState {
	readonly install: (server: McpServer, wrap?: McpCapabilityInstallWrap) => McpRegistrationHandle;
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
	wrap?: McpCapabilityInstallWrap,
): RegisteredTool;
export function installCanonicalCapability(
	definition: AnyMcpPromptDefinition,
	server: McpServer,
	wrap?: McpCapabilityInstallWrap,
): RegisteredPrompt;
export function installCanonicalCapability(
	definition: AnyMcpResourceDefinition,
	server: McpServer,
	wrap?: McpCapabilityInstallWrap,
): RegisteredResource;
export function installCanonicalCapability(
	definition: AnyMcpResourceTemplateDefinition,
	server: McpServer,
	wrap?: McpCapabilityInstallWrap,
): RegisteredResourceTemplate;
export function installCanonicalCapability(
	definition: AnyMcpCapabilityDefinition,
	server: McpServer,
	wrap?: McpCapabilityInstallWrap,
): McpRegistrationHandle;
export function installCanonicalCapability(
	definition: AnyMcpCapabilityDefinition,
	server: McpServer,
	wrap?: McpCapabilityInstallWrap,
): McpRegistrationHandle {
	assertCanonicalCapability(definition);
	const state = capabilityStates.get(definition);
	if (state === undefined) throw new TypeError("Unreachable canonical capability state.");
	return state.install(server, wrap);
}

/** The definition-level identity keys a capability occupies (name per kind, plus URI keyspaces). */
export function capabilityKeys(capability: AnyMcpCapabilityDefinition): readonly string[] {
	const keys = [`${capability.kind}:${capability.name}`];
	if (capability.kind === "resource") keys.push(`resource-uri:${capability.uri}`);
	if (capability.kind === "resource-template") {
		keys.push(`resource-template-uri:${capability.uriTemplate}`);
	}
	return keys;
}

function registerCapability(
	definition: object,
	install: (server: McpServer, wrap?: McpCapabilityInstallWrap) => McpRegistrationHandle,
	publicInstall: McpCapabilityDefinition<McpCapabilityKind, string>["install"],
): void {
	capabilityStates.set(definition, Object.freeze({ install, publicInstall }));
}

function wrapHandler(
	wrap: McpCapabilityInstallWrap | undefined,
	handler: unknown,
	definition: McpCapabilityDefinition<McpCapabilityKind, string>,
): unknown {
	if (wrap === undefined) return handler;
	return wrap(handler as McpWrappableHandler, definition as unknown as AnyMcpCapabilityDefinition);
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

function metadataPatch(patch: McpCapabilityMetadataPatch): McpCapabilityMetadataPatch {
	return {
		...(patch.title === undefined ? {} : { title: patch.title }),
		...(patch.description === undefined ? {} : { description: patch.description }),
		...(patch.tags === undefined ? {} : { tags: patch.tags }),
	};
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
	if (tags === undefined) return [];
	const normalized = [...new Set(tags)];
	for (const tag of normalized) assertNonEmpty(tag, "capability tag");
	return normalized;
}

function normalizeAuth(auth: McpCapabilityAuth): McpCapabilityAuth {
	if (typeof auth.check !== "function") throw new TypeError("auth.check must be a function.");
	if (auth.anonymous !== "allow" && auth.anonymous !== "deny") {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			"auth.anonymous must be 'allow' or 'deny' — it has no default.",
		);
	}
	return Object.freeze({ check: auth.check, anonymous: auth.anonymous });
}

function commonOptions(options: McpCommonCapabilityOptions): McpCommonCapabilityOptions {
	return {
		...(options.tags === undefined ? {} : { tags: Object.freeze(normalizeTags(options.tags)) }),
		...(options.auth === undefined ? {} : { auth: normalizeAuth(options.auth) }),
	};
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
		...commonOptions(options),
	}) as McpToolOptions<Input, Output>;
}

function normalizePromptOptions<Args extends StandardSchemaWithJSON | undefined>(
	options: McpPromptOptions<Args>,
): McpPromptOptions<Args> {
	if (options.complete !== undefined) {
		for (const [argument, completer] of Object.entries(options.complete)) {
			assertNonEmpty(argument, "prompt completion argument");
			assertHandler(completer, `completion callback for '${argument}'`);
		}
	}
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
		...(options.complete === undefined ? {} : { complete: Object.freeze({ ...options.complete }) }),
		...commonOptions(options),
	}) as McpPromptOptions<Args>;
}

function normalizeResourceMetadata(
	options: McpResourceMetadataOptions,
): McpResourceMetadataOptions {
	return {
		...(options.title === undefined ? {} : { title: options.title }),
		...(options.description === undefined ? {} : { description: options.description }),
		...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
		...(options.icons === undefined
			? {}
			: { icons: immutableProtocolClone(options.icons, "resource icons") }),
		...(options.annotations === undefined
			? {}
			: { annotations: immutableProtocolClone(options.annotations, "resource annotations") }),
		...(options._meta === undefined
			? {}
			: { _meta: immutableProtocolClone(options._meta, "resource _meta") }),
		...(options.cacheHint === undefined
			? {}
			: { cacheHint: immutableProtocolClone(options.cacheHint, "resource cacheHint") }),
		...commonOptions(options),
	};
}

function normalizeResourceOptions(options: McpResourceOptions): McpResourceOptions {
	if (options.size !== undefined && (!Number.isSafeInteger(options.size) || options.size < 0)) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			"resource size must be a non-negative safe integer.",
		);
	}
	return Object.freeze({
		...normalizeResourceMetadata(options),
		...(options.size === undefined ? {} : { size: options.size }),
	});
}

function normalizeResourceTemplateOptions(
	options: McpResourceTemplateOptions,
): McpResourceTemplateOptions {
	if (options.list !== undefined) assertHandler(options.list, "resource template list callback");
	if (options.complete !== undefined) {
		for (const [variable, completer] of Object.entries(options.complete)) {
			assertNonEmpty(variable, "resource template variable");
			assertHandler(completer, `completion callback for '${variable}'`);
		}
	}
	return Object.freeze({
		...normalizeResourceMetadata(options),
		...(options.list === undefined ? {} : { list: options.list }),
		...(options.complete === undefined ? {} : { complete: Object.freeze({ ...options.complete }) }),
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

function resourceConfig(
	options: McpResourceMetadataOptions & { readonly size?: number },
): ResourceMetadata & { cacheHint?: CacheHint } {
	return {
		...(options.title === undefined ? {} : { title: options.title }),
		...(options.description === undefined ? {} : { description: options.description }),
		...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
		...(options.size === undefined ? {} : { size: options.size }),
		...(options.icons === undefined
			? {}
			: { icons: options.icons.map((icon) => mutableProtocolClone<Icon>(icon)) }),
		...(options.annotations === undefined
			? {}
			: { annotations: mutableProtocolClone<Annotations>(options.annotations) }),
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
