/**
 * Conformance fixture — the everything server projected through a `kmcp/gateway`.
 *
 * The upstream is the same `everything-server.ts` definition, connected in-process on the modern
 * (2026-07-28) era, aggregated by a hub under the namespace `up`, and re-served downstream by a
 * gateway with `names: "passthrough"` / `resources: "passthrough"` so the scenarios' fixed
 * tool/prompt/resource names survive the projection and every forwarding path (content types,
 * progress, completions, template reads, the MRTR relay) is exercised for real. What the gateway
 * deliberately does not forward (logging, resource-update subscriptions) is baselined in
 * `conformance-baseline-gateway.yml`.
 *
 *   PORT=39751 node --experimental-strip-types test/conformance/gateway-fixture.ts
 */
import { createServer } from "node:http";

import { McpConnectionManager, inProcessConnection } from "../../src/client.ts";
import { defineGateway } from "../../src/gateway.ts";
import { McpHubDefinition, McpHubManager } from "../../src/hub.ts";
import {
	createNodeMcpHandler,
	localhostHostValidation,
	localhostOriginValidation,
} from "../../src/node.ts";
import { changeNotifier, definition } from "./everything-server.ts";

/** The upstream serves in-process; capture its handler so the trigger tools can publish. */
const upstream: typeof definition = {
	handler(options) {
		const handler = definition.handler(options);
		changeNotifier.tools = () => handler.notify.toolsChanged();
		changeNotifier.prompts = () => handler.notify.promptsChanged();
		return handler;
	},
	instantiate: definition.instantiate.bind(definition),
} as typeof definition;

const manager = new McpConnectionManager<"up">();
manager.register(
	inProcessConnection({
		id: "up",
		definition: upstream,
		era: "modern",
		autoRefreshCatalog: { debounceMs: 0, minIntervalMs: 0 },
	}),
);
await manager.connect("up");
const hubs = new McpHubManager<"main", "up">(manager);
hubs.register(
	new McpHubDefinition({ id: "main", members: [{ connectionId: "up", namespace: "up" }] }),
);
await hubs.refreshCatalog("main");

const gateway = defineGateway({
	hubs,
	hubId: "main",
	serverInfo: { name: "kmcp-gateway", version: "1.0.0" },
	instructions: "The kmcp conformance fixture behind a gateway (passthrough names).",
	policy: { names: "passthrough", resources: "passthrough" },
});
const watching = gateway.start();

const port = Number.parseInt(process.env["PORT"] ?? "39751", 10);
const path = "/mcp";
const handleMcp = createNodeMcpHandler(gateway);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const httpServer = createServer((request, response) => {
	if (!validateHost(request, response) || !validateOrigin(request, response)) return;
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	if (url.pathname !== path) {
		response.writeHead(404, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ error: "not found" }));
		return;
	}
	void handleMcp(request, response);
});

const shutdown = (): void => {
	void handleMcp
		.close()
		.finally(() => watching.close())
		.finally(() => {
			hubs.close();
			return manager.close();
		})
		.finally(() => httpServer.close());
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

httpServer.listen(port, "127.0.0.1", () => {
	const address = httpServer.address();
	const bound = typeof address === "object" && address !== null ? address.port : port;
	process.stdout.write(`listening on http://127.0.0.1:${bound}${path}\n`);
});
