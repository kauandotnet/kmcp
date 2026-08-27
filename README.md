# `kmcp`

A standalone, framework-neutral TypeScript 7 toolkit built directly on the official Model Context
Protocol SDK v2.

The package combines two layers:

- Server authoring through classes, functions, a persistent builder, or standard decorators. Every
  style materializes the same canonical capability and server-definition classes.
- A framework-neutral client control-plane kernel with managed connections, partial catalog
  discovery, namespaced hubs, diagnostic snapshots, and lifecycle events that a future
  REST/SSE/WebSocket panel adapter can project.

## Requirements

- Node.js 22.13 or newer
- TypeScript 7 for source consumers
- `@modelcontextprotocol/client` and `@modelcontextprotocol/server` v2 peers
- `@modelcontextprotocol/node` v2 only when using the `kmcp/node` entry point

## Server authoring

### Functional API

```ts
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { defineServer, defineTool } from "kmcp/server";

const input = fromJsonSchema<{ name: string }>({
	type: "object",
	properties: { name: { type: "string" } },
	required: ["name"],
});

const greet = defineTool("greet", { inputSchema: input }, async ({ name }) => ({
	content: [{ type: "text", text: `Hello ${name}` }],
}));

export const server = defineServer(
	{ name: "example", version: "1.0.0" },
	{ capabilities: [greet] },
);

export const handler = server.handler();
```

`server.handler()` uses the official v2 per-request `createMcpHandler` factory. It creates a fresh
official `McpServer` for each serving unit instead of sharing a request-unsafe singleton.

### Class and builder API

```ts
import { McpServerBuilder, McpToolDefinition } from "kmcp/server";

const tool = new McpToolDefinition("greet", { inputSchema: input }, async ({ name }) => ({
	content: [{ type: "text", text: `Hello ${name}` }],
}));

const server = McpServerBuilder.create({ name: "example", version: "1.0.0" }).tool(tool).build();

const runtime = await server.instantiate({ era: "legacy" });
runtime.registrations[0]?.handle.disable();
```

The builder is immutable: each call returns a new builder. It tracks literal capability keys and
rejects duplicate keys at compile time and runtime.

### Standard decorators

```ts
import { McpServerApp, McpTool, serverFrom } from "kmcp/server";

@McpServerApp({ serverInfo: { name: "example", version: "1.0.0" } })
class ExampleServer {
	@McpTool({ name: "greet", inputSchema: input })
	async greet({ name }: { name: string }) {
		return { content: [{ type: "text" as const, text: `Hello ${name}` }] };
	}
}

export const server = serverFrom(new ExampleServer());
```

These are Stage-3 decorators. They do not use `reflect-metadata` or legacy `experimentalDecorators`.
Per-instance recipes live in a private `WeakMap`, so handlers bind to the correct instance and
wrapped/inherited methods do not leak across instances. Decorator syntax must be compiled; the
function, class, and builder APIs remain suitable for Node type-stripped source.

## Connections and catalogs

```ts
import { McpConnectionDefinition, McpConnectionManager } from "kmcp/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const manager = new McpConnectionManager({
	maxConnections: 100,
	maxCatalogItems: 10_000,
	maxCatalogNodes: 100_000,
	maxCatalogSnapshotBytes: 8 * 1024 * 1024,
});

manager.register(
	new McpConnectionDefinition({
		id: "github",
		label: "GitHub MCP",
		transport: () => new StdioClientTransport({ command: "github-mcp-server", args: ["stdio"] }),
	}),
);

await manager.connect("github");
const catalog = await manager.refreshCatalog("github");
const result = await manager.callTool("github", "search_repositories", { query: "mcp" });
```

The official client owns every transport. Concurrent connects are deduplicated, disconnect drains
active operations, and callers may cancel their wait without cancelling a shared lifecycle action.
Protocol operations require an already-online connection and never reconnect implicitly during a
drain. Optional operation controls fence work to an expected connection generation and catalog
fingerprint. The default client negotiation mode is `auto`; pass an explicit official
`clientOptions` value when a deployment must stay legacy-only or pin a protocol revision.

Successful connects receive manager-lifetime monotonic generations. Removing and later registering
the same connection ID cannot make an old catalog descriptor current again within that manager.

Catalogs are capability-aware and partial. A failed prompt listing does not erase valid tools or
resources discovered from the same connection generation. Each section is `fresh`, `stale`,
`failed`, or `unsupported`, includes a stable fingerprint when data exists, and is tied to the
active generation. Reconnecting invalidates the old catalog instead of relabeling old data as new.
Discovery values are normalized into detached, deeply frozen JSON under configurable item, byte,
depth, string, node, and property-fanout limits before they can enter a snapshot.

Diagnostic snapshots intentionally exclude transport factories, endpoints, OAuth objects, request
payloads, and raw error messages. Caller-supplied labels, tags, and upstream protocol metadata are
still application data; a public panel should apply its own authorization, redaction, and display
bounds rather than expose these objects directly.

## Hubs and panel read models

```ts
import { McpHubDefinition, McpHubManager } from "kmcp/hub";

const hubs = new McpHubManager(manager);
hubs.register(
	new McpHubDefinition({
		id: "workspace",
		members: [{ connectionId: "github", namespace: "gh" }],
	}),
);

const snapshot = hubs.snapshot();
const catalog = await hubs.refreshCatalog("workspace");
const search = catalog.tools.find((tool) => tool.route === "gh.search_repositories");
if (search === undefined) throw new Error("GitHub search is unavailable");
await hubs.callTool("workspace", search, { query: "mcp" });
```

Hub routes are reversible: `<namespace>.<upstream-name>`. Resolution is checked against the exact
current catalog generation and fingerprint before execution. Pass the catalog route descriptor—as
above—to reject a stale panel action after reconnect; passing only its string intentionally means
“resolve this name against the current catalog.” Aggregate catalogs include tools, prompts, static
resources, and resource templates. Dynamic template reads are not guessed from arbitrary URIs.

Connection and hub subscriptions emit monotonic process-local revisions for live diagnostics; those
revisions are not durable replay cursors and do not by themselves provide race-free panel hydration.

`Kmcp`, `createKmcp()`, and `KmcpBuilder` compose one connection manager and hub manager when a
single application object is preferred.

## Node adapters

```ts
import { createServer } from "node:http";
import {
	createNodeMcpHandler,
	localhostHostValidation,
	localhostOriginValidation,
} from "kmcp/node";

const handleMcp = createNodeMcpHandler(server);
const host = localhostHostValidation();
const origin = localhostOriginValidation();

createServer((request, response) => {
	if (!host(request, response) || !origin(request, response)) return;
	void handleMcp(request, response);
}).listen(3000);
```

The returned Node handler is callable and retains the official handler's `fetch`, `close`, `notify`,
and `bus` controls, so applications can publish list-change notifications and close in-flight HTTP
work during shutdown. The Node entry point also exports `stdioConnection()`, `serveMcpStdio()`, and
the official v2 stdio transports. Authentication remains an application responsibility; the official
HTTP handler only passes validated `authInfo` through.

## Current boundary

This alpha is a coherent in-memory kernel, not yet a distributed control plane. It deliberately does
not claim durable desired state, SQL/Redis adapters, OAuth admission, multi-instance fencing, or a
protocol-facing gateway that projects an entire hub as one downstream MCP endpoint. Those belong
behind the store, policy, admission, and gateway seams described in
[ARCHITECTURE.md](./ARCHITECTURE.md).
