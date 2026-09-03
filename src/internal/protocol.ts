import {
	SUPPORTED_PROTOCOL_VERSIONS,
	type VersionNegotiationOptions,
} from "@modelcontextprotocol/client";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";

/**
 * The first modern MCP protocol revision (2026-07-28).
 *
 * The official SDK exports no constant for it: `LATEST_PROTOCOL_VERSION` is `"2025-11-25"`,
 * the latest *legacy* revision, and `FIRST_MODERN_PROTOCOL_VERSION` is internal. Every modern
 * pin in kmcp goes through this constant so a 2025 revision can never be pinned by accident.
 */
export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28" as const;

export type McpProtocolEra = "legacy" | "modern";

/**
 * Legacy-era revisions the SDK's `initialize` handshake can offer, newest first. Derived from
 * the SDK's own list so it can never drift; the modern revision is filtered out defensively in
 * case a future SDK folds it into the same constant.
 */
export const MCP_LEGACY_PROTOCOL_VERSIONS: readonly string[] = Object.freeze(
	SUPPORTED_PROTOCOL_VERSIONS.filter((version) => version < MCP_MODERN_PROTOCOL_VERSION),
);

/** Every revision a connection can pin through `protocolVersion`, newest first. */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = Object.freeze([
	MCP_MODERN_PROTOCOL_VERSION,
	...MCP_LEGACY_PROTOCOL_VERSIONS,
]);

/** Whether a revision belongs to the modern (2026-07-28 and later) era. */
export function isModernProtocolVersion(version: string): boolean {
	return version >= MCP_MODERN_PROTOCOL_VERSION;
}

/** The SDK client options that pin a connection to exactly one protocol revision (no fallback). */
export interface McpProtocolPin {
	readonly versionNegotiation: VersionNegotiationOptions;
	readonly supportedProtocolVersions?: readonly string[];
}

/**
 * Resolves a `protocolVersion` pin into the SDK's negotiation options: a modern revision uses the
 * `{ pin }` mode (the connect-time `server/discover` must offer it); a legacy revision runs the
 * plain `initialize` handshake offering only that revision, so a server that counter-offers
 * anything else is refused. Unknown revisions fail here, before any transport is opened.
 */
export function resolveProtocolPin(version: string): McpProtocolPin {
	if (!MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
		throw new KmcpError(
			KMCP_ERROR_CODES.PROTOCOL_VERSION_UNSUPPORTED,
			`Unsupported MCP protocol version '${version}'. Supported: ${MCP_SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`,
		);
	}
	if (isModernProtocolVersion(version)) {
		return Object.freeze({ versionNegotiation: { mode: { pin: version } } });
	}
	return Object.freeze({
		versionNegotiation: { mode: "legacy" as const },
		supportedProtocolVersions: Object.freeze([version]),
	});
}
