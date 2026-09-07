import { KMCP_ERROR_CODES } from "../errors.ts";
import { describeError, type McpConnectionSnapshot, type McpErrorDetail } from "./manager.ts";
import { explainOAuthError } from "./oauth-flows.ts";

/**
 * The families a connection failure falls into, chosen so a host can branch on one value: each
 * kind names the LAYER that failed, not the error class that carried it.
 */
export type McpConnectionErrorKind =
	| "authorization"
	| "capability"
	| "contract"
	| "http"
	| "keepalive"
	| "network"
	| "oauth"
	| "protocol"
	| "rate-limited"
	| "server"
	| "session"
	| "stale"
	| "stdio"
	| "tls"
	| "transport"
	| "unknown";

/** A stable, non-secret explanation of a connection failure, suitable for showing to a user. */
export interface McpConnectionExplanation {
	readonly kind: McpConnectionErrorKind;
	/** One sentence describing what went wrong. Never carries credentials, headers or bodies. */
	readonly message: string;
	/** What the user or host can do about it, when the failure has a known remedy. */
	readonly remediation?: string;
	/** The underlying stable code (`ECONNREFUSED`, `ERA_NEGOTIATION_FAILED`, a kmcp code, ...). */
	readonly code?: string;
	readonly httpStatus?: number;
}

/** What a snapshot adds beyond the classified error: it says which wire the failure happened on. */
interface ExplainContext {
	/** Whether the connection was carrying server-side session state when it failed. */
	readonly stateful: boolean;
	readonly transportKind?: McpConnectionSnapshot["transportKind"];
}

const MAX_EXCERPT_LENGTH = 200;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]+/g;

const TLS_CODE =
	/^(CERT_[A-Z_]+|ERR_TLS_[A-Z_]+|ERR_SSL_[A-Z_]+|UNABLE_TO_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|EPROTO)$/;

const CHECK_URL =
	"Check the server's URL and that it is running; a host name or port typo looks exactly like this.";
const PATH_REMEDY =
	"Check the command exists and is on this process's PATH — resolveExecutable(command) answers that without spawning anything — or give an absolute path.";

/**
 * Explains a connection failure in stable, host-facing terms, from either the error itself or a
 * connection snapshot (its `errorDetail`, plus the transport and session context only the snapshot
 * knows). OAuth failures are delegated to {@link explainOAuthError}, so a host renders one shape
 * for every reason a connection can be down.
 *
 * Nothing an upstream controls is echoed beyond a bounded, control-character-stripped excerpt on
 * the generic fallback: an explanation is safe to put in a UI verbatim.
 */
export function explainConnectionError(input: unknown): McpConnectionExplanation {
	const snapshot = asSnapshot(input);
	if (snapshot !== undefined) return explainSnapshot(snapshot);
	const detail = asErrorDetail(input);
	if (detail !== undefined) return classify(detail, undefined, undefined);
	return classify(describeError(input), input, undefined);
}

function explainSnapshot(snapshot: McpConnectionSnapshot): McpConnectionExplanation {
	const context: ExplainContext = {
		stateful: snapshot.sessionId !== undefined || snapshot.connectionMode === "stateful",
		...(snapshot.transportKind === undefined ? {} : { transportKind: snapshot.transportKind }),
	};
	const detail = snapshot.errorDetail;
	if (detail !== undefined) return classify(detail, undefined, context);
	if (snapshot.errorCode !== undefined) {
		return classify({ kind: "kmcp", code: snapshot.errorCode }, undefined, context);
	}
	return frozen({
		kind: "unknown",
		message: "No failure is recorded for this connection.",
	});
}

function classify(
	detail: McpErrorDetail,
	error: unknown,
	context: ExplainContext | undefined,
): McpConnectionExplanation {
	// A spawn that never started is reported as a plain system error; it is a stdio story, not a
	// network one, so it is recognized before the transport-code table below.
	const stdio = explainStdio(detail, error);
	if (stdio !== undefined) return stdio;
	switch (detail.kind) {
		case "oauth":
			return explainOAuth(detail, error);
		case "network":
			return explainNetwork(detail);
		case "http":
			return explainHttp(detail, context);
		case "protocol":
		case "sdk":
			return explainProtocol(detail, error);
		case "kmcp":
			return explainKmcp(detail, error);
		default:
			return fallback(detail, error);
	}
}

