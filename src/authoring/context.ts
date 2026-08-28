import {
	type AuthInfo,
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	type ClientCapabilities,
	type Implementation,
	LOG_LEVEL_META_KEY,
	type LoggingLevel,
	PROTOCOL_VERSION_META_KEY,
	type ServerContext,
} from "@modelcontextprotocol/server";

/**
 * Explicit helpers over the official `ServerContext` a handler receives. kmcp deliberately has no
 * ambient (AsyncLocalStorage) context: every helper takes `ctx` as its first argument.
 */

export type McpProgressReporter = (
	progress: number,
	total?: number,
	message?: string,
) => Promise<void>;

/**
 * A `notifications/progress` reporter bound to the current request. It is a no-op when the
 * request carried no `progressToken`. On modern HTTP with `responseMode: "json"` mid-call
 * notifications are dropped by the SDK; progress is best-effort by design.
 */
export function progress(ctx: ServerContext): McpProgressReporter {
	const progressToken = ctx.mcpReq._meta?.progressToken;
	if (progressToken === undefined) return async () => undefined;
	return async (value, total, message) => {
		await ctx.mcpReq.notify({
			method: "notifications/progress",
			params: {
				progressToken,
				progress: value,
				...(total === undefined ? {} : { total }),
				...(message === undefined ? {} : { message }),
			},
		});
	};
}

export interface McpPrincipal {
	readonly clientId: string;
	readonly scopes: readonly string[];
	readonly expiresAt?: number;
	readonly resource?: URL;
	readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * The verified identity of the caller **without the bearer token**. `ctx.http.authInfo.token` is a
 * live credential; read identity through this helper so it never leaks into results or logs.
 */
export function principal(ctx: ServerContext): McpPrincipal | undefined {
	const authInfo: AuthInfo | undefined = ctx.http?.authInfo;
	if (authInfo === undefined) return undefined;
	return Object.freeze({
		clientId: authInfo.clientId,
		scopes: Object.freeze([...authInfo.scopes]),
		...(authInfo.expiresAt === undefined ? {} : { expiresAt: authInfo.expiresAt }),
		...(authInfo.resource === undefined ? {} : { resource: authInfo.resource }),
		...(authInfo.extra === undefined ? {} : { extra: authInfo.extra }),
	});
}

export interface McpClientIdentity {
	readonly protocolVersion?: string;
	readonly clientInfo?: Implementation;
	readonly clientCapabilities?: ClientCapabilities;
	readonly logLevel?: LoggingLevel;
}

/**
 * The per-request client identity carried by the modern `_meta` envelope (protocol revision
 * 2026-07-28). Empty on legacy connections, where identity was exchanged at `initialize`.
 */
export function clientIdentity(ctx: ServerContext): McpClientIdentity {
	const envelope = (ctx.mcpReq.envelope ?? {}) as Readonly<Record<string, unknown>>;
	const protocolVersion = envelope[PROTOCOL_VERSION_META_KEY];
	const clientInfo = envelope[CLIENT_INFO_META_KEY];
	const clientCapabilities = envelope[CLIENT_CAPABILITIES_META_KEY];
	const logLevel = envelope[LOG_LEVEL_META_KEY];
	return Object.freeze({
		...(typeof protocolVersion === "string" ? { protocolVersion } : {}),
		...(isObject(clientInfo) ? { clientInfo: clientInfo as Implementation } : {}),
		...(isObject(clientCapabilities)
			? { clientCapabilities: clientCapabilities as ClientCapabilities }
			: {}),
		...(typeof logLevel === "string" ? { logLevel: logLevel as LoggingLevel } : {}),
	});
}

export type McpLogger = {
	readonly [Level in LoggingLevel]: (data: unknown, logger?: string) => Promise<void>;
};

/**
 * RFC 5424 shorthands over `ctx.mcpReq.log`. Messages are delivered only when the definition
 * declares `logging: true` and, on the modern era, when the client requested a level via the
 * `io.modelcontextprotocol/logLevel` envelope key — otherwise the SDK drops them silently.
 * `logging` is deprecated as of protocol revision 2026-07-28 (SEP-2577); prefer stderr/OTel.
 */
export function log(ctx: ServerContext): McpLogger {
	const at =
		(level: LoggingLevel) =>
		(data: unknown, logger?: string): Promise<void> =>
			ctx.mcpReq.log(level, data, logger);
	return Object.freeze({
		debug: at("debug"),
		info: at("info"),
		notice: at("notice"),
		warning: at("warning"),
		error: at("error"),
		critical: at("critical"),
		alert: at("alert"),
		emergency: at("emergency"),
	});
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
