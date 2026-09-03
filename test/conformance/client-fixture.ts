/**
 * Conformance adapter — drives `kmcp/client` from the official `@modelcontextprotocol/conformance`
 * suite's client scenarios. The framework runs this file with the scenario's server URL as the
 * last argument, `MCP_CONFORMANCE_SCENARIO` naming the scenario and `MCP_CONFORMANCE_CONTEXT`
 * carrying scenario data (credentials, keys, IdP details) as JSON.
 *
 * Run one scenario straight from source (no build step):
 *   npx -y @modelcontextprotocol/conformance@0.1.16 client \
 *     --command "node --experimental-strip-types test/conformance/client-fixture.ts" \
 *     --scenario auth/scope-step-up --timeout 60000
 *
 * The interactive OAuth scenarios are completed here without a browser: the scenario's
 * authorization server answers `/authorize` with a redirect carrying the code, so the adapter
 * fetches the authorization URL kmcp handed to the provider with `redirect: "manual"` and feeds
 * the `Location` query to `completeAuthorization` — the connect-time (`authorizing`) and the
 * mid-session (403 step-up) variants alike. `scripts/conformance-client.mjs` runs every scenario.
 */
import { UnauthorizedError } from "@modelcontextprotocol/client";

import {
	KMCP_ERROR_CODES,
	KmcpError,
	McpConnectionManager,
	McpOAuthClientProvider,
	clientCredentialsAuth,
	describeError,
	enterpriseManagedAuth,
	explainOAuthError,
	httpConnection,
	type McpHttpAuth,
} from "../../src/index.ts";

const scenario = process.env["MCP_CONFORMANCE_SCENARIO"] ?? "";
const serverUrl = process.argv.at(-1) ?? "";
const context = parseContext(process.env["MCP_CONFORMANCE_CONTEXT"]);
const REDIRECT_URL = "http://127.0.0.1:53017/callback";
const CIMD_URL = "https://conformance-test.local/client-metadata.json";
const MAX_AUTHORIZATION_ROUNDS = 3;

if (scenario.length === 0 || !/^https?:\/\//.test(serverUrl)) {
	console.error("usage: MCP_CONFORMANCE_SCENARIO=<name> client-fixture.ts <server-url>");
	process.exit(2);
}

let pendingAuthorization: URL | undefined;
const manager = new McpConnectionManager<"c">();

function parseContext(raw: string | undefined): Record<string, unknown> {
	if (raw === undefined || raw.length === 0) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function requireContext(field: string): string {
	const value = context[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`scenario ${scenario} did not provide '${field}' in MCP_CONFORMANCE_CONTEXT`);
	}
	return value;
}