/**
 * A rejected credential is an `authorization` story on BOTH paths. `explainConnectionError` is
 * called with a live error one moment and with the snapshot that recorded it the next, and a host
 * branching on `kind` must not see the same failure land in two different families — so these two
 * are answered from the code `describeError` records, before the live error is consulted at all.
 */
const UNAUTHORIZED: McpConnectionExplanation = Object.freeze({
	kind: "authorization",
	code: "unauthorized",
	message: "The server requires authorization and the current credentials were not accepted.",
	remediation: "Authorize this connection again to obtain fresh tokens.",
});

const INSUFFICIENT_SCOPE: McpConnectionExplanation = Object.freeze({
	kind: "authorization",
	code: "insufficient_scope",
	message: "The server requires a scope the current token does not carry.",
	remediation: "Authorize again requesting the scope the server asked for.",
});

function explainOAuth(detail: McpErrorDetail, error: unknown): McpConnectionExplanation {
	const oauth = error === undefined ? undefined : explainOAuthError(error);
	const live = oauth === undefined || oauth.kind === "unknown" ? undefined : oauth;
	// Either witness — the recorded code, or the live classification — settles these two.
	const code = String(detail.code);
	if (code === "unauthorized" || live?.kind === "unauthorized") return UNAUTHORIZED;
	if (code === "insufficient_scope" || live?.kind === "insufficient_scope") {
		return INSUFFICIENT_SCOPE;
	}
	if (live !== undefined) {
		return frozen({
			kind: "oauth",
			message: live.message,
			...(live.remediation === undefined ? {} : { remediation: live.remediation }),
			code: live.oauthCode ?? code,
			...(live.httpStatus === undefined ? {} : { httpStatus: live.httpStatus }),
		});
	}
	// The snapshot path has only the code `describeError` recorded; it still names the round.
	return frozen({
		kind: "oauth",
		code,
		message: `The OAuth round failed (${code}).`,
		...(detail.httpStatus === undefined ? {} : { httpStatus: detail.httpStatus }),
	});
}

function explainNetwork(detail: McpErrorDetail): McpConnectionExplanation {
	const code = String(detail.code);
	if (TLS_CODE.test(code)) {
		return frozen({
			kind: "tls",
			code,
			message: `The TLS handshake with the server failed (${code}).`,
			remediation:
				"The certificate is not trusted by this process. Use a certificate a public CA issued, or add the issuing CA to this process's trust store (NODE_EXTRA_CA_CERTS) — never disable verification for a remote server.",
		});
	}
	switch (code) {
		case "ECONNREFUSED":
			return frozen({
				kind: "network",
				code,
				message: "The server is not reachable: the connection was refused.",
				remediation: CHECK_URL,
			});
		case "ENOTFOUND":
		case "EAI_AGAIN":
			return frozen({
				kind: "network",
				code,
				message: "The server's host name could not be resolved.",
				remediation: CHECK_URL,
			});
		case "ETIMEDOUT":
		case "TimeoutError":
			return frozen({
				kind: "network",
				code,
				message: "The server did not answer in time.",
				remediation:
					"The host may be behind a firewall or simply slow; retry, and raise the request timeout if the server is known to be slow to start.",
			});
		case "ECONNRESET":
		case "EPIPE":
		case "ECONNABORTED":
			return frozen({
				kind: "network",
				code,
				message: "The connection was dropped by the server or something in between.",
				remediation:
					"A proxy or load balancer often closes idle MCP streams; retry, and enable keepalive so the manager notices sooner.",
			});
		case "AbortError":
			return frozen({
				kind: "network",
				code,
				message: "The request was aborted before the server answered.",
			});
		default:
			return frozen({
				kind: "network",
				code,
				message: `The connection to the server failed at the transport level (${code}).`,
				remediation: CHECK_URL,
			});
	}
}

