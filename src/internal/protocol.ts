/**
 * The first modern MCP protocol revision (2026-07-28).
 *
 * The official SDK exports no constant for it: `LATEST_PROTOCOL_VERSION` is `"2025-11-25"`,
 * the latest *legacy* revision, and `FIRST_MODERN_PROTOCOL_VERSION` is internal. Every modern
 * pin in kmcp goes through this constant so a 2025 revision can never be pinned by accident.
 */
export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28" as const;

export type McpProtocolEra = "legacy" | "modern";
