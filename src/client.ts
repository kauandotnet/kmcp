export type {
	McpCatalogCapability,
	McpCatalogSection,
	McpCatalogSnapshot,
	McpCatalogStatus,
} from "./client/catalog.ts";
export {
	McpClientSession,
	McpConnectionDefinition,
	createOfficialClient,
	defineConnection,
	httpConnection,
	inProcessConnection,
	normalizeRoots,
} from "./client/connection.ts";
export type {
	McpAutoRefreshOptions,
	McpClientAdvertise,
	McpReconnectBackoffOptions,
	McpReconnectOptions,
	McpResolvedReconnectOptions,
	McpClientNotificationHandlers,
	McpClientNotificationMethod,
	McpClientRequestHandlers,
	McpClientRequestMethod,
	McpConnectionDefinitionOptions,
	McpHttpAuth,
	McpHttpConnectionOptions,
	McpInProcessConnectionOptions,
	McpInProcessServer,
	McpOfficialClientOverrides,
	McpRequestDefaults,
	McpRootsSource,
	McpTransportFactory,
} from "./client/connection.ts";
export { InMemoryKeyValueStore, McpOAuthClientProvider } from "./client/oauth.ts";
export type { McpKeyValueStore, McpOAuthClientProviderOptions } from "./client/oauth.ts";
export { MCP_MODERN_PROTOCOL_VERSION } from "./internal/protocol.ts";
export type { McpProtocolEra } from "./internal/protocol.ts";
export {
	McpConnectionManager,
	McpToolCallError,
	describeError,
	parseToolResult,
	throwIfToolError,
} from "./client/manager.ts";
export type {
	McpCallToolOptions,
	McpCallToolParsedOptions,
	McpConnectAllOptions,
	McpConnectionEvent,
	McpConnectionEventType,
	McpConnectionListener,
	McpConnectionManagerOptions,
	McpConnectionManagerSnapshot,
	McpConnectionOperationControl,
	McpConnectionPhase,
	McpConnectionSnapshot,
	McpErrorDetail,
	McpMetaOptions,
	McpMrtrForwardOptions,
	McpParsedToolResult,
	McpPingResult,
	McpReadOptions,
	McpRequestOptionsWithMeta,
	McpWatchSnapshot,
} from "./client/manager.ts";