function explainHttp(
	detail: McpErrorDetail,
	context: ExplainContext | undefined,
): McpConnectionExplanation {
	const status = detail.httpStatus ?? (typeof detail.code === "number" ? detail.code : 0);
	const base = { code: String(status), httpStatus: status } as const;
	if (status === 401) {
		return frozen({
			...base,
			kind: "authorization",
			message: "The server rejected the request as unauthorized (HTTP 401).",
			remediation:
				"Authorize this connection (an OAuth provider on the definition's auth, or a bearer token) and connect again.",
		});
	}
	if (status === 403) {
		return frozen({
			...base,
			kind: "authorization",
			message: "The server refused the request (HTTP 403): the credentials are not allowed here.",
			remediation:
				"The token is valid but lacks permission for this resource; authorize again with the scope the server requires, or use an account that has access.",
		});
	}
	if (status === 404) {
		if (context?.stateful === true) {
			return frozen({
				...base,
				kind: "session",
				message: "The server no longer knows this session (HTTP 404); it expired or was evicted.",
				remediation:
					"Reconnect to start a new session. Persisted resume records for this connection are spent and must be discarded.",
			});
		}
		return frozen({
			...base,
			kind: "http",
			message: "The server has no MCP endpoint at this URL (HTTP 404).",
			remediation:
				"Check the path: many deployments serve MCP under a sub-path such as /mcp rather than the site root.",
		});
	}
	if (status === 405 || status === 406) {
		return frozen({
			...base,
			kind: "transport",
			message:
				status === 405
					? "The URL answered 405 Method Not Allowed: it is not an MCP endpoint for this transport."
					: "The URL answered 406 Not Acceptable: it does not speak this transport's content types.",
			remediation: otherTransportRemedy(context?.transportKind),
		});
	}
	if (status === 429) {
		return frozen({
			...base,
			kind: "rate-limited",
			message: "The server is rate limiting this client (HTTP 429).",
			remediation:
				"Back off and retry later; reconnect backoff already does this, so lower the request rate rather than reconnecting harder.",
		});
	}
	if (status >= 500) {
		return frozen({
			...base,
			kind: "server",
			message: `The server failed to handle the request (HTTP ${status}).`,
			remediation: "The fault is on the server side; retry later and check the server's own logs.",
		});
	}
	return frozen({
		...base,
		kind: "http",
		message: `The server answered HTTP ${status}.`,
	});
}

function otherTransportRemedy(kind: McpConnectionSnapshot["transportKind"]): string {
	if (kind === "streamable-http") {
		return "Try the legacy HTTP+SSE transport (sseConnection) for this URL, or point Streamable HTTP at the endpoint the server actually serves.";
	}
	if (kind === "sse") {
		return "Try Streamable HTTP (httpConnection) for this URL: modern servers no longer expose the legacy HTTP+SSE endpoint.";
	}
	return "Try the other HTTP transport for this URL (httpConnection ↔ sseConnection), or check that the URL points at the MCP endpoint rather than the site root.";
}

function explainProtocol(detail: McpErrorDetail, error: unknown): McpConnectionExplanation {
	const code = String(detail.code);
	if (code === "ERA_NEGOTIATION_FAILED" || code === "unsupported_protocol_version") {
		return frozen({
			kind: "protocol",
			code,
			message:
				"No protocol revision is shared with this server: it speaks a revision this client does not, or the negotiation probe was refused.",
			remediation:
				"Pin the revision the server actually serves with the definition's protocolVersion (a 2025 revision falls back to the initialize handshake).",
		});
	}
	if (code === "missing_required_client_capability") {
		return frozen({
			kind: "capability",
			code,
			message: "The server requires a client capability this connection does not advertise.",
			remediation:
				"Declare the capability on the definition (roots, sampling, elicitation) or supply the matching request handler.",
		});
	}
	if (code === "url_elicitation_required") {
		return frozen({
			kind: "protocol",
			code,
			message: "The server asked the user to visit a URL before it will continue.",
			remediation: "Show the elicited URL to the user and retry once they have completed it.",
		});
	}
	return frozen({
		kind: "protocol",
		code,
		message: `The MCP exchange with the server failed (${code}).`,
		...excerptOf(error),
	});
}

