import { createServer, type Server } from "node:http";

import {
	type NodeIncomingMessageLike,
	toNodeHandler,
	type ToNodeHandlerOptions,
} from "@modelcontextprotocol/node";
import {
	type CreateMcpHandlerOptions,
	createMcpHandler,
	hostHeaderValidationResponse,
	localhostAllowedHostnames,
	localhostAllowedOrigins,
	type McpHttpHandler,
	originValidationResponse,
} from "@modelcontextprotocol/server";

import { type McpAuthGate, withMcpAuth } from "../auth/gate.ts";
import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import {
	type McpServerSource,
	resolveServerSource,
	serverSourceFactory,
} from "../authoring/server-definition.ts";

export interface McpDnsRebindingOptions {
	/** Allowed `Host` hostnames (no port; IPv6 in brackets). REQUIRED on a routable bind. */
	readonly hosts?: readonly string[];
	/** Allowed `Origin` hostnames; a request with no `Origin` always passes. Default: loopback. */
	readonly origins?: readonly string[];
}

export interface McpHttpServeOptions {
	readonly host?: string;
	readonly port?: number;
	readonly path?: string;
	readonly mcp?: CreateMcpHandlerOptions;
	readonly node?: ToNodeHandlerOptions;
	readonly auth?: McpAuthGate;
	readonly dnsRebinding?: McpDnsRebindingOptions;
	/** Serve a static `ok` (text/plain) at this path, before every other step. */
	readonly health?: string;
	/** Required acknowledgement for binding a routable host with no `auth` gate. */
	readonly allowUnauthenticated?: true;
}

export interface McpHttpServerAddress {
	readonly host: string;
	readonly port: number;
	readonly path: string;
	readonly url: URL;
}

export interface McpHttpServerHandle extends AsyncDisposable {
	readonly address: McpHttpServerAddress;
	readonly handler: McpHttpHandler;
	readonly server: Server;
	close(): Promise<void>;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

/**
 * Serves a definition over `node:http` with a fixed pipeline:
 * `OPTIONS` → 405 · health · OAuth discovery documents (via the gate) · `Host`/`Origin` validation
 * · bearer gate · MCP. Fail-closed defaults: loopback bind, DNS-rebinding validation on every bind,
 * a routable bind requires `dnsRebinding.hosts` and either `auth` or `allowUnauthenticated`.
 * No CORS and no route registry — compose those in your framework over `createNodeMcpHandler`.
 */
export async function serveMcpHttp(
	source: McpServerSource,
	options: McpHttpServeOptions = {},
): Promise<McpHttpServerHandle> {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 3000;
	const path = options.path ?? "/mcp";
	assertServeOptions(host, port, path, options);
	const definition = resolveServerSource(source);
	if (definition.requiresAuthenticatedPrincipal && options.auth === undefined) {
		throw new KmcpError(
			KMCP_ERROR_CODES.CAPABILITY_AUTH_UNSERVEABLE,
			'serveMcpHttp has no auth gate, but a capability declares auth.anonymous: "deny".',
		);
	}
	const loopback = LOOPBACK_HOSTS.has(host.toLowerCase());
	if (!loopback && options.auth === undefined && options.allowUnauthenticated !== true) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`Refusing to bind ${host} without an auth gate; pass allowUnauthenticated: true to acknowledge.`,
		);
	}
	const hosts = options.dnsRebinding?.hosts;
	if (!loopback && (hosts === undefined || hosts.length === 0)) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`Binding ${host} requires dnsRebinding.hosts (the hostnames clients will use).`,
		);
	}
	const allowedHosts = [...(hosts ?? localhostAllowedHostnames())];
	const allowedOrigins = [...(options.dnsRebinding?.origins ?? localhostAllowedOrigins())];

	const mcp = createMcpHandler(serverSourceFactory(source), options.mcp);
	const gated = options.auth === undefined ? mcp : withMcpAuth(mcp, options.auth);
	const gate = options.auth;
	const health = options.health;
	const pipeline = {
		fetch: async (request: Request, requestOptions?: Parameters<McpHttpHandler["fetch"]>[1]) => {
			const url = new URL(request.url);
			if (request.method === "OPTIONS") {
				return new Response(null, { status: 405, headers: { allow: "GET, POST, DELETE" } });
			}
			if (health !== undefined && url.pathname === health) {
				return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
			}
			if (url.pathname.startsWith("/.well-known/oauth-")) {
				return gate === undefined ? notFound() : await documentOr404(gate, request);
			}
			if (url.pathname !== path) return notFound();
			const rejected =
				hostHeaderValidationResponse(request, allowedHosts) ??
				originValidationResponse(request, allowedOrigins);
			if (rejected !== undefined) return rejected;
			return gated.fetch(request, requestOptions);
		},
	};
	const node = toNodeHandler(pipeline, options.node);
	const server = createServer((request, response) => {
		// Node types `method` as optional; the SDK's duck type requires it (always set for served requests).
		void node(request as NodeIncomingMessageLike & typeof request, response);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const bound = server.address();
	const actualPort = bound !== null && typeof bound !== "string" ? bound.port : port;
	const address: McpHttpServerAddress = Object.freeze({
		host,
		port: actualPort,
		path,
		url: new URL(`http://${LOOPBACK_HOSTS.has(host) ? "127.0.0.1" : host}:${actualPort}${path}`),
	});
	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= (async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error === undefined ? resolve() : reject(error))),
			);
			await mcp.close();
		})();
		return closing;
	};
	return {
		address,
		handler: gated,
		server,
		close,
		[Symbol.asyncDispose]: close,
	};
}

