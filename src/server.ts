export {
	McpCapabilityDefinition,
	McpPromptDefinition,
	McpResourceDefinition,
	McpResourceTemplateDefinition,
	McpToolDefinition,
	definePrompt,
	defineResource,
	defineResourceTemplate,
	defineTool,
} from "./authoring/capability.ts";
export type {
	AnyMcpCapabilityDefinition,
	AnyMcpPromptDefinition,
	AnyMcpResourceDefinition,
	AnyMcpResourceTemplateDefinition,
	AnyMcpToolDefinition,
	McpCapabilityKey,
	McpCapabilityKind,
	McpDeepReadonly,
	McpPromptOptions,
	McpResourceOptions,
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
} from "./authoring/server-definition.ts";
export type {
	McpInstalledCapability,
	McpServerDefinitionOptions,
} from "./authoring/server-definition.ts";