function explainKmcp(detail: McpErrorDetail, error: unknown): McpConnectionExplanation {
	const code = String(detail.code);
	switch (code) {
		case KMCP_ERROR_CODES.CONNECTION_AUTHORIZING:
			return frozen({
				kind: "authorization",
				code,
				message: "The connection is waiting for the user to complete an OAuth authorization.",
				remediation:
					"Open the authorization URL the provider produced and hand the callback parameters to completeAuthorization().",
			});
		case KMCP_ERROR_CODES.CONNECTION_SESSION_EXPIRED:
			return frozen({
				kind: "session",
				code,
				message: "The server declared this session gone; a new one has to be opened.",
				remediation:
					"Reconnect (the reconnect policy does this on its own) and discard any persisted resume record for this connection.",
			});
		case KMCP_ERROR_CODES.CONNECTION_KEEPALIVE_FAILED:
			return frozen({
				kind: "keepalive",
				code,
				message: "The server stopped answering keepalive probes, so the connection was failed.",
				remediation:
					"The upstream or something in between went away silently; reconnect, and raise keepalive.timeoutMs if the server is simply slow.",
			});
		case KMCP_ERROR_CODES.TASKS_UNAVAILABLE:
			return frozen({
				kind: "capability",
				code,
				message: "This server does not offer task-augmented calls on the negotiated revision.",
				remediation:
					"Call the tool directly instead; supportsToolTasks(id) says beforehand whether tasks are available.",
			});
		case KMCP_ERROR_CODES.TOOL_CONTRACT_MISMATCH:
		case KMCP_ERROR_CODES.PROMPT_CONTRACT_MISMATCH:
			return frozen({
				kind: "contract",
				code,
				message:
					"The server now advertises a shape that no longer matches the contract this call expects.",
				remediation:
					"Refresh the catalog and re-read the advertised schema; the upstream changed its tool or prompt under you.",
				...excerptOf(error),
			});
		case KMCP_ERROR_CODES.CATALOG_STALE:
			return frozen({
				kind: "stale",
				code,
				message:
					"The catalog this call was fenced against is no longer the connection's current one.",
				remediation: "Re-read the catalog from the snapshot and retry with the new fingerprint.",
			});
		case KMCP_ERROR_CODES.CONNECTION_GENERATION_STALE:
			return frozen({
				kind: "stale",
				code,
				message: "The connection was re-established since this call was fenced.",
				remediation: "Re-read the snapshot's generation and retry.",
			});
		case KMCP_ERROR_CODES.CONNECTION_QUARANTINED:
			return frozen({
				kind: "transport",
				code,
				message: "A previous cleanup failed, so this connection is quarantined and cannot be used.",
				remediation:
					"Call disconnect() to retry the cleanup; it returns the connection to offline.",
			});
		case KMCP_ERROR_CODES.RATE_LIMITED:
			return frozen({
				kind: "rate-limited",
				code,
				message: "The request was rate limited.",
				remediation: "Back off and retry later.",
			});
		default:
			return frozen({
				kind: "unknown",
				code,
				message: `The connection failed with ${code}.`,
				...excerptOf(error),
			});
	}
}

const UNCLASSIFIED_KINDS = new Set<McpErrorDetail["kind"]>(["network", "sdk", "unknown"]);

/**
 * Recognizes the two stdio failures a host has to explain differently from a network one: a
 * command that does not exist (spawn `ENOENT`) and a child that exited on its own.
 */