async function documentOr404(gate: McpAuthGate, request: Request): Promise<Response> {
	const result = await gate(request);
	return result instanceof Response ? result : notFound();
}

function notFound(): Response {
	return Response.json({ error: "Not Found" }, { status: 404 });
}

function assertServeOptions(
	host: string,
	port: number,
	path: string,
	options: McpHttpServeOptions,
): void {
	if (typeof host !== "string" || host.length === 0)
		throw new RangeError("host must be a non-empty string.");
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		throw new RangeError("port must be 0-65535.");
	if (!path.startsWith("/")) throw new RangeError('path must start with "/".');
	if (options.health !== undefined) {
		if (!options.health.startsWith("/")) throw new RangeError('health must start with "/".');
		if (options.health === path) throw new RangeError("health must not equal the MCP path.");
	}
}

/**
 * Explicit environment resolution the caller spreads into `serveMcpHttp` options:
 * `MCP_HOST`, `MCP_PORT` (falling back to `PORT`), `MCP_PATH`. Malformed values throw.
 */
export function mcpHttpEnvOptions(
	env: Readonly<Record<string, string | undefined>> = process.env,
): McpHttpServeOptions {
	const host = env["MCP_HOST"];
	const rawPort = env["MCP_PORT"] ?? env["PORT"];
	const path = env["MCP_PATH"];
	let port: number | undefined;
	if (rawPort !== undefined && rawPort.trim() !== "") {
		port = Number(rawPort);
		if (!Number.isInteger(port) || port < 0 || port > 65535) {
			throw new RangeError(
				`MCP_PORT/PORT must be an integer in 0-65535; received ${JSON.stringify(rawPort)}.`,
			);
		}
	}
	if (path !== undefined && !path.startsWith("/")) {
		throw new RangeError(`MCP_PATH must start with "/"; received ${JSON.stringify(path)}.`);
	}
	return {
		...(host === undefined || host.trim() === "" ? {} : { host: host.trim() }),
		...(port === undefined ? {} : { port }),
		...(path === undefined ? {} : { path }),
	};
}

/** Strict boolean environment parsing (`1/true/yes/on` · `0/false/no/off`); malformed values throw. */
export function envBool(
	name: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean | undefined {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return undefined;
	const normalized = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	throw new RangeError(
		`${name} must be a boolean (1/true/yes/on or 0/false/no/off); received ${JSON.stringify(raw)}.`,
	);
}