function optionalContext(field: string): string | undefined {
	const value = context[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The credential for the scenario: pre-registered, CIMD, client credentials, cross-app, or DCR. */
function buildAuth(): McpHttpAuth | undefined {
	if (!scenario.startsWith("auth/")) return undefined;
	if (scenario === "auth/client-credentials-basic") {
		return clientCredentialsAuth({
			clientId: requireContext("client_id"),
			clientSecret: requireContext("client_secret"),
			clientName: "kmcp-conformance",
		});
	}
	if (scenario === "auth/client-credentials-jwt") {
		return clientCredentialsAuth({
			clientId: requireContext("client_id"),
			privateKey: requireContext("private_key_pem"),
			algorithm: optionalContext("signing_algorithm") ?? "RS256",
			clientName: "kmcp-conformance",
		});
	}
	if (scenario === "auth/cross-app-access-complete-flow") {
		const issuer = optionalContext("idp_issuer");
		const tokenEndpoint = optionalContext("idp_token_endpoint");
		return enterpriseManagedAuth({
			idp: {
				...(issuer === undefined ? {} : { issuer }),
				...(tokenEndpoint === undefined ? {} : { tokenEndpoint }),
				clientId: requireContext("idp_client_id"),
				tokens: { idToken: requireContext("idp_id_token") },
			},
			client: {
				clientId: requireContext("client_id"),
				clientSecret: requireContext("client_secret"),
				clientName: "kmcp-conformance",
			},
		});
	}
	const clientId = optionalContext("client_id");
	const clientSecret = optionalContext("client_secret");
	return new McpOAuthClientProvider({
		serverUrl,
		redirectUrl: REDIRECT_URL,
		clientName: "kmcp-conformance",
		...(clientId === undefined ? {} : { clientId }),
		...(clientSecret === undefined ? {} : { clientSecret }),
		...(scenario === "auth/basic-cimd" ? { clientMetadataUrl: CIMD_URL } : {}),
		onRedirect: (url) => {
			pendingAuthorization = url;
		},
	});
}

/** Follows the authorization URL to the scenario's redirect and completes the round on the manager. */
async function completeRedirect(): Promise<void> {
	const url = pendingAuthorization;
	if (url === undefined) throw new Error("the provider was never handed an authorization URL");
	pendingAuthorization = undefined;
	const response = await fetch(url, { redirect: "manual" });
	const location = response.headers.get("location");
	if (location === null) {
		throw new Error(`the authorization endpoint answered ${response.status} without a redirect`);
	}
	await manager.completeAuthorization("c", new URL(location, url).searchParams);
}

/** Connects, completing the authorization round whenever the manager parks the connection. */
async function connect(): Promise<void> {
	for (let round = 0; ; round += 1) {
		try {
			await manager.connect("c");
			return;
		} catch (error) {
			const parked =
				error instanceof KmcpError && error.code === KMCP_ERROR_CODES.CONNECTION_AUTHORIZING;
			if (!parked || round >= MAX_AUTHORIZATION_ROUNDS) throw error;
			await completeRedirect();
		}
	}
}

/** Runs an operation, completing a mid-session (step-up) authorization round when one is raised. */
async function withStepUp<Result>(operation: () => Promise<Result>): Promise<Result> {
	for (let round = 0; ; round += 1) {
		try {
			return await operation();
		} catch (error) {
			const unauthorized = causeChain(error).some((cause) => cause instanceof UnauthorizedError);
			if (
				!unauthorized ||
				pendingAuthorization === undefined ||
				round >= MAX_AUTHORIZATION_ROUNDS
			) {
				throw error;
			}
			await completeRedirect();
		}
	}
}

function causeChain(error: unknown): unknown[] {
	const chain: unknown[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
		chain.push(current);
		current = current instanceof Error ? current.cause : undefined;
	}
	return chain;
}

/** Best-effort: the scenario servers implement only what they test; other methods may 404 or -32601. */
async function tolerate(label: string, operation: () => Promise<unknown>): Promise<void> {
	try {
		await operation();
	} catch (error) {
		console.error(
			`[tolerated] ${label}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

type ElicitationValue = string | number | boolean | string[];

/** SEP-1034: accept an elicitation with every omitted field set to its schema default. */
function elicitationDefaults(schema: unknown): Record<string, ElicitationValue> {
	const properties = (schema as { properties?: Record<string, { default?: unknown }> } | undefined)
		?.properties;
	const content: Record<string, ElicitationValue> = {};
	for (const [name, property] of Object.entries(properties ?? {})) {
		if (property === null || typeof property !== "object" || !("default" in property)) continue;
		const value = property.default;
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean" ||
			(Array.isArray(value) && value.every((item) => typeof item === "string"))
		) {
			content[name] = value as ElicitationValue;
		}
	}
	return content;
}

/**
 * Lists tools and calls one: `add_numbers` with numeric arguments when the server has it, else the
 * first tool listed (the step-up scenarios guard `tools/call` with a wider scope than the rest).
 */
async function exerciseTools(): Promise<void> {
	const listed = await withStepUp(() => manager.listTools("c"));
	const first = listed.tools[0];
	if (listed.tools.some((tool) => tool.name === "add_numbers")) {
		await withStepUp(() => manager.callTool("c", "add_numbers", { a: 2, b: 3 }));
	} else if (first !== undefined) {
		await withStepUp(() => manager.callTool("c", first.name, {}));
	}
	await withStepUp(() => manager.ping("c"));
}

const runs: Record<string, () => Promise<void>> = {
	initialize: async () => {
		await connect();
		await manager.ping("c");
		// The scenario server advertises no capabilities at all; kmcp enforces capabilities
		// strictly, so the list verbs are refused locally (fail-closed) rather than sent.
		await tolerate("tools/list", () => manager.listTools("c"));
		await tolerate("logging/setLevel", () => manager.setLogLevel("c", "info"));
		await tolerate("resources/list", () => manager.listResources("c"));
		await tolerate("resources/templates/list", () => manager.listResourceTemplates("c"));
		await tolerate("prompts/list", () => manager.listPrompts("c"));
	},
	tools_call: async () => {
		await connect();
		await manager.listTools("c");
		await manager.callTool("c", "add_numbers", { a: 2, b: 3 });
		await manager.callTool("c", "add_numbers", { a: 10, b: 32 });
		await manager.ping("c");
	},
	"sse-retry": async () => {
		// The server closes the SSE stream mid call and expects a GET reconnect within its
		// advertised `retry`; the server-side checks are decided as soon as that happens.
		await connect();
		await manager.listTools("c");
		await tolerate("tools/call test_reconnection", () =>
			manager.callTool("c", "test_reconnection", {}, { timeout: 20_000 }),
		);
	},
	"elicitation-sep1034-client-defaults": async () => {
		await connect();
		await manager.callTool("c", "test_client_elicitation_defaults", {});
	},
};

async function runAuthScenario(): Promise<void> {
	await connect();
	await exerciseTools();
}

const manageableFailures = new Set(["auth/scope-retry-limit", "auth/resource-mismatch"]);

async function main(): Promise<void> {
	const auth = buildAuth();
	const elicitation = scenario === "elicitation-sep1034-client-defaults";
	// The 2025-03-26 backcompat servers publish authorization-server metadata whose `issuer`
	// names a path the document is not served under; that revision predates the RFC 8414 §3.3
	// issuer-echo check the SDK enforces by default. The SDK's documented, security-weakening
	// opt-out is the only way to talk to such servers, so the adapter enables it there and
	// nowhere else.
	const legacyMetadata = scenario.startsWith("auth/2025-03-26-");
	manager.register(
		httpConnection({
			id: "c",
			url: serverUrl,
			clientInfo: { name: "kmcp-conformance", version: "0.0.0" },
			defaults: { timeoutMs: 20_000 },
			...(legacyMetadata ? { transportOptions: { skipIssuerMetadataValidation: true } } : {}),
			...(auth === undefined ? {} : { auth }),
			...(elicitation
				? {
						requestHandlers: {
							"elicitation/create": async (request) => ({
								action: "accept" as const,
								content: elicitationDefaults(
									"requestedSchema" in request.params ? request.params.requestedSchema : undefined,
								),
							}),
						},
						inputRequired: { maxRounds: 3 },
					}
				: {}),
		}),
	);
	const run = runs[scenario] ?? (scenario.startsWith("auth/") ? runAuthScenario : undefined);
	if (run === undefined) {
		console.error(`scenario not implemented by the kmcp conformance adapter: ${scenario}`);
		process.exit(1);
	}
	try {
		await run();
	} catch (error) {
		if (!manageableFailures.has(scenario)) throw error;
		// These scenarios END in a refusal by design (the client must give up); the checks the
		// server recorded on the way are the verdict, not the final error.
		console.error(`[expected end] ${error instanceof Error ? error.message : String(error)}`);
	}
}

try {
	await main();
} catch (error) {
	for (const [depth, cause] of causeChain(error).entries()) {
		const name = cause instanceof Error ? cause.name : typeof cause;
		const message = cause instanceof Error ? cause.message : String(cause);
		console.error(`${"  ".repeat(depth)}${depth === 0 ? "" : "caused by "}${name}: ${message}`);
	}
	console.error(`classification: ${JSON.stringify(describeError(error))}`);
	console.error(`oauth: ${JSON.stringify(explainOAuthError(error))}`);
	process.exitCode = 1;
} finally {
	await manager.close().catch(() => undefined);
}