function explainStdio(
	detail: McpErrorDetail,
	error: unknown,
): McpConnectionExplanation | undefined {
	const syscall = propertyOf(error, "syscall");
	const spawning = typeof syscall === "string" && syscall.startsWith("spawn");
	if (String(detail.code) === "ENOENT" && (spawning || detail.kind === "network")) {
		return frozen({
			kind: "stdio",
			code: "ENOENT",
			message: "The server's command was not found, so no process could be started.",
			remediation: PATH_REMEDY,
		});
	}
	if (String(detail.code) === "EACCES" && spawning) {
		return frozen({
			kind: "stdio",
			code: "EACCES",
			message: "The server's command exists but is not executable by this process.",
			remediation: PATH_REMEDY,
		});
	}
	// Only where nothing better classified it: an HTTP or OAuth failure whose text happens to say
	// "exited with code 2" is not a child process story.
	const exitCode = UNCLASSIFIED_KINDS.has(detail.kind) ? exitCodeOf(error) : undefined;
	if (exitCode !== undefined) {
		return frozen({
			kind: "stdio",
			code: "EXIT",
			message: `The server process exited with code ${exitCode} instead of speaking MCP.`,
			remediation:
				"Run the command by hand to see what it prints; a missing dependency or a bad argument usually shows up on stderr (capture it with stderr: 'pipe').",
		});
	}
	return undefined;
}

function exitCodeOf(error: unknown): number | undefined {
	const direct = propertyOf(error, "exitCode");
	if (typeof direct === "number" && Number.isInteger(direct) && direct !== 0) return direct;
	const message = error instanceof Error ? error.message : undefined;
	const matched = message?.match(/exited with (?:code )?(\d{1,3})\b/i);
	const parsed = matched?.[1] === undefined ? Number.NaN : Number.parseInt(matched[1], 10);
	return Number.isInteger(parsed) && parsed !== 0 ? parsed : undefined;
}

function fallback(detail: McpErrorDetail, error: unknown): McpConnectionExplanation {
	return frozen({
		kind: "unknown",
		code: String(detail.code),
		message: "The connection failed for a reason kmcp could not classify.",
		...excerptOf(error),
	});
}

/**
 * The one place upstream-controlled text is allowed through, as a `remediation` excerpt: capped,
 * single-line and stripped of control characters so it can never reformat a host's terminal.
 */
function excerptOf(error: unknown): { remediation?: string } {
	if (!(error instanceof Error)) return {};
	const cleaned = error.message.replace(CONTROL_CHARACTERS, " ").trim();
	if (cleaned.length === 0) return {};
	const excerpt =
		cleaned.length > MAX_EXCERPT_LENGTH ? `${cleaned.slice(0, MAX_EXCERPT_LENGTH - 1)}…` : cleaned;
	return { remediation: `The underlying report was: ${excerpt}` };
}

const ERROR_DETAIL_KINDS = new Set<string>([
	"http",
	"kmcp",
	"network",
	"oauth",
	"protocol",
	"sdk",
	"unknown",
]);

function asSnapshot(input: unknown): McpConnectionSnapshot | undefined {
	if (typeof input !== "object" || input === null || input instanceof Error) return undefined;
	const candidate = input as Partial<McpConnectionSnapshot>;
	if (typeof candidate.id !== "string" || typeof candidate.phase !== "string") return undefined;
	return typeof candidate.generation === "number" ? (input as McpConnectionSnapshot) : undefined;
}

function asErrorDetail(input: unknown): McpErrorDetail | undefined {
	if (typeof input !== "object" || input === null || input instanceof Error) return undefined;
	const candidate = input as Partial<McpErrorDetail>;
	if (typeof candidate.kind !== "string" || !ERROR_DETAIL_KINDS.has(candidate.kind))
		return undefined;
	const code = candidate.code;
	return typeof code === "string" || typeof code === "number"
		? (input as McpErrorDetail)
		: undefined;
}

function propertyOf(value: unknown, name: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	return (value as Record<string, unknown>)[name];
}

function frozen(explanation: McpConnectionExplanation): McpConnectionExplanation {
	return Object.freeze(explanation);
}
