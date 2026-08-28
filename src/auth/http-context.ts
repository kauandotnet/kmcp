import type { ServerContext } from "@modelcontextprotocol/server";

/**
 * Header names whose values are credentials for this hop. Withheld from `httpRequest(ctx).headers`
 * (observable through `redactedHeaderNames`) and dropped by `forwardableHeaders`.
 * `mcp-session-id` stays listed because the SDK's default `legacy: "stateless"` posture still
 * answers 2025-era clients that send it.
 */
export const DEFAULT_SENSITIVE_HEADERS: readonly string[] = Object.freeze([
	"authorization",
	"cookie",
	"proxy-authorization",
	"mcp-session-id",
]);

export interface McpHttpRequestView {
	/** Headers of the carrying request minus the sensitive set. A per-call copy. */
	readonly headers: Headers;
	/** Lowercase, sorted names that were on the wire but withheld. */
	readonly redactedHeaderNames: readonly string[];
	readonly method: string;
	/** Origin-form target (path + query). Scheme and authority are unknowable behind a proxy. */
	readonly url: string;
}

export interface McpHttpRequestReaderOptions {
	/** Extra header names to withhold (e.g. a proxy provenance secret). */
	readonly redactHeaders?: readonly string[];
	/** Names to re-admit from the default sensitive set — the explicit, greppable opt-out. */
	readonly exposeHeaders?: readonly string[];
}

export type McpHttpRequestReader = (ctx: ServerContext) => McpHttpRequestView | undefined;

/**
 * Builds a reader for the HTTP request carrying the current MCP message. The sensitive set is
 * resolved ONCE here, so a handler can never forget to redact. Everything the reader returns is
 * client-controlled input: never derive authorization from it — use `principal(ctx)`.
 */
export function createHttpRequestReader(
	options: McpHttpRequestReaderOptions = {},
): McpHttpRequestReader {
	const sensitive = new Set(DEFAULT_SENSITIVE_HEADERS);
	for (const name of options.redactHeaders ?? []) sensitive.add(name.toLowerCase());
	for (const name of options.exposeHeaders ?? []) sensitive.delete(name.toLowerCase());
	return (ctx) => {
		const request = ctx.http?.req;
		if (request === undefined) return undefined;
		const headers = new Headers();
		const redacted: string[] = [];
		request.headers.forEach((value, name) => {
			if (sensitive.has(name)) redacted.push(name);
			else headers.append(name, value);
		});
		redacted.sort();
		let url: string;
		try {
			const parsed = new URL(request.url);
			url = parsed.pathname + parsed.search;
		} catch {
			url = request.url;
		}
		return Object.freeze({
			headers,
			redactedHeaderNames: Object.freeze(redacted),
			method: request.method,
			url,
		});
	};
}

/** The zero-configuration reader (default sensitive set). */
export const httpRequest: McpHttpRequestReader = createHttpRequestReader();

const UNFORWARDABLE: ReadonlySet<string> = new Set([
	// credentials
	"authorization",
	"cookie",
	"proxy-authorization",
	"proxy-authenticate",
	// hop-by-hop (RFC 9110 §7.6.1) and connection management
	"connection",
	"keep-alive",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"proxy-connection",
	// message framing / target-specific
	"host",
	"content-length",
	"content-type",
	"expect",
]);

export interface ForwardableHeadersOptions {
	/** Names to re-admit. Re-admitting `authorization` forwards the caller's credential, which the MCP spec forbids — mint your own upstream credential instead. */
	readonly include?: readonly string[];
}

/**
 * A copy of `headers` safe to attach to an outbound request: drops credentials, hop-by-hop and
 * framing headers, and every `mcp-*` protocol header.
 */
export function forwardableHeaders(
	headers: Headers,
	options: ForwardableHeadersOptions = {},
): Headers {
	const include = new Set((options.include ?? []).map((name) => name.toLowerCase()));
	const out = new Headers();
	headers.forEach((value, name) => {
		if (include.has(name)) {
			out.append(name, value);
			return;
		}
		if (UNFORWARDABLE.has(name) || name.startsWith("mcp-")) return;
		out.append(name, value);
	});
	return out;
}
