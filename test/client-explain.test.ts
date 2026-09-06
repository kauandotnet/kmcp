import assert from "node:assert/strict";
import test from "node:test";

import {
	InsufficientScopeError,
	RegistrationRejectedError,
	SdkError,
	SdkErrorCode,
	SdkHttpError,
	UnauthorizedError,
} from "@modelcontextprotocol/client";

import {
	KMCP_ERROR_CODES,
	KmcpError,
	McpConnectionManager,
	defineConnection,
	defineServer,
	describeError,
	explainConnectionError,
	inProcessConnection,
	type McpConnectionSnapshot,
} from "../src/index.ts";

/** A Node system error as a transport raises it (a plain `Error` carrying `code`/`syscall`). */
function systemError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
	return Object.assign(new Error(message), { code, ...extra });
}

/** The snapshot shape `explainConnectionError` reads: an id, a phase and the recorded failure. */
function snapshotWith(
	fields: Partial<McpConnectionSnapshot> & Pick<McpConnectionSnapshot, "errorDetail">,
): McpConnectionSnapshot {
	return {
		id: "s",
		label: "s",
		tags: {},
		phase: "failed",
		generation: 1,
		lastTransitionAt: new Date(0).toISOString(),
		...fields,
	};
}

test("network codes name what a user can actually check", () => {
	const refused = explainConnectionError(systemError("ECONNREFUSED", "connect ECONNREFUSED"));
	assert.equal(refused.kind, "network");
	assert.equal(refused.code, "ECONNREFUSED");
	assert.match(refused.message, /not reachable/);
	assert.ok(refused.remediation);

	const dns = explainConnectionError(
		systemError("ENOTFOUND", "getaddrinfo ENOTFOUND nope.invalid"),
	);
	assert.equal(dns.kind, "network");
	assert.match(dns.message, /host name could not be resolved/);

	const timeout = explainConnectionError(systemError("ETIMEDOUT", "timed out"));
	assert.equal(timeout.kind, "network");
	assert.match(timeout.message, /did not answer in time/);

	const reset = explainConnectionError(systemError("ECONNRESET", "socket hang up"));
	assert.equal(reset.kind, "network");
	assert.match(reset.message, /dropped/);
});

test("TLS failures are their own kind with a trust-store remedy", () => {
	for (const code of ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED"]) {
		const explained = explainConnectionError(systemError(code, "tls failed"));
		assert.equal(explained.kind, "tls", code);
		assert.equal(explained.code, code);
		assert.match(explained.remediation ?? "", /trust store/);
	}
});

test("HTTP statuses split into authorization, session, transport, rate limit and server", () => {
	const http = (status: number) =>
		explainConnectionError(
			new SdkHttpError(SdkErrorCode.ClientHttpUnexpectedContent, "boom", { status }),
		);

	assert.equal(http(401).kind, "authorization");
	assert.equal(http(401).httpStatus, 401);
	assert.equal(http(403).kind, "authorization");
	assert.match(http(403).message, /not allowed here/);

	// Without a session, a 404 is a wrong URL rather than an expired session.
	const notFound = http(404);
	assert.equal(notFound.kind, "http");
	assert.match(notFound.message, /no MCP endpoint at this URL/);

	assert.equal(http(405).kind, "transport");
	assert.match(http(405).message, /not an MCP endpoint/);
	assert.equal(http(406).kind, "transport");

	const limited = http(429);
	assert.equal(limited.kind, "rate-limited");
	assert.match(limited.remediation ?? "", /Back off/);

	const failing = http(503);
	assert.equal(failing.kind, "server");
	assert.equal(failing.httpStatus, 503);
});

test("a 404 on a connection that held a session is an expired session", () => {
	const explained = explainConnectionError(
		snapshotWith({
			errorDetail: { kind: "http", code: 404, httpStatus: 404 },
			sessionId: "abc",
			connectionMode: "stateful",
		}),
	);
	assert.equal(explained.kind, "session");
	assert.match(explained.message, /no longer knows this session/);
	assert.match(explained.remediation ?? "", /resume record/);
});

