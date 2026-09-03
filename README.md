# `kmcp`

A standalone, framework-neutral TypeScript 7 toolkit built directly on the official Model Context
Protocol SDK v2, focused on the modern **2026-07-28** protocol revision.

The package combines three layers:

- Server authoring through classes, functions, a persistent builder, or standard decorators. Every
  style materializes the same canonical capability and server-definition classes, and every server
  is materialized fresh per request from an immutable definition.
- A framework-neutral client control-plane kernel: managed connections, partial catalog discovery,
  namespaced hubs, diagnostic snapshots, and lifecycle events.
- A gateway that serves a hub as one downstream MCP server, with live topology refresh.

Entry points: `kmcp` (everything), `kmcp/server`, `kmcp/client`, `kmcp/hub`, `kmcp/gateway`,
`kmcp/auth`, `kmcp/node`.

## Requirements

- Node.js 22.13 or newer
- TypeScript 7 for source consumers
- `@modelcontextprotocol/client` and `@modelcontextprotocol/server` v2 peers
- `@modelcontextprotocol/node` v2 only when using the `kmcp/node` entry point
- `jose` (optional peer) only when using `jwtVerifier` from `kmcp/auth`

## Protocol posture

`kmcp` pins the modern revision through its own constant: `MCP_MODERN_PROTOCOL_VERSION`
(`"2026-07-28"`). The SDK's `LATEST_PROTOCOL_VERSION` is the latest _legacy_ revision (`2025-11-25`)
and is deliberately not re-exported. Every server entry serves both eras from one definition
(`handler()` keeps the SDK default `legacy: "stateless"`); pass `{ legacy: "reject" }` for a
modern-only endpoint. The test suite runs every server test under both eras.

## Server authoring

### Functional API

```ts
import { defineServer, defineTool, fromJsonSchema, textContent, toolResult } from "kmcp/server";

const input = fromJsonSchema<{ name: string }>({
	type: "object",
	properties: { name: { type: "string" } },
	required: ["name"],
});

const greet = defineTool("greet", { inputSchema: input }, async ({ name }) =>
	toolResult(textContent(`Hello ${name}`)),
);

export const server = defineServer(
	{ name: "example", version: "1.0.0" },
	{ instructions: "Greets people.", capabilities: [greet] },
);

export const handler = server.handler();
```

`server.handler()` uses the official v2 per-request `createMcpHandler` factory: a fresh official
`McpServer` per serving unit, never a request-unsafe singleton. `kmcp/server` re-exports the curated
SDK authoring set (`fromJsonSchema`, `ResourceTemplate`, `UriTemplate`, `completable`,
`inputRequired`, `acceptedContent`, `inputResponse`, `createRequestStateCodec`, the error classes,
`isLegacyRequest`, `classifyInboundRequest`, …) so application code does not import the SDK.

Definition options: `instructions`, `logging` (off by default — deprecated by SEP-2577; needed for
`ctx.mcpReq.log`), `resourceSubscriptions` (declared automatically when resources exist so
`notify.resourceUpdated` reaches modern listeners), `setup(server, context)` (may return a cleanup
that `McpServerRuntime.close()` awaits), `onCapabilityDenied`, and the raw `sdk` bag (shallow-copied
and frozen). Capability kinds are pre-declared, so a principal authorized to nothing gets empty
lists instead of `-32601`.

Hot-swappable definitions: every serving entry accepts
`McpServerSource = definition | () => definition`; publish a new frozen definition and call
`handler.notify.toolsChanged()`.

### Results and context helpers

`textContent`, `imageContent`, `audioContent`, `resourceLink`, `embeddedTextResource`,
`embeddedBlobResource`, `toolResult(...content)`, `jsonResult(value, ...content)` (typed
`structuredContent`), `errorResult(message)`, `promptResult`, `userMessage`, `assistantMessage`,
`resourceResult(uri, { text | blob, mimeType })`. Binary inputs accept `Uint8Array` or base64
strings (no `Buffer` in `kmcp/server`).

`progress(ctx)` (no-op without a progress token), `principal(ctx)` (identity without the token),
`clientIdentity(ctx)` (the modern `_meta` envelope: protocol version, client info, capabilities, log
level), `log(ctx)`.

### Capability options

Every capability accepts `tags` (server-side labels, never on the wire) and `auth`:

