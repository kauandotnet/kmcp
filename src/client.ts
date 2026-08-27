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
} from "./client/connection.ts";
export type {
	McpConnectionDefinitionOptions,
	McpHttpConnectionOptions,
	McpTransportFactory,
} from "./client/connection.ts";
export { McpConnectionManager } from "./client/manager.ts";
export type {
	McpConnectionEvent,
	McpConnectionEventType,
	McpConnectionListener,
	McpConnectionManagerOptions,
	McpConnectionManagerSnapshot,
	McpConnectionOperationControl,
	McpConnectionPhase,
	McpConnectionSnapshot,
} from "./client/manager.ts";
