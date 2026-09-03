export {
	McpCapabilityDefinition,
	McpPromptDefinition,
	McpResourceDefinition,
	McpResourceTemplateDefinition,
	McpToolDefinition,
	capabilityKeys,
	definePrompt,
	defineResource,
	defineResourceTemplate,
	defineTool,
	requireScopes,
} from "./authoring/capability.ts";
export type {
	AnyMcpCapabilityDefinition,
	AnyMcpPromptDefinition,
	AnyMcpPromptOptions,
	AnyMcpResourceDefinition,
	AnyMcpResourceTemplateDefinition,
	AnyMcpToolDefinition,
	AnyMcpToolOptions,
	McpArgumentCompleter,
	McpAuthVerdict,
	McpCapabilityAuth,
	McpCapabilityKey,
	McpCapabilityKind,
	McpCapabilityMetadataPatch,
	McpDeepReadonly,
	McpPromptOptions,
	McpResourceOptions,
	McpResourceTemplateOptions,
	McpToolErrorResult,
	McpToolHandler,
	McpToolOptions,
	McpToolResult,
	McpToolSuccessResult,
	McpRegistrationHandle,
} from "./authoring/capability.ts";
export { McpServerBuilder } from "./authoring/builder.ts";
export {
	McpPrompt,
	McpResource,
	McpResourceTemplate,
	McpServerApp,
	McpTool,
	capabilitiesOf,
	serverFrom,
} from "./authoring/decorators.ts";
export type { McpServerAppOptions } from "./authoring/decorators.ts";
export {
	McpServerDefinition,
	McpServerRuntime,
	defineServer,
	resolveServerSource,
	serverSourceFactory,
} from "./authoring/server-definition.ts";
export type {
	McpCapabilityDenial,
	McpCapabilityProvider,
	McpInstalledCapability,
	McpServable,
	McpMountOptions,
	McpServerDefinitionOptions,
	McpServerSource,
	McpSetupCleanup,
} from "./authoring/server-definition.ts";
export {
	composeTransforms,
	decorateHandlers,
	filterCapabilities,
	mapCapabilities,
	prefixNames,
} from "./authoring/transform.ts";
export type {
	McpCapabilityMappers,
	McpCapabilityPredicates,
	McpDefinitionTransform,
	McpHandlerDecorator,
	PrefixNamesOptions,
} from "./authoring/transform.ts";
export {
	abortable,
	cacheCalls,
	logCalls,
	principalPartition,
	rateLimit,
	sizeLimit,
	timeout,
} from "./authoring/handler-decorators.ts";
export type {
	CacheCallsOptions,
	McpCallKeyFn,
	McpCallLogEntry,
	RateLimitOptions,
} from "./authoring/handler-decorators.ts";
export { withJsonSchema } from "./authoring/schema.ts";
export {
	logMiddleware,
	maskErrorDetails,
	middlewarePrincipal,
	responseLimit,
	timingMiddleware,
	tokenBucketMiddleware,
} from "./authoring/middleware.ts";
export type {
	MaskErrorOptions,
	McpMiddleware,
	McpMiddlewareContext,
	McpMiddlewareKeyFn,
	McpMiddlewareLogEntry,
	McpMiddlewareNext,
	McpTimingEntry,
	TokenBucketOptions,
} from "./authoring/middleware.ts";
export {
	McpInsufficientScopeError,
	allOf,
	anyOf,
	authorize,
	requireRoles,
	restrictTag,
} from "./authoring/authorization.ts";
export type { McpAuthCheck } from "./authoring/authorization.ts";
export { disable, enable, applyVisibility } from "./authoring/visibility.ts";
export type { McpVisibilityRule, McpVisibilitySelector } from "./authoring/visibility.ts";
export { transformTool, transformTools } from "./authoring/tool-transform.ts";
export type { McpArgTransform, McpToolTransformOptions } from "./authoring/tool-transform.ts";
export { namespaceUris } from "./authoring/uri-namespace.ts";
export type { McpUriNamespaceOptions } from "./authoring/uri-namespace.ts";
export { serveWithLifespan } from "./authoring/lifespan.ts";
export type { McpLifespan } from "./authoring/lifespan.ts";
export { searchTools } from "./discovery/search.ts";
export type { McpSearchToolsOptions } from "./discovery/search.ts";
export { promptsAsTools, resourcesAsTools } from "./discovery/as-tools.ts";
export type {
	McpAsToolsOptions,
	McpPromptsAsToolsOptions,
	McpResourcesAsToolsOptions,
} from "./discovery/as-tools.ts";
export { McpAuthorizationError, createMcpAuthGate, withMcpAuth } from "./auth/gate.ts";
export type { McpAuthGate, McpAuthGateOptions, McpRequestVerifier } from "./auth/gate.ts";
export {
	DEFAULT_SENSITIVE_HEADERS,
	createHttpRequestReader,
	forwardableHeaders,
	httpRequest,
} from "./auth/http-context.ts";
export type {
	ForwardableHeadersOptions,
	McpHttpRequestReader,
	McpHttpRequestReaderOptions,
	McpHttpRequestView,
} from "./auth/http-context.ts";
export {
	assistantMessage,
	audioContent,
	blobResourceContents,
	embeddedBlobResource,
	embeddedTextResource,
	errorResult,
	imageContent,
	jsonResult,
	promptResult,
	resourceLink,
	resourceResult,
	textContent,
	textResourceContents,
	toolResult,
	userMessage,
} from "./authoring/result.ts";
export type { McpJsonResult, McpToolSuccess, ResourceLinkOptions } from "./authoring/result.ts";
export { clientIdentity, log, principal, progress } from "./authoring/context.ts";
export type {
	McpClientIdentity,
	McpLogger,
	McpPrincipal,
	McpProgressReporter,
} from "./authoring/context.ts";
export { encodeBase64 } from "./internal/base64.ts";
export { MCP_MODERN_PROTOCOL_VERSION } from "./internal/protocol.ts";
export type { McpProtocolEra } from "./internal/protocol.ts";