```ts
import { defineTool, requireScopes } from "kmcp/server";

const admin = defineTool(
	"purge",
	{ auth: { check: requireScopes("admin"), anonymous: "deny" } },
	async () => toolResult(textContent("purged")),
);
```

`auth` is evaluated when a server is materialized for a request: a denied capability is simply not
installed (absent from lists, `not found` on call — never "disabled"). `anonymous` has no default;
`serveMcpStdio`/`serveMcpHttp` throw `CAPABILITY_AUTH_UNSERVEABLE` at startup when a capability
requires a principal they cannot supply. Resources accept `size` and `annotations`; templates accept
`list` and per-variable `complete`; prompts accept `complete` maps that work for any schema (the
SDK's own completion lookup only sees Zod `completable()` fields, so kmcp serves
`completion/complete` itself). Definition-time uniqueness covers names **and** URIs.

`withJsonSchema(validator, json)` decouples the advertised JSON schema from the runtime validator.

### Class, builder, and decorator APIs

```ts
import { McpServerBuilder, McpToolDefinition } from "kmcp/server";

const tool = new McpToolDefinition("greet", { inputSchema: input }, async ({ name }) =>
	toolResult(textContent(`Hello ${name}`)),
);
const server = McpServerBuilder.create({ name: "example", version: "1.0.0" }).tool(tool).build();
const runtime = await server.instantiate({ era: "modern" });
runtime.registrations[0]?.handle.disable();
```

The builder is immutable and rejects duplicate keys at compile time and runtime. Stage-3 decorators
(`@McpServerApp`, `@McpTool`, `@McpPrompt`, `@McpResource`, `@McpResourceTemplate`, `serverFrom`)
store per-instance recipes in a private `WeakMap`; `serverFrom` walks the prototype chain, so
subclasses of a decorated app work.

### Transforms, decorators, composition

Definitions are immutable; reshaping is a pure `definition → definition` projection:

```ts
import {
	abortable,
	cacheCalls,
	decorateHandlers,
	filterCapabilities,
	prefixNames,
	rateLimit,
	sizeLimit,
	timeout,
} from "kmcp/server";

const hardened = server.transform(
	filterCapabilities({ tool: (tool) => !tool.options.tags?.includes("internal") }),
	prefixNames("v2"),
	decorateHandlers(timeout(5_000)),
	decorateHandlers(rateLimit({ limit: 60, windowMs: 60_000 })),
	decorateHandlers(cacheCalls({ ttlMs: 1_000 })),
);
```

`mapCapabilities`, `filterCapabilities`, `prefixNames` (names only — URIs are never rewritten),
`decorateHandlers` with the built-ins `timeout`, `abortable`, `logCalls`, `rateLimit`, `sizeLimit`,
`cacheCalls`, and `composeTransforms`. Every decorator passes an `InputRequiredResult` through
untouched. `definition.mount(child, { prefix })` composes definitions and rejects a child with a
`setup` hook unless `allowSetup: true`; `mount({ prefix, uriNamespace: { schemes } })` (or the
standalone `namespaceUris`) additionally namespaces resource URIs by prefixing the first path
segment of the allowlisted schemes, mapping reads back and re-projecting `contents[].uri`.

`transformTool(definition, { name?, description?, args? })` derives a new canonical tool whose
ADVERTISED input schema is rewritten — arguments renamed, re-described, or hidden (a hidden required
argument needs a `default`, injected on every call) — while validation and the original handler keep
the underlying shape. `transformTools({ name: options })` applies a map and refuses unknown names.

### Middleware, visibility, providers

Three per-request seams live on the server definition and compose with `admit()`:

```ts
import {
	authorize,
	connectionProvider,
	disable,
	enable,
	maskErrorDetails,
	requireScopes,
	tokenBucketMiddleware,
} from "kmcp"; // middleware/visibility from kmcp/server; providers from kmcp/gateway

const definition = defineServer(
	{ name: "front", version: "1.0.0" },
	{
		capabilities: [localTool],
		middleware: [
			tokenBucketMiddleware({ capacity: 20, refillPerSecond: 5 }),
			maskErrorDetails({ onerror: report }),
			authorize(requireScopes("mcp:call")),
		],
		visibility: [disable({}), enable({ tags: ["public"] })],
		providers: [connectionProvider(manager, "github")],
		declare: ["tool", "prompt", "resource", "resource-template"],
	},
);
```

