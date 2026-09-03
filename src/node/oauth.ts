import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";

import type { McpKeyValueStore } from "../client/oauth.ts";
import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import { assertNonEmpty } from "../internal/value.ts";

const FILE_MODE = 0o600;

/**
 * A {@link McpKeyValueStore} backed by one JSON file.
 *
 * The file is created with mode `0600`, loaded lazily on first access, and rewritten atomically
 * (temporary file plus `rename`) so a crash mid-write cannot truncate stored credentials. Writes
 * from one instance are serialized; a read-modify-write therefore never loses a concurrent entry.
 * Separate instances over the same path still race, exactly as two processes would.
 */
export class FileKeyValueStore implements McpKeyValueStore {
	/** The JSON file backing this store. */
	readonly path: string;
	#entries: Promise<Record<string, string>> | undefined;
	#writes: Promise<void> = Promise.resolve();

	constructor(path: string) {
		assertNonEmpty(path, "store path");
		this.path = path;
	}

	async get(key: string): Promise<string | undefined> {
		return (await this.#load())[key];
	}

	async set(key: string, value: string): Promise<void> {
		await this.#mutate((entries) => {
			entries[key] = value;
		});
	}

	async delete(key: string): Promise<void> {
		await this.#mutate((entries) => {
			delete entries[key];
		});
	}

	#load(): Promise<Record<string, string>> {
		this.#entries ??= this.#read();
		return this.#entries;
	}

	async #read(): Promise<Record<string, string>> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf8");
		} catch {
			// An absent or unreadable file is an empty store, not a fatal error.
			return {};
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new KmcpError(
				KMCP_ERROR_CODES.OPERATION_FAILED,
				`${this.path} is not a valid JSON credential store.`,
				{ cause: error },
			);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new KmcpError(
				KMCP_ERROR_CODES.OPERATION_FAILED,
				`${this.path} must contain a JSON object of string values.`,
			);
		}
		const entries: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === "string") entries[key] = value;
		}
		return entries;
	}

	#mutate(apply: (entries: Record<string, string>) => void): Promise<void> {
		const task = this.#writes.then(async () => {
			const entries = await this.#load();
			apply(entries);
			await this.#write(entries);
		});
		this.#writes = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}

	async #write(entries: Record<string, string>): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify(entries, null, 2), {
				encoding: "utf8",
				mode: FILE_MODE,
			});
			await rename(temporary, this.path);
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => undefined);
			throw error;
		}
		await chmod(this.path, FILE_MODE);
	}
}

/** Options for {@link loopbackOAuthCallback}. */
export interface McpLoopbackOAuthCallbackOptions {
	/**
	 * Port to bind on `127.0.0.1`. Default: `0`, an ephemeral port chosen by the OS. Pass a list to
	 * try fixed ports in order (a pre-registered client or a hosted Client ID Metadata Document
	 * lists exact `redirect_uris`); the first free one is bound.
	 */
	readonly port?: number | readonly number[];
	/** Path the authorization server redirects back to. Default: `"/callback"`. */
	readonly path?: string;
	/**
	 * Host name written into `redirectUrl`. The endpoint always binds the loopback IP literal
	 * (RFC 8252 §8.3); `"localhost"` only changes the string some pre-registered clients require.
	 * Default: `"127.0.0.1"`.
	 */
	readonly hostname?: "127.0.0.1" | "localhost";
	/** How long {@link McpLoopbackOAuthCallback.waitForCallback} waits. Default: 5 minutes. */
	readonly timeoutMs?: number;
}

/** A listening loopback redirect endpoint. Close it when the authorization attempt is over. */
export interface McpLoopbackOAuthCallback extends AsyncDisposable {
	/** The bound `redirect_uri`, including the real port. Pass it to the OAuth provider. */
	readonly redirectUrl: URL;
	/** The most recent URL handed to {@link onRedirect}, or `undefined` before the redirect. */
	readonly authorizationUrl: URL | undefined;
	/**
	 * Records the authorization URL. Suitable as an `McpOAuthClientProvider` `onRedirect`;
	 * opening a browser stays the caller's job.
	 */
	onRedirect(url: URL): void;
	/**
	 * Resolves with the full callback query — `code` plus the RFC 9207 `iss` when present — for
	 * `transport.finishAuth(params)`. Rejects when the authorization server returns `error`, when
	 * the wait times out, or when {@link close} is called first.
	 */
	waitForCallback(): Promise<URLSearchParams>;
	/** Stops the endpoint. Idempotent; safe to call after the callback already arrived. */
	close(): Promise<void>;
}

