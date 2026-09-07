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
`${VAR}` / `${env:VAR}` substitution on every value-bearing field when an `env` map is supplied (VS
Code's `${input:…}`, `${workspaceFolder}` and other host variables pass through unchanged), and
`type` / `transport` routing (`stdio`, `http` / `streamable-http`, `sse` for the deprecated HTTP+SSE
transport — `transportKind: "sse"`, legacy era only, so `protocolVersion` is refused there;
case-insensitive; an unknown value or one the entry contradicts, such as `type: "stdio"` with only a
`url`, throws `INVALID_DEFINITION` instead of guessing; entries without a `type` keep inferring from
`url` / `command`; a malformed field raises `INVALID_DEFINITION` naming the entry and the field). A
`command` that reads as a command line and has no `args` is split POSIX-style before substitution
(`parseCommandLine`: quotes and backslash escapes, no expansion; a path that exists as written, a
`C:\…` drive path or a `\`-separated path is passed through whole, an expanded `${VAR}` with spaces
is never re-split, and any `args`, even `[]`, keeps the command verbatim); `resolveExecutable`
answers whether a command would be found on `PATH` without spawning (on Windows: working directory
first, quoted entries unquoted, `PATHEXT`, and the bare name only when it carries a `.`). Every
definition the loader builds carries a `fingerprint` (SHA-256 over the loaded entry and the loader
options, secrets included on purpose so a rotated token counts as a change) for `reconcile` to tell
an unchanged entry from an edited one. `standardMcpConfigPaths` / `discoverMcpConfigs` /
`readMcpConfigFile` find and read the Claude Code, Claude Desktop, Cursor, VS Code, Windsurf and
Kiro config locations (a file where a directory was expected, or the reverse, counts as absent), and
`watchMcpConfigs({ paths?, onChange, onError? })` watches them — `fs.watch` on the parent directory,
debounced (`debounceMs`, 250 ms), polling fallback where `fs.watch` fails or with `poll: true`,
`onChange({ path, configs })` only when the file's bytes actually change (identical rewrites and
macOS event replays are dropped; `initial: true` delivers the current content once at start),
content empty when the file was deleted or holds no servers, parse errors to `onError` without
stopping, a deleted or replaced watched directory re-watched or polled instead of going dead, and an
idempotent `close()`. `decodeResourceContent` (`kmcp/client`) and `writeResourceToFile`
(`kmcp/node`, atomic) materialize a `resources/read` result;
`syncResourceToFile(manager, id, uri, path)` keeps a file in step with a resource — one write up
front, a coalesced rewrite on every `resource.updated`, and a re-subscribe after a reconnect.

HTTP proxies: Node's `fetch` ignores `HTTP_PROXY` / `HTTPS_PROXY` unless the process runs with
`NODE_USE_ENV_PROXY=1` (Node 24 and later); otherwise pass a proxy-aware `fetch` through
`transportOptions.fetch`, which every OAuth helper also accepts as `fetch`.

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
enterprise providers advertise their capability extension automatically); `headers` merge over
`transportOptions.requestInit.headers`, and neither may carry `Authorization` next to `auth`
(checked in every `HeadersInit` form); `middlewares` composes SDK fetch middlewares (`withLogging`,
`createMiddleware`, …) around the transport, outermost first; `resume` adopts a server-side session
once — the SDK then runs no handshake, so the `McpResumedSession` record
(`resumedSessionFrom(snapshot)` builds it from a connection snapshot; `undefined` when the server
issued no session id) stands in for it, strict capability enforcement is off for that generation,
the list verbs walk the pages themselves, and any later reconnect starts fresh (the record is spent
only by a connect that succeeds with it: a failed first attempt keeps it for the retry, and a 404
burns it so the retry handshakes fresh; any transport that already carries a session id engages the
same paths); `reconnection` overrides `MCP_HTTP_RECONNECTION_DEFAULTS` (1 s → 30 s, factor 2, 10
retries for the server-to-client stream); `cachePartition` is never derived: it only matters for a
`responseCacheStore` shared across principals, and credentials next to a shared store without an
explicit partition are refused at definition time (`INVALID_DEFINITION`). `stdioConnection`
(`kmcp/node`) adds `onStderrLine` to receive the child's stderr line by line. `sseConnection`
reaches servers still on the deprecated HTTP+SSE transport (legacy era only; same `auth` and
`headers` handling), for the migration period the SDK keeps that transport for. `kmcp/client` also
re-exports the curated SDK client surface (`Client`, the transports, the OAuth providers and flow
functions, the fetch middlewares, the error classes, `specTypeSchemas`) so application code imports
one package.

Manager verbs take the SDK request option types plus `meta` (`_meta` passthrough) and an optional
generation/fingerprint `control`: `callTool` (with `contract` it refuses the call when the
advertised tool has drifted from an expected shape in a way that breaks it — see
`checkToolContract`), `callToolParsed` (raises `McpToolCallError` on `isError` unless
`raiseOnError: false`; the SDK has already validated `structuredContent`), `readResource`,
`getPrompt` (with `contract`, the prompt counterpart of the tool contract), `complete`,
`checkToolContract` / `checkPromptContract`, `listTools`, `listResources`, `listResourceTemplates`,
`listPrompts`, `listSkills` / `readSkill` (SEP-2640: the `skill://index.json` index, then a scan of
the resource list), `ping` (`server/discover` on modern, `ping` on legacy), `discover` (a live
`server/discover`, modern only), `setLogLevel` (the snapshot records the level once the upstream
accepted it), `subscribeResource` / `unsubscribeResource` (legacy sends the RPC; 2026-07-28 has no
`resources/subscribe`, so the subscription is expressed through the `subscriptions/listen` filter —
updates surface as `resource.updated` events, subscriptions are generation-scoped, so re-subscribe
after a reconnect, and a subscribe that lands while the session is being replaced rejects with
`CONNECTION_NOT_ONLINE` instead of pretending), `notifyRootsChanged` (legacy-era only — the 2026
wire removed roots), `connectAll`, `completeAuthorization`, and the task verbs below. The hub
mirrors `callToolParsed` and injects the resolved catalog `Tool` as `toolDefinition`. Snapshots
carry `transportKind`, `sessionId`, `connectionMode` (`stateful` / `stateless`), `supportedVersions`
(from `server/discover`), `lastSeenAt`, `keepalive` (its failure counters survive into the `failed`
phase so the verdict stays explainable; a deliberate disconnect or the next connect clears them),
`instructions`, `serverInfo`, `errorDetail { kind, code, httpStatus? }` (so a panel can tell "server
is 2025-only" from "401" from "registration rejected" from `ECONNREFUSED` — a transport-level cause
classifies as `network` wherever it sits in the cause chain), and `watch` (which list-changed
sections are honored, why not, and how often the stream was re-opened; a dropped stream reads as
inactive until the retry re-opens it, and `maxRefreshesPerGeneration` counts only refreshes that
committed a catalog).

SDK-level failures that do not end a session (a malformed frame, a stream hiccup, reconnect noise)
no longer vanish: every generation wires `client.onerror` and `transport.onerror` (chaining whatever
`configureClient` installed), reports each error once as the informational event `connection.error`
(the phase never changes because of it; a transport that then closes still fails through the
unexpected-close path), keeps the last few as `snapshot.diagnostics`
(`{ at, kind, code, message, generation }`, default 20,
`new McpConnectionManager({ diagnostics: { keep: 50 } })` or `false`; bounded, control-character
stripped, never carrying headers, tokens or bodies: only a `KmcpError` or a Node system error speaks
in its own words, every SDK, SSE, protocol or OAuth error gets a sentence synthesized from its
classification because SDK transports interpolate raw response bodies into their messages), and
hands the original error to the manager's `onError(id, error)` hook.
`explainConnectionError(errorOrSnapshot)` turns any failure into the same stable
`{ kind, message, remediation?, code?, httpStatus? }` shape `explainOAuthError` produces (network
and TLS codes, HTTP statuses with session and transport awareness — a 404 on a stateful connection
is an expired session, a 405 suggests the other HTTP transport —, the SDK's `SseError` by its HTTP
status, an `AggregateError` from `connectAll` or `reconcile` by its first member, era and version
mismatches, stdio spawn failures, and the kmcp codes; a rejected credential is `authorization`
whether it arrives live or from a snapshot), so a panel renders one shape for every reason a
connection is down.

Runtime config edits go through `replace(definition, { cancelAuthorization? })` (swap under an id:
offline or failed in place, clearing the old failure and diagnostics; a usable connection — online
or degraded — drains, swaps and reconnects on a new generation; one parked in `authorizing` is
refused with `CONNECTION_AUTHORIZING` unless the caller opts to cancel the round; an equivalent
definition is a no-op; concurrent swaps on one id serialize) and
`reconcile(definitions, { remove? })`, which applies a whole desired set and returns
`{ added, replaced, unchanged, removed }`: removals drain first, additions are registered but not
connected, unchanged entries keep their generation and session, a replaced connection whose new
server is down still counts as replaced with its reason on the snapshot, and a partial failure
throws `McpReconcileError` (an `AggregateError` whose `result` is the diff that did land, so
`connectAll(error.result.added)` is the recovery). Equivalence is
`McpConnectionDefinition.fingerprint`: by default a digest of the definition's non-secret shape
(`httpConnection` / `sseConnection` add the URL, header names and the auth shape; `stdioConnection`
the command line, env names and cwd; `inProcessConnection` the era and server identity), so two
definitions rebuilt from the same config are `unchanged` and live sessions survive a config re-read,
while a definition whose only change is a token, header value or env value compares equal — pass
`fingerprint` (a digest of the raw entry, as `connectionsFromMcpConfig` does) when credentials are
part of your revision, and `transportFingerprint` from a custom factory that wants shape comparison;
a bare `defineConnection` with an opaque transport is unique to itself. Pair it with
`watchMcpConfigs` (`kmcp/node`) to follow config files as the user edits them.

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
with the SDK's own result validators: `callToolTask` (`ttlMs`, and `pollIntervalMs` as the server
hint), `waitForTask` (polls at the caller's `pollIntervalMs`, else the server's `pollInterval`
re-read on every poll; a `signal` aborts the in-flight request, not only the sleep; a `failed` or
`cancelled` task rejects with `McpTaskFailedError`; `input_required` delegates to `tasks/result`),
`callToolViaTask`, `getTask`, `getTaskResult`, `listTasks`, `cancelTask`, and `supportsToolTasks`.
Revision 2026-07-28 moved tasks to the `io.modelcontextprotocol/tasks` extension, which the SDK does
not implement yet, so on a modern connection every task verb rejects with `TASKS_UNAVAILABLE`
instead of returning a tool result where a task id was expected. `McpTaskClient` exposes the same
verbs over a raw official `Client`.

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