- **Middleware** wraps every capability handler at materialization (outermost first) and sees the
  request context (`era`, `authInfo`) that `decorateHandlers` cannot; decorator wrappers baked into
  a definition run inside the chain. Built-ins: `logMiddleware`, `timingMiddleware`,
  `tokenBucketMiddleware`, `maskErrorDetails`, `responseLimit` — all pass `InputRequiredResult`
  through untouched.
- **Visibility** rules run left to right, last match wins; an empty selector matches everything, so
  `[disable({}), enable({ tags: ["public"] })]` is an allowlist. Hidden capabilities are simply not
  installed for that request.
- **Providers** are per-request capability sources (`(context) => definitions`). They require an
  explicit `declare` (advertisement is fixed at construction), fail the materialization closed
  (`PROVIDER_FAILED`) instead of silently shrinking the catalog, and collide with static keys as
  `CAPABILITY_DUPLICATE`. `connectionProvider(manager, id)` / `hubProvider(hubs, hubId)` project a
  managed connection or hub catalog into the definition with generation/fingerprint-fenced calls;
  `notifyOnCatalogChange(source, handler)` bridges catalog changes to list-changed notifications.

Authorization helpers: `requireScopes` (reports `missingScopes`), `requireRoles(extract, ...)`,
`allOf` / `anyOf` (scope shortfalls aggregate conservatively — aggregation stops at the first opaque
failure), `restrictTag(tag, ...scopes)` as a definition transform, and `authorize(...)` as call-time
middleware raising `McpInsufficientScopeError`.

### Discovery transforms

`searchTools(definition, { scorer: "bm25" | "regex", maxResults, alwaysVisible })` replaces the tool
catalog with `search_tools` + `call_tool` meta-tools so a large catalog costs two schemas. Both
resolve against the same per-request ADMITTED set, so visibility and per-capability auth keep
holding — a tool the principal cannot see cannot be found or called through the proxy. BM25 is built
in (zero dependencies). `resourcesAsTools(definition)` and `promptsAsTools(definition)` synthesize
`readOnlyHint` list/read/render tools for tool-only clients.

### Lifespan

`serveWithLifespan({ start, stop }, (state) => serveMcpHttp(...))` scopes process-level resources to
a serving entry: `start()` runs first, `stop(state)` runs after the returned handle's `close()`,
with `AggregateError` on double failure.

## Auth

`kmcp/auth` builds SDK `OAuthTokenVerifier`s: `jwtVerifier({ jwksUri, issuer, audience })` (`jose`,
optional peer), `introspectionVerifier({ endpoint, credentials })` (bounded LRU + negative cache),
`staticTokenVerifier(entries)` (constant-time), `routeByIssuer(routes)`. All of them reject with
`OAuthError(invalid_token)` and report internal faults as `server_error`, so the wire always carries
a proper `WWW-Authenticate`. Detailed causes go to `onerror`, never to clients.

`kmcp/server` composes the gate:

```ts
import { createMcpAuthGate, withMcpAuth } from "kmcp/server";
import { jwtVerifier } from "kmcp/auth";

const gate = createMcpAuthGate({
	verifier: jwtVerifier({ jwksUri, issuer, audience: "https://mcp.example.com/mcp" }),
	resourceServerUrl: "https://mcp.example.com/mcp",
	requiredScopes: ["mcp:read"],
});
const guarded = withMcpAuth(server.handler(), gate);
```

The gate serves the OAuth well-known documents before authentication, derives the PRM URL, verifies
`AuthInfo` shape, enforces RFC 8707 resource binding, and `withMcpAuth` discards any caller-supplied
`authInfo` while preserving `parsedBody`. Trusted-proxy deployments use `requestVerifier` with
mandatory provenance (`trustedProxy`). `httpRequest(ctx)` / `createHttpRequestReader` expose the
inbound request with credential headers redacted; `forwardableHeaders` strips credentials,
hop-by-hop, framing and `mcp-*` headers before forwarding.

Wire `requestState` integrity yourself, as the spec requires:
`defineServer(info, { sdk: { requestState: { verify: codec.verify } } })` with
`createRequestStateCodec`.