test("405 suggests the other HTTP transport for the one that failed", () => {
	const streamable = explainConnectionError(
		snapshotWith({
			errorDetail: { kind: "http", code: 405, httpStatus: 405 },
			transportKind: "streamable-http",
		}),
	);
	assert.match(streamable.remediation ?? "", /sseConnection/);
	const sse = explainConnectionError(
		snapshotWith({
			errorDetail: { kind: "http", code: 405, httpStatus: 405 },
			transportKind: "sse",
		}),
	);
	assert.match(sse.remediation ?? "", /httpConnection/);
});

test("a revision mismatch suggests pinning protocolVersion", () => {
	const negotiation = explainConnectionError(
		new SdkError(SdkErrorCode.EraNegotiationFailed, "no mutual version"),
	);
	assert.equal(negotiation.kind, "protocol");
	assert.equal(negotiation.code, "ERA_NEGOTIATION_FAILED");
	assert.match(negotiation.remediation ?? "", /protocolVersion/);

	const unsupported = explainConnectionError(
		snapshotWith({ errorDetail: { kind: "protocol", code: "unsupported_protocol_version" } }),
	);
	assert.equal(unsupported.kind, "protocol");
	assert.match(unsupported.remediation ?? "", /protocolVersion/);
});

test("stdio failures separate a missing command from a process that exited", () => {
	const missing = explainConnectionError(
		systemError("ENOENT", "spawn some-server ENOENT", { syscall: "spawn some-server" }),
	);
	assert.equal(missing.kind, "stdio");
	assert.equal(missing.code, "ENOENT");
	assert.match(missing.message, /command was not found/);
	assert.match(missing.remediation ?? "", /PATH/);
	assert.match(missing.remediation ?? "", /resolveExecutable/);

	const denied = explainConnectionError(
		systemError("EACCES", "spawn EACCES", { syscall: "spawn some-server" }),
	);
	assert.equal(denied.kind, "stdio");
	assert.match(denied.message, /not executable/);

	const exited = explainConnectionError(
		Object.assign(new Error("child exited"), { exitCode: 127 }),
	);
	assert.equal(exited.kind, "stdio");
	assert.match(exited.message, /exited with code 127/);

	const reported = explainConnectionError(new Error("the server process exited with code 2"));
	assert.equal(reported.kind, "stdio");
	assert.match(reported.message, /exited with code 2/);
});

test("OAuth failures are delegated to explainOAuthError", () => {
	const scope = explainConnectionError(new InsufficientScopeError({ requiredScope: "files:read" }));
	assert.equal(scope.kind, "oauth");
	assert.match(scope.message, /scope/);
	assert.match(scope.remediation ?? "", /Authorize again/);

	const rejected = explainConnectionError(
		new RegistrationRejectedError({
			status: 403,
			body: "{}",
			submittedMetadata: { redirect_uris: ["https://app.example/cb"] },
		}),
	);
	assert.equal(rejected.kind, "oauth");
	assert.equal(rejected.httpStatus, 403);
	assert.match(rejected.remediation ?? "", /clientId/);

	// A wrapped error still classifies: the manager's connect failure carries the cause.
	const wrapped = explainConnectionError(
		new KmcpError(KMCP_ERROR_CODES.CONNECTION_CONNECT_FAILED, "Failed to connect 'x'.", {
			cause: new UnauthorizedError("needs auth"),
		}),
	);
	assert.equal(wrapped.kind, "oauth");
});

test("an OAuth snapshot without the original error still names the round", () => {
	const unauthorized = explainConnectionError(
		snapshotWith({ errorDetail: { kind: "oauth", code: "unauthorized" } }),
	);
	assert.equal(unauthorized.kind, "authorization");
	assert.match(unauthorized.remediation ?? "", /Authorize/);

	const scope = explainConnectionError(
		snapshotWith({ errorDetail: { kind: "oauth", code: "insufficient_scope" } }),
	);
	assert.equal(scope.kind, "authorization");
	assert.match(scope.message, /scope/);

	const other = explainConnectionError(
		snapshotWith({ errorDetail: { kind: "oauth", code: "invalid_grant" } }),
	);
	assert.equal(other.kind, "oauth");
	assert.equal(other.code, "invalid_grant");
});

