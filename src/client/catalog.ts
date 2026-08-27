import type { Prompt, Resource, ResourceTemplateType, Tool } from "@modelcontextprotocol/client";

export type McpCatalogStatus = "failed" | "fresh" | "stale" | "unsupported";

export interface McpCatalogSection<Item> {
	readonly status: McpCatalogStatus;
	readonly items: readonly Item[];
	readonly byteSize: number;
	readonly nodeCount: number;
	readonly fingerprint?: string;
	readonly errorCode?: string;
}

export interface McpCatalogSnapshot {
	readonly generation: number;
	/** Stable for one generation and catalog content; never reusable across reconnects. */
	readonly fingerprint: string;
	readonly discoveredAt: string;
	readonly totalItems: number;
	readonly totalBytes: number;
	readonly totalNodes: number;
	readonly tools: McpCatalogSection<Tool>;
	readonly resources: McpCatalogSection<Resource>;
	readonly resourceTemplates: McpCatalogSection<ResourceTemplateType>;
	readonly prompts: McpCatalogSection<Prompt>;
}

export type McpCatalogCapability = keyof Pick<
	McpCatalogSnapshot,
	"prompts" | "resourceTemplates" | "resources" | "tools"
>;