## Node serving

```ts
import { serveMcpHttp, mcpHttpEnvOptions } from "kmcp/node";

const handle = await serveMcpHttp(server, {
	...mcpHttpEnvOptions(),
	auth: gate,
	health: "/healthz",
	dnsRebinding: { hosts: ["mcp.example.com"] },
});
console.log(handle.address.url);
await handle.close();
```

Pipeline order: `OPTIONS → 405`, health, OAuth well-known documents, host/origin validation, bearer
gate, MCP. Loopback binds default to the SDK's localhost allow-lists; a routable bind requires
`dnsRebinding.hosts` and either `auth` or `allowUnauthenticated: true`. No CORS or route registry
lives in the kernel — compose those in your framework over `createNodeMcpHandler(server, { auth })`
(one request conversion, `req.auth` never trusted).

`serveMcpStdio(server)` returns `{ runtime, notify, close }` so a stdio server can emit list-changed
and resource-updated signals on both eras. `connectionsFromMcpConfig(config, { env })` turns an
`mcpServers` config (or the VS Code `servers` shape) into keyed connection definitions with hub-safe
namespace suggestions in `tags["kmcp.namespace"]`, honoring `timeout` (seconds), `protocolVersion`,
and `${VAR}` substitution when an `env` map is supplied; `standardMcpConfigPaths` /
`discoverMcpConfigs` / `readMcpConfigFile` find and read the Claude Code, Claude Desktop, Cursor, VS
Code, Windsurf and Kiro config locations. `decodeResourceContent` (`kmcp/client`) and
`writeResourceToFile` (`kmcp/node`, atomic) materialize a `resources/read` result; pair the latter
with `resource.updated` events to keep a file in sync.

## Connections and catalogs

```ts
import { McpConnectionManager, httpConnection, throwIfToolError } from "kmcp/client";
import { stdioConnection } from "kmcp/node";

const manager = new McpConnectionManager({ maxConnections: 100 });
manager.register(
	stdioConnection({
		id: "github",
		stdio: { command: "github-mcp-server", args: ["stdio"] },
		autoRefreshCatalog: true,
		defaults: { toolTimeoutMs: 30_000 },
	}),
);
manager.register(
	httpConnection({
		id: "remote",
		url: "https://mcp.example.com/mcp",
		auth: process.env.MCP_TOKEN!,
		requestHandlers: {
			"elicitation/create": async (request) => ({ action: "decline" }),
		},
		inputRequired: { maxRounds: 3 },
	}),
);

await manager.connectAll(["github", "remote"], { atomic: true });
const catalog = await manager.refreshCatalog("github");
const result = throwIfToolError(
	await manager.callTool("github", "search_repositories", { query: "mcp" }, { timeout: 5_000 }),
);
```

Definition options: `requestHandlers` (`elicitation/create`, `roots/list`, `sampling/createMessage`
— capabilities derived minimally; `advertise` opts into URL elicitation and tool-augmented
sampling), `notificationHandlers`, `roots`, `inputRequired` (an explicit small `maxRounds` is
required when handlers exist), `autoRefreshCatalog` (single-flight, minimum interval, per-generation
cap; works on both eras and repairs the listen stream after a `prior` reconnect), `defaults`
(millisecond timeouts, progress), `logLevel` (stamped per request on the modern era), `oauth`,
`reconnect` (opt-in backoff after an UNEXPECTED close — every attempt re-enters the public
`connect()`, so single-flight, drain queuing, and generation discipline are inherited; snapshots
expose `reconnect.attempts`/`nextAttemptAt` and the manager emits `connection.reconnect.scheduled` /
`connection.reconnect.exhausted`), `keepalive` (periodic `ping` / `server/discover`; after
`failureThreshold` consecutive failures the session is closed as an unexpected close and `reconnect`
takes over — `connection.keepalive.failed`, `CONNECTION_KEEPALIVE_FAILED`), `protocolVersion` (pin
one exact revision, strict: a modern pin drives the `server/discover` probe, a legacy pin runs the
plain `initialize` handshake offering only that revision; `MCP_SUPPORTED_PROTOCOL_VERSIONS` lists
what can be pinned), `disconnectTimeoutMs` (a close that overruns it quarantines instead of
hanging), `terminateSession` (send the Streamable HTTP `DELETE` on disconnect; default on), `tasks`
(advertise the 2025-11-25 `tasks` client capability; default on), `extensions` (capability
extensions), and `configureClient` (a synchronous escape hatch over the freshly constructed official
`Client` before `connect()`). `httpConnection` accepts a bearer string, an SDK `AuthProvider`, or
any `OAuthClientProvider` (an interactive one arms the `authorizing` flow; client-credentials and
enterprise providers advertise their capability extension automatically); `headers` may not carry
`Authorization` next to `auth`; `middlewares` composes SDK fetch middlewares (`withLogging`,
`createMiddleware`, …) around the transport; `resume` adopts a server-side session once (`sessionId`
plus the negotiated `protocolVersion`) and any later reconnect starts fresh; `reconnection`
overrides `MCP_HTTP_RECONNECTION_DEFAULTS` (1 s → 30 s, factor 2, 10 retries for the
server-to-client stream); `cachePartition` defaults to a digest of the credential identity.
`stdioConnection` (`kmcp/node`) adds `onStderrLine` to receive the child's stderr line by line.