// Curated official SDK v2 surface so authoring a kmcp server needs no second import.
export {
	InMemoryServerEventBus,
	MissingRequiredClientCapabilityError,
	ProtocolError,
	ProtocolErrorCode,
	ResourceNotFoundError,
	ResourceTemplate,
	SdkError,
	SdkErrorCode,
	UnsupportedProtocolVersionError,
	UriTemplate,
	UrlElicitationRequiredError,
	acceptedContent,
	checkResourceAllowed,
	classifyInboundRequest,
	completable,
	createMcpHandler,
	createRequestStateCodec,
	fromJsonSchema,
	inputRequired,
	inputResponse,
	isCompletable,
	isInputRequiredResult,
	isLegacyRequest,
	mergeCapabilities,
} from "@modelcontextprotocol/server";
export type {
	AuthInfo,
	CacheHint,
	CallToolResult,
	CompleteCallback,
	CompleteResourceTemplateCallback,
	ContentBlock,
	CreateMcpHandlerOptions,
	GetPromptResult,
	Implementation,
	InboundClassificationOutcome,
	InboundHttpRequest,
	InputRequiredResult,
	InputRequiredSpec,
	InputRequest,
	InputRequests,
	InputResponse,
	InputResponseView,
	InputResponses,
	ListResourcesCallback,
	McpHandlerRequestOptions,
	McpHttpHandler,
	McpRequestContext,
	McpServerFactory,
	PromptMessage,
	ReadResourceResult,
	RequestStateCodec,
	RequestStateCodecOptions,
	ServerContext,
	ServerEvent,
	ServerEventBus,
	ServerNotifier,
	ServerOptions,
	StandardSchemaV1,
	StandardSchemaWithJSON,
	Variables,
} from "@modelcontextprotocol/server";