`McpOAuthClientProvider` stores credentials per authorization-server issuer (SEP-2352) and per
optional `profile` (several identities for one server share a store without sharing anything else),
persists PKCE and discovery state, never overwrites a pre-registered client id, issues and verifies
the OAuth `state` parameter the SDK leaves to hosts (a callback without a pending state, or with a
state already spent, is refused with `AUTH_STATE_MISMATCH`; `matchesIssuedState` lets a host that
multiplexes one loopback listener route a callback without consuming it; the manager's
`completeAuthorization` verifies it before the code is exchanged; the same verb also finishes a
MID-SESSION round — a 403 scope step-up or a 401 the refresh could not fix surfaces from the
operation as the SDK's `UnauthorizedError` after the provider was handed the new authorization URL,
the manager announces `connection.authorization.required` without leaving the online phase, and
completing it on the live transport stores the widened tokens for the next request), refreshes an
access token before it expires through the SDK's `refreshAuthorization` (single-flight, 60 s buffer,
off with `refresh: false`; a failed refresh falls back to the transport's 401 path; never during the
SDK's own contextual reads, and a refresh that lands after `invalidateCredentials` is not
re-stored), forgets tokens under every issuer it ever wrote on `invalidateCredentials("tokens")`,
discards the PKCE verifier and state as soon as a round ends (`authorizeOAuth`, the manager's
`completeAuthorization`, or `definition.finishAuthorizationRound()` for hosts that exchange the code
themselves), and reports what it holds through `status()` (issuer, client id, scope, expiry, save
time, display-only identity). `InMemoryKeyValueStore`, `FileKeyValueStore` (`kmcp/node`, mode
`0600`, atomic) and `KeyringKeyValueStore` (an OS keyring through a host-supplied
`(service, account)` entry factory such as `@napi-rs/keyring`'s `Entry`; kmcp itself never loads a
native module) are the bundled stores. `explainOAuthError` turns any error from the flow into a
stable `{ kind, message, remediation? }` — registration refused or unsupported, client rejected,
access denied, issuer mix-up (never echoing the attacker-controlled issuer), insufficient scope —
and `describeError` carries the same classification into snapshots (the authorization server's text
is bounded and stripped of control characters before it reaches a log). `loopbackOAuthCallback`
answers only top-level `GET` navigations whose `Host` is a loopback name (`127.0.0.1`, `localhost`,
`[::1]`), keeps listening when an optional `accept(params)` predicate refuses a callback that is not
ours, and with `hostname: "localhost"` also binds `::1` so a browser resolving to IPv6 lands on the
same port. `openBrowser` / `browserOpenCommand` (`kmcp/node`) open only `http(s)` URLs and never
through a shell. Every token endpoint the flows post to must be `https` or loopback (the SDK's
`assertSecureTokenEndpoint`); `pinnedDiscoveryState(tokenEndpoint, issuer?)` keeps the caller's
issuer and falls back to the endpoint's origin only when none is known.

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
one-time OIDC sign-in at the IdP (PKCE S256, `state`, a `nonce` the ID token must echo, `https`
authorization endpoints only) and `enterpriseManagedAuth` for the runtime `CrossAppAccessProvider`,
which exchanges the ID token for an ID-JAG at the IdP and the ID-JAG for an access token at the MCP
authorization server, renewing the ID token through the IdP refresh token (`reloadIdpTokens` /
`onIdpTokensRefreshed` keep several processes in step). Connections that use either provider
advertise the matching capability extension automatically.