Manager verbs take the SDK request option types plus `meta` (`_meta` passthrough) and an optional
generation/fingerprint `control`: `callTool` (with `contract` it refuses the call when the
advertised tool has drifted from an expected shape in a way that breaks it — see
`checkToolContract`), `callToolParsed` (raises `McpToolCallError` on `isError` unless
`raiseOnError: false`; the SDK has already validated `structuredContent`), `readResource`,
`getPrompt`, `complete`, `listTools`, `listResources`, `listResourceTemplates`, `listPrompts`,
`listSkills` / `readSkill` (SEP-2640: the `skill://index.json` index, then a scan of the resource
list), `ping` (`server/discover` on modern, `ping` on legacy), `discover` (a live `server/discover`,
modern only), `setLogLevel`, `subscribeResource` / `unsubscribeResource` (legacy sends the RPC;
2026-07-28 has no `resources/subscribe`, so the subscription is expressed through the
`subscriptions/listen` filter — updates surface as `resource.updated` events and subscriptions are
generation-scoped, so re-subscribe after a reconnect), `notifyRootsChanged` (legacy-era only — the
2026 wire removed roots), `connectAll`, `completeAuthorization`, and the task verbs below. The hub
mirrors `callToolParsed` and injects the resolved catalog `Tool` as `toolDefinition`. Snapshots
carry `transportKind`, `sessionId`, `connectionMode` (`stateful` / `stateless`), `supportedVersions`
(from `server/discover`), `lastSeenAt`, `keepalive`, `instructions`, `serverInfo`,
`errorDetail { kind, code, httpStatus? }` (so a panel can tell "server is 2025-only" from "401" from
"registration rejected"), and `watch` (which list-changed sections are honored, why not, and how
often the stream was re-opened).

Two resilience behaviors run without configuration. A modern `subscriptions/listen` stream that
drops unexpectedly (`closed` resolving `'remote'`) is re-opened with 1 s → 30 s backoff for as long
as the generation lives (`connection.listen.dropped` / `connection.listen.reopened`); the SDK never
re-listens on its own, so list changes and resource updates would otherwise stop silently after the
first network hiccup. A request that fails with HTTP 404 on a transport that carries a session id is
read as the server having expired the session: the generation fails with
`CONNECTION_SESSION_EXPIRED` (`connection.session.expired`) and the reconnect policy, when any,
opens a fresh session.

Catalogs are capability-aware and partial (`fresh` / `stale` / `failed` / `unsupported` per
section), bounded, detached and deeply frozen. Snapshots exclude transports, endpoints, OAuth
objects and raw error messages.

### Tasks (2025-11-25)

```ts
const created = await manager.callToolTask("github", "index_repo", { repo: "octo/mcp" });
const result = await manager.waitForTask("github", created.task.taskId, {
	pollIntervalMs: 2000,
	onUpdate: (update) => console.log(update.status, update.statusMessage),
});
// or in one go: manager.callToolViaTask(id, name, args, { onUpdate })
await manager.listTasks("github");
await manager.cancelTask("github", created.task.taskId);
```

