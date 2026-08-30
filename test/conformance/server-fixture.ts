/**
 * Conformance fixture — the kmcp "everything server" over HTTP.
 *
 * Run it straight from source, no build step:
 *   PORT=39750 node --experimental-strip-types test/conformance/server-fixture.ts
 * It prints `listening on http://127.0.0.1:<port>/mcp` once ready; `scripts/conformance-server.mjs`
 * waits for exactly that line. The definition itself lives in `everything-server.ts`.
 */
import { createServer } from "node:http";

import {
	createNodeMcpHandler,
	localhostHostValidation,
	localhostOriginValidation,
} from "../../src/node.ts";
import { changeNotifier, definition } from "./everything-server.ts";

const port = Number.parseInt(process.env["PORT"] ?? "39750", 10);
const path = "/mcp";

const handleMcp = createNodeMcpHandler(definition);
// The SEP-2575 trigger tools publish through the live handler's listen bus.
changeNotifier.tools = () => handleMcp.notify.toolsChanged();
changeNotifier.prompts = () => handleMcp.notify.promptsChanged();
// dns-rebinding-protection: a non-localhost Host/Origin MUST be answered 4xx, a localhost one 2xx.
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
	// The SDK's `NodeIncomingMessageLike` declares `method?: string` / `url?: string`, which
	// `http.IncomingMessage` (`string | undefined`) does not satisfy under
	// `exactOptionalPropertyTypes`. Structurally identical at runtime; see the report note on
	// `src/node.ts` `McpNodeHandler`.
	void handleMcp(request as unknown as Parameters<typeof handleMcp>[0], response);
});

const shutdown = (): void => {
	void handleMcp.close().finally(() => httpServer.close());
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

httpServer.listen(port, "127.0.0.1", () => {
	const address = httpServer.address();
	const bound = typeof address === "object" && address !== null ? address.port : port;
	// The runner waits for exactly this line before starting the conformance suite.
	process.stdout.write(`listening on http://127.0.0.1:${bound}${path}\n`);
});