const CALLBACK_PAGE_HEADERS = {
	"content-type": "text/html; charset=utf-8",
	connection: "close",
} as const;

/**
 * Starts a loopback HTTP endpoint on `127.0.0.1` for the OAuth redirect leg.
 *
 * The server is listening before this function resolves, so `redirectUrl` already carries the real
 * port and can be registered during Dynamic Client Registration. The endpoint stops itself after
 * the first callback, the timeout, or {@link McpLoopbackOAuthCallback.close}.
 */
export async function loopbackOAuthCallback(
	options: McpLoopbackOAuthCallbackOptions = {},
): Promise<McpLoopbackOAuthCallback> {
	const path = options.path ?? "/callback";
	if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			"The OAuth callback path must be an absolute path with no query or fragment.",
		);
	}
	const timeoutMs = options.timeoutMs ?? 300_000;

	let settle: ((params: URLSearchParams) => void) | undefined;
	let fail: ((error: unknown) => void) | undefined;
	const pending = new Promise<URLSearchParams>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	// Observed only by waitForCallback(); pre-empt an unhandled rejection if nobody ever waits.
	pending.catch(() => undefined);

	let authorizationUrl: URL | undefined;
	let closing: Promise<void> | undefined;

	const server = createServer((request, response) => {
		handleCallback(request, response, path, {
			resolve: (params) => {
				settle?.(params);
				void close();
			},
			reject: (error) => {
				fail?.(error);
				void close();
			},
		});
	});

	const timer = setTimeout(() => {
		fail?.(
			new KmcpError(
				KMCP_ERROR_CODES.HANDLER_TIMEOUT,
				`No OAuth callback arrived on ${path} within ${timeoutMs}ms.`,
			),
		);
		void close();
	}, timeoutMs);
	// The listening server keeps the loop alive while waiting; the timer must not extend it.
	timer.unref();

	function close(): Promise<void> {
		closing ??= (async () => {
			clearTimeout(timer);
			// A no-op once the callback resolved; it only matters when close() wins the race.
			fail?.(
				new KmcpError(
					KMCP_ERROR_CODES.OPERATION_FAILED,
					"The loopback OAuth callback endpoint was closed before a callback arrived.",
				),
			);
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
		})();
		return closing;
	}

	const ports = typeof options.port === "number" ? [options.port] : [...(options.port ?? [0])];
	if (ports.length === 0) {
		clearTimeout(timer);
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			"loopbackOAuthCallback needs at least one port to try.",
		);
	}
	let bound = false;
	let lastError: unknown;
	for (const port of ports) {
		try {
			await listen(server, port);
			bound = true;
			break;
		} catch (error) {
			lastError = error;
		}
	}
	if (!bound) {
		clearTimeout(timer);
		throw new KmcpError(
			KMCP_ERROR_CODES.OPERATION_FAILED,
			`None of the loopback OAuth callback ports could be bound (${ports.join(", ")}).`,
			{ cause: lastError },
		);
	}

	const address = server.address();
	if (address === null || typeof address === "string") {
		await close();
		throw new KmcpError(
			KMCP_ERROR_CODES.OPERATION_FAILED,
			"The loopback OAuth callback server did not bind a TCP port.",
		);
	}
	const redirectUrl = new URL(`http://${options.hostname ?? "127.0.0.1"}:${address.port}${path}`);

	return Object.freeze({
		redirectUrl,
		get authorizationUrl(): URL | undefined {
			return authorizationUrl;
		},
		onRedirect(url: URL): void {
			authorizationUrl = url;
		},
		waitForCallback(): Promise<URLSearchParams> {
			return pending;
		},
		close,
		[Symbol.asyncDispose]: close,
	});
}