Task-augmented tool calls (SEP-1686) use the 2025-11-25 wire vocabulary through `Client.request()`
with the SDK's own result validators: `callToolTask`, `waitForTask` (a `failed` or `cancelled` task
rejects with `McpTaskFailedError`; `input_required` delegates to `tasks/result`), `callToolViaTask`,
`getTask`, `getTaskResult`, `listTasks`, `cancelTask`, and `supportsToolTasks`. Revision 2026-07-28
moved tasks to the `io.modelcontextprotocol/tasks` extension, which the SDK does not implement yet,
so on a modern connection every task verb rejects with `TASKS_UNAVAILABLE` instead of returning a
tool result where a task id was expected. `McpTaskClient` exposes the same verbs over a raw official
`Client`.

### OAuth

```ts
import { McpOAuthClientProvider, authorizeOAuth, httpConnection } from "kmcp/client";
import { FileKeyValueStore, loopbackOAuthCallback, openBrowser } from "kmcp/node";

const callback = await loopbackOAuthCallback({ port: [13316, 31613, 0] });
const provider = new McpOAuthClientProvider({
	serverUrl: "https://mcp.example.com/mcp",
	redirectUrl: callback.redirectUrl,
	store: new FileKeyValueStore("~/.config/app/oauth.json"),
	onRedirect: async (url) => {
		callback.onRedirect(url);
		if (!(await openBrowser(url))) console.log(`Open ${url.href}`);
	},
});
// Log in ahead of any connection (discovery, registration or CIMD, redirect, exchange):
await authorizeOAuth(provider, {
	serverUrl: provider.serverUrl,
	waitForCallback: callback.waitForCallback,
});
console.log(await provider.status()); // non-secret: issuer, clientId, scope, expiresAt, identity
manager.register(
	httpConnection({ id: "remote", url: "https://mcp.example.com/mcp", auth: provider }),
);
// Or let the connection raise the challenge:
try {
	await manager.connect("remote");
} catch {
	// phase "authorizing" + event "connection.authorization.required"
	await manager.completeAuthorization("remote", await callback.waitForCallback());
}
```

`McpOAuthClientProvider` stores credentials per authorization-server issuer (SEP-2352), persists
PKCE and discovery state, never overwrites a pre-registered client id, issues and verifies the OAuth
`state` parameter the SDK leaves to hosts (`AUTH_STATE_MISMATCH`; the manager's
`completeAuthorization` verifies it before the code is exchanged), refreshes an access token before
it expires through the SDK's `refreshAuthorization` (single-flight, 60 s buffer, off with
`refresh: false`; a failed refresh falls back to the transport's 401 path), and reports what it
holds through `status()`. `explainOAuthError` turns any error from the flow into a stable
`{ kind, message, remediation? }` — registration refused or unsupported, client rejected, access
denied, issuer mix-up (never echoing the attacker-controlled issuer), insufficient scope — and
`describeError` carries the same classification into snapshots. `openBrowser` / `browserOpenCommand`
(`kmcp/node`) open only `http(s)` URLs and never through a shell.

Machine-to-machine (`io.modelcontextprotocol/oauth-client-credentials`):

```ts
import { clientCredentialsAuth, validateOAuthCredentials } from "kmcp/client";

const auth = clientCredentialsAuth({ clientId, clientSecret, scope: ["read"] }); // or privateKey / jwtBearerAssertion
await validateOAuthCredentials(auth, "https://mcp.example.com/mcp"); // one real token request
manager.register(httpConnection({ id: "m2m", url: "https://mcp.example.com/mcp", auth }));
```

`clientCredentialsAuth` builds the SDK's `ClientCredentialsProvider` / `PrivateKeyJwtProvider` /
`StaticPrivateKeyJwtProvider`; `tokenEndpoint` pins the endpoint for servers without discoverable
metadata. Enterprise-managed authorization (SEP-990,
`io.modelcontextprotocol/enterprise-managed-authorization`) is `authorizeEnterpriseIdp` for the
one-time OIDC sign-in at the IdP (PKCE S256, `state`, `nonce`) and `enterpriseManagedAuth` for the
runtime `CrossAppAccessProvider`, which exchanges the ID token for an ID-JAG at the IdP and the
ID-JAG for an access token at the MCP authorization server, renewing the ID token through the IdP
refresh token (`reloadIdpTokens` / `onIdpTokensRefreshed` keep several processes in step).
Connections that use either provider advertise the matching capability extension automatically.

