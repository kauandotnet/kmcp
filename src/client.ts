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
	throwIfToolError,
} from "./client/manager.ts";
export type {
	McpCallToolOptions,
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
	McpPingResult,
	McpReadOptions,
	McpRequestOptionsWithMeta,
	McpWatchSnapshot,
} from "./client/manager.ts";