Before any connection exists, `probeServerAuth` tells a host what a pasted URL needs:

```ts
import { probeServerAuth, suggestAuth } from "kmcp/client";

const probe = await probeServerAuth("https://mcp.example.com/mcp", { timeoutMs: 5000 });
// probe.kind: "open" | "oauth" | "bearer" | "unauthorized" | "not-mcp" | "unreachable" | "redirect" | "error"
const { grant, interactive } = suggestAuth(probe); // "authorization_code" | "client_credentials" | "none"
```

One `POST` with an `initialize`-shaped body (a `GET` only when that is inconclusive), status and
headers only (bodies are cancelled, never buffered), same-origin `http(s)` redirects followed and
everything else reported as `redirect` with a `reason` (`cross-origin`, `too-many-redirects`,
`opaque`) and, when known, a `location`. A `401` or `403` with a `Bearer` challenge anywhere in
`WWW-Authenticate` is `oauth` (a `403` being a scope step-up); a challenge-less `401`/`403` runs the
SDK's well-known discovery and is `oauth` if that finds an authorization server, otherwise
`unauthorized`. An `oauth` outcome runs the SDK's own discovery — keeping the endpoint's query,
never following a redirect, refusing a `resource_metadata` URL that is plaintext off-loopback or
aimed at a private or link-local address the server does not live on — so it carries what a real
connection would find: protected-resource metadata, the authorization servers and their metadata,
`scopes` (what a connection would request: the challenge's scope, else `scopes_supported`) next to
`scopesSupported` (everything advertised), `grants`, `registration` (`cimd` whenever the server
advertises it, since that is the branch `auth()` takes; `dynamicRegistration` says whether
registering is also available; else `dynamic` / `preregistered-only` / `unknown`), extension hints,
and `issues` listing the checks `auth()` would fail (a `resource` that does not cover the probed
URL, a non-TLS token endpoint), in which case `suggestAuth` answers `none`. A `not-mcp` outcome
(404/405/406 or an HTML page) may carry `suggestedTransport` when the evidence points at the
deprecated HTTP+SSE transport. Every outcome carries `serverUrl`, `httpStatus`, the
`mcp-protocol-version` header and whether a session id was seen; nothing the server did makes the
probe throw (only a non-`http(s)` URL does), caller `headers` merge case-insensitively, and every
surfaced string is bounded and control-character stripped.

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

A member can narrow and rename what it contributes:

```ts
new McpHubDefinition({
	id: "workspace",
	members: [
		{
			connectionId: "github",
			namespace: "gh",
			tools: { allow: ["git_*", "search_repositories"], deny: ["git_push"] },
			prompts: { deny: ["*"] },
			resources: { allow: ["repo://*"] },
			rename: { git_status: "status" }, // exposed as `gh.status`; `gh.git_status` is gone
		},
	],
});
```

Filters (`{ allow?, deny? }`) match the upstream tool or prompt name, or the resource URI (and a
template's URI template), as exact strings or a prefix with one trailing `*`; `deny` beats `allow`,
no filter exposes everything, `allow: []` exposes nothing. Filtering runs on the upstream item, then
`rename` (tools only) maps the upstream name to the exposed one, then the namespace prefix is
applied. Renamed tools keep their schema, annotations and description and are still called upstream
by their upstream name; a denied or renamed-away route fails with `HUB_ROUTE_UNKNOWN` exactly like a
missing one and is not found downstream through the gateway. Two exposed names that collide drop
both, as duplicate upstream names already do. The definition refuses an empty pattern, a `*`
anywhere but last, an empty rename source or target, and two renames onto one target
(`INVALID_DEFINITION`). The hub snapshot echoes each member's `tools` / `prompts` / `resources` /
`rename` so a panel can render disabled items; denied items never appear in a catalog. Hub
definitions carry a `fingerprint` over members, filters and renames, so `hubs.update` with a
reshaped view rebuilds the gateway projection and pushes `list_changed`.

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
- `test/client-server-oauth-e2e.test.ts` runs kmcp's client against kmcp's own gated HTTP server
  over real sockets on both eras, with a fake authorization server: discovery through the gate's
  documents, dynamic registration, the connect-time authorization round, RFC 8707 `resource`
  binding, and a per-request 403 that forces a mid-session scope step-up completed on the live
  transport.
- `pnpm run conformance:client` runs every CLIENT scenario of the official suite (26 in 0.1.16, the
  interactive OAuth ones included: kmcp never opens a browser, so
  `test/conformance/client-fixture.ts` completes the redirect leg itself by fetching the
  authorization URL and handing the callback to `completeAuthorization` — connect-time and
  mid-session step-up alike); `conformance-baseline-client.yml` lists expected failures. The two
  `auth/2025-03-26-*` scenarios need the SDK's `skipIssuerMetadataValidation` opt-out, which the
  adapter enables for them only. The nightly workflow runs the same client scenarios against the
  tool's git main with `conformance-baseline-client-main.yml`, so a scenario the working group lands
  shows up there first.
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