## Hubs

```ts
import { McpHubDefinition, McpHubManager } from "kmcp/hub";

const hubs = new McpHubManager(manager);
hubs.register(
	new McpHubDefinition({ id: "workspace", members: [{ connectionId: "github", namespace: "gh" }] }),
);
const catalog = await hubs.refreshCatalog("workspace");
const search = catalog.tools.find((tool) => tool.route === "gh.search_repositories");
if (search === undefined) throw new Error("GitHub search is unavailable");
await hubs.callTool("workspace", search, { query: "mcp" });
await hubs.readResource("workspace", "gh", "repo://octo/readme"); // static or template-expanded
await hubs.complete("workspace", "gh.review", { name: "language", value: "ty" });
```

Routes are reversible (`namespace.name`, `namespace:uri`) and fenced on the member's exact catalog
generation and fingerprint. Template-expanded reads resolve against the member's listed templates
with the SDK `UriTemplate`.

## Gateway

```ts
import { defineGateway } from "kmcp/gateway";
import { serveMcpHttp } from "kmcp/node";

const gateway = defineGateway({
	hubs,
	hubId: "workspace",
	serverInfo: { name: "workspace-gateway", version: "1.0.0" },
	policy: {
		names: "namespaced", // `gh.search_repositories`; or "passthrough" (collisions drop both)
		resources: "namespaced", // `gh:repo://…` (reversible); or "passthrough"
		authorize: {
			anonymous: "deny",
			check: (authInfo, route) =>
				route.route.namespace !== "admin" || authInfo.scopes.includes("admin"),
		},
	},
});
const watching = gateway.start(); // pushes list-changed downstream on every hub refresh
await serveMcpHttp(gateway, { auth: gate });
```

Each request materializes a server from one hub snapshot; forwarded calls go through fenced hub
routes (removed capabilities fail closed); names are projected as `namespace.name` and validated
against the SDK tool-name grammar (unprojectable routes are reported in
`gateway.snapshot().dropped`, never renamed); multi-round-trip rounds (`inputResponses`,
`requestState`, and the downstream client's capabilities) are relayed verbatim so elicitation and
sampling work end to end on both eras; `completion/complete` is forwarded to upstreams that
advertise it; pinned instances (stdio) are reconciled in place when the topology changes. Downstream
`authInfo` is never forwarded upstream — the gateway is not a credential-forwarding proxy;
per-principal visibility is `policy.authorize`. Logging and resource-update subscriptions are not
forwarded.

## Testing and conformance

- `inProcessConnection({ definition, era })` connects the official client to a definition with no
  sockets: modern through the real `createMcpHandler` path, legacy over `InMemoryTransport`.
- `pnpm run check` runs typecheck, both-era unit tests, build, a dist smoke test, `publint` and
  prettier. `pnpm run conformance:golden` runs the `server/discover` wire goldens.
- `pnpm run conformance:server` and `pnpm run conformance:gateway` run the official
  `@modelcontextprotocol/conformance` suite against the everything-server fixture and the same
  fixture behind a gateway; `conformance-baseline*.yml` list the justified expected failures
  (conformance 0.1.16 only speaks 2025-11-25, and the SDK's per-request legacy serving cannot
  deliver server-to-client requests). CI runs the pinned tool; a nightly job runs the tool's main
  over the `all` suite.

## Known gaps

- Tasks only on 2025-11-25: the SDK has no runtime for the 2026-07-28
  `io.modelcontextprotocol/tasks` extension yet, so modern connections reject the task verbs.
- No bundled OS keychain, persistent session daemon, or x402 payment support: bring a
  `McpKeyValueStore`, a process model, and a `fetch` middleware respectively.

- Anything that needs ownership of the SDK `tools/list` / `tools/call` handlers: cursor pagination,
  list-level middleware, protocol-level tool errors (the SDK converts every handler throw into an
  `isError` result).
- The modern event bus fans `resourceUpdated` out to every subscription regardless of principal;
  per-capability `auth` does not extend to update notifications.
- Gateway phase 2: forwarding resource-update subscriptions per principal.
- Durable desired state, SQL/Redis adapters, and multi-instance fencing remain behind the seams
  described in [ARCHITECTURE.md](./ARCHITECTURE.md).