test("kmcp codes each get their own explanation", () => {
	const cases: readonly [string, string][] = [
		[KMCP_ERROR_CODES.CONNECTION_AUTHORIZING, "authorization"],
		[KMCP_ERROR_CODES.CONNECTION_SESSION_EXPIRED, "session"],
		[KMCP_ERROR_CODES.CONNECTION_KEEPALIVE_FAILED, "keepalive"],
		[KMCP_ERROR_CODES.TASKS_UNAVAILABLE, "capability"],
		[KMCP_ERROR_CODES.TOOL_CONTRACT_MISMATCH, "contract"],
		[KMCP_ERROR_CODES.CATALOG_STALE, "stale"],
		[KMCP_ERROR_CODES.CONNECTION_GENERATION_STALE, "stale"],
		[KMCP_ERROR_CODES.CONNECTION_QUARANTINED, "transport"],
	];
	for (const [code, kind] of cases) {
		const explained = explainConnectionError(
			new KmcpError(code as (typeof KMCP_ERROR_CODES)["CATALOG_STALE"], "raised"),
		);
		assert.equal(explained.kind, kind, code);
		assert.equal(explained.code, code);
		assert.ok(explained.message.length > 0, code);
	}
});

test("the fallback never echoes unbounded or control-laden server text", () => {
	const hostile = new Error(`\u001B[2Jcleared${"!".repeat(1000)}`);
	const explained = explainConnectionError(hostile);
	assert.equal(explained.kind, "unknown");
	assert.equal(explained.code, "Error");
	assert.match(explained.message, /could not classify/);
	const excerpt = explained.remediation ?? "";
	assert.ok(excerpt.length < 300, `the excerpt stayed bounded (${excerpt.length})`);
	assert.ok(!/[\u0000-\u001F\u007F-\u009F]/.test(excerpt), "no control characters survive");
	assert.match(excerpt, /cleared/);
});

test("a snapshot with no recorded failure explains itself as such", () => {
	const explained = explainConnectionError({
		id: "s",
		label: "s",
		tags: {},
		phase: "online",
		generation: 2,
		lastTransitionAt: new Date(0).toISOString(),
	} satisfies McpConnectionSnapshot);
	assert.equal(explained.kind, "unknown");
	assert.match(explained.message, /No failure is recorded/);
});

test("an errorDetail from describeError explains the same as the error it came from", () => {
	const error = systemError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:1");
	const fromError = explainConnectionError(error);
	const fromDetail = explainConnectionError(describeError(error));
	assert.deepEqual(fromDetail, fromError);
});

test("a real failed connection's snapshot explains why it is down", async (t) => {
	const manager = new McpConnectionManager<"down">();
	t.after(() => manager.close().catch(() => undefined));
	manager.register(
		defineConnection({
			id: "down",
			transport: () => {
				throw systemError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:9");
			},
			protocolVersion: "2025-11-25",
		}),
	);
	await assert.rejects(manager.connect("down"));
	const explained = explainConnectionError(manager.state("down"));
	assert.equal(explained.kind, "network");
	assert.equal(explained.code, "ECONNREFUSED");
	assert.match(explained.message, /not reachable/);
});

test("a healthy connection's snapshot explains itself as having no failure", async (t) => {
	const manager = new McpConnectionManager<"live">();
	t.after(() => manager.close().catch(() => undefined));
	manager.register(
		inProcessConnection({ id: "live", definition: defineServer({ name: "s", version: "1" }) }),
	);
	const snapshot = await manager.connect("live");
	const explained = explainConnectionError(snapshot);
	assert.equal(explained.kind, "unknown");
	assert.match(explained.message, /No failure is recorded/);
});