function listen(server: Server, port: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onError = (error: unknown): void => reject(error);
		server.once("error", onError);
		server.listen(port, "127.0.0.1", () => {
			server.removeListener("error", onError);
			resolve();
		});
	});
}

function handleCallback(
	request: IncomingMessage,
	response: ServerResponse,
	path: string,
	settlers: { resolve(params: URLSearchParams): void; reject(error: unknown): void },
): void {
	// Only loopback names may address this endpoint (DNS-rebinding defense).
	const host = (request.headers.host ?? "").split(":")[0] ?? "";
	if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
		respond(response, 403, "Forbidden", "This endpoint only accepts loopback requests.");
		return;
	}
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	if (url.pathname !== path) {
		respond(response, 404, "Not found", "This is not the OAuth callback endpoint.");
		return;
	}

	const error = url.searchParams.get("error");
	if (error !== null) {
		// `error_description` is authorization-server text. It reaches the host application as
		// diagnostic detail only; nothing here reads it to make a decision.
		const description = url.searchParams.get("error_description") ?? error;
		respond(response, 200, "Authorization denied", "You may close this tab.", () => {
			settlers.reject(
				new KmcpError(
					KMCP_ERROR_CODES.AUTH_FORBIDDEN,
					`OAuth authorization was denied: ${description}`,
				),
			);
		});
		return;
	}

	if (url.searchParams.get("code") === null) {
		respond(response, 400, "Missing authorization code", "This request carried no code parameter.");
		return;
	}

	const params = url.searchParams;
	respond(response, 200, "Authorization complete", "You may close this tab.", () => {
		settlers.resolve(params);
	});
}

/**
 * Writes the browser-facing page and only then settles, because settling stops the server: the
 * response must reach the socket before the connection is torn down.
 */
function respond(
	response: ServerResponse,
	status: number,
	title: string,
	body: string,
	settle?: () => void,
): void {
	response.writeHead(status, CALLBACK_PAGE_HEADERS);
	response.end(page(title, body), () => settle?.());
}

function page(title: string, body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
}

/** The launcher invocation {@link openBrowser} runs: never a shell. */
export interface McpBrowserOpenCommand {
	readonly command: string;
	readonly args: readonly string[];
}

/**
 * The platform command that opens `url` in the default browser. Exported so hosts can inspect or
 * run it themselves. Two invariants hold because the URL comes from the authorization server:
 * only `http:` and `https:` are accepted (a `javascript:`, `file:`, or custom scheme never reaches
 * the OS URL handler), and no command interpreter is involved — on Windows `rundll32
 * url.dll,FileProtocolHandler` hands the URL straight to the shell-execute API, whereas
 * `cmd /c start` would interpret `&`, `|`, `^`, and `%VAR%` inside a URL.
 */
export function browserOpenCommand(
	url: URL,
	platform: NodeJS.Platform = process.platform,
): McpBrowserOpenCommand {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new KmcpError(
			KMCP_ERROR_CODES.AUTH_FORBIDDEN,
			`Refusing to open a '${url.protocol}' URL; only http: and https: authorization URLs are opened.`,
		);
	}
	// WHATWG serialization percent-encodes whitespace and quotes: one unambiguous argument.
	const target = url.href;
	if (platform === "darwin")
		return Object.freeze({ command: "open", args: Object.freeze([target]) });
	if (platform === "win32") {
		return Object.freeze({
			command: "rundll32",
			args: Object.freeze(["url.dll,FileProtocolHandler", target]),
		});
	}
	return Object.freeze({ command: "xdg-open", args: Object.freeze([target]) });
}

/**
 * Opens an authorization URL in the user's default browser, when the host decides to. Resolves
 * `true` when the launcher ran, `false` when it could not (no browser, headless host): the caller
 * then shows the URL for manual use. Throws only for a non-`http(s)` URL, which is a bad
 * authorization server rather than a missing browser. kmcp never calls this on its own.
 */
export function openBrowser(url: URL): Promise<boolean> {
	const { command, args } = browserOpenCommand(url);
	return new Promise((resolve) => {
		execFile(command, [...args], { windowsHide: true }, (error) => resolve(error === null));
	});
}
