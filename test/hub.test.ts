import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import { ResourceTemplate, fromJsonSchema } from "@modelcontextprotocol/server";

import {
	KMCP_ERROR_CODES,
	McpConnectionManager,
	McpHubDefinition,
	McpHubManager,
	KmcpError,
	definePrompt,
	defineResource,
	defineResourceTemplate,
	defineServer,
	defineTool,
	inProcessConnection,
	type McpCatalogSnapshot,
	type KmcpErrorCode,
} from "../src/index.ts";
import type { McpProtocolEra } from "../src/internal/protocol.ts";
import { forEachEra } from "./helpers/in-process.ts";

const inputSchema = fromJsonSchema<{ value: string }>({
	type: "object",
	properties: { value: { type: "string" } },
	required: ["value"],
	additionalProperties: false,
});

interface HubFixture {
	readonly manager: McpConnectionManager<"alpha">;
	readonly hubs: McpHubManager<"main", "alpha">;
	readonly catalog: McpCatalogSnapshot;
}

async function createHubFixture(t: TestContext, era: McpProtocolEra): Promise<HubFixture> {
	const definition = defineServer(
		{ name: "hub-test", version: "1.0.0" },
		{
			capabilities: [
				defineTool("echo", { inputSchema }, async ({ value }) => ({
					content: [{ type: "text", text: value }],
				})),
				definePrompt("welcome", {}, async () => ({
					messages: [{ role: "user", content: { type: "text", text: "Welcome" } }],
				})),
				defineResource("status", "status://current", {}, async (uri) => ({
					contents: [{ uri: uri.href, text: "ok" }],
				})),
				defineResourceTemplate(
					"dynamic-status",
					new ResourceTemplate("status://items/{id}", { list: undefined }),
					{},
					async (uri) => ({ contents: [{ uri: uri.href, text: "dynamic" }] }),
				),
			],
		},
	);
	const manager = new McpConnectionManager<"alpha">();
	manager.register(inProcessConnection({ id: "alpha", definition, era }));
	await manager.connect("alpha");
	const catalog = await manager.refreshCatalog("alpha");
	const hubs = new McpHubManager<"main", "alpha">(manager);
	hubs.register(
		new McpHubDefinition({
			id: "main",
			members: [{ connectionId: "alpha", namespace: "primary" }],
		}),
	);

	t.after(async () => {
		hubs.close();
		await manager.close().catch(() => undefined);
	});
	return { manager, hubs, catalog };
}

forEachEra(
	"hub routes are exact, fresh catalog admissions fenced by generation and fingerprint",
	async (era, t) => {
		const { manager, hubs, catalog } = await createHubFixture(t, era);
		const projected = hubs.catalog("main");
		const toolRoute = projected.tools[0];
		const promptRoute = projected.prompts[0];
		const resourceRoute = projected.resources[0];
		const resourceTemplateRoute = projected.resourceTemplates[0];

		assert.ok(toolRoute);
		assert.ok(promptRoute);
		assert.ok(resourceRoute);
		assert.ok(resourceTemplateRoute);
		assert.equal(toolRoute.route, "primary.echo");
		assert.equal(toolRoute.generation, catalog.generation);
		assert.equal(toolRoute.catalogFingerprint, catalog.fingerprint);
		assert.equal(promptRoute.route, "primary.welcome");
		assert.equal(promptRoute.generation, catalog.generation);
		assert.equal(promptRoute.catalogFingerprint, catalog.fingerprint);
		assert.equal(resourceRoute.route, "primary:status://current");
		assert.equal(resourceRoute.catalogFingerprint, catalog.fingerprint);
		assert.equal(resourceTemplateRoute.route, "primary:status://items/{id}");
		assert.equal(resourceTemplateRoute.catalogFingerprint, catalog.fingerprint);

		const toolResult = await hubs.callTool("main", toolRoute, { value: "hello" });
		assert.equal(toolResult.content[0]?.type, "text");
		assert.equal((await hubs.getPrompt("main", promptRoute, undefined)).messages.length, 1);
		assert.equal(
			(await hubs.readResource("main", resourceRoute)).contents[0]?.uri,
			"status://current",
		);

		assert.throws(
			() => void hubs.callTool("main", "primary.missing"),
			hasCode(KMCP_ERROR_CODES.HUB_ROUTE_UNKNOWN),
		);
		assert.throws(
			() => void hubs.getPrompt("main", "primary.missing", undefined),
			hasCode(KMCP_ERROR_CODES.HUB_ROUTE_UNKNOWN),
		);
		// Template expansions resolve through the member's listed templates; other URIs do not.
		const expanded = await hubs.readResource("main", "primary", "status://items/42");
		assert.equal(expanded.contents[0]?.uri, "status://items/42");
		assert.throws(
			() => void hubs.readResource("main", "primary", "status://unknown/42"),
			hasCode(KMCP_ERROR_CODES.HUB_ROUTE_UNKNOWN),
		);

		const reason = new Error("cancelled");
		const controller = new AbortController();
		controller.abort(reason);
		assert.throws(
			() => void hubs.callTool("main", "primary.echo", {}, { signal: controller.signal }),
			(error: unknown) => error === reason,
		);
		await assert.rejects(
			hubs.refreshCatalog("main", controller.signal),
			(error: unknown) => error === reason,
		);

		await manager.disconnect("alpha");
		assert.equal(hubs.catalog("main").tools.length, 0);
		assert.equal(hubs.catalog("main").resources.length, 0);
		await manager.connect("alpha");
		await manager.refreshCatalog("alpha");
		assert.throws(
			() => void hubs.callTool("main", toolRoute, { value: "stale" }),
			hasCode(KMCP_ERROR_CODES.HUB_ROUTE_UNKNOWN),
		);
		assert.throws(
			() => void hubs.getPrompt("main", promptRoute, undefined),
			hasCode(KMCP_ERROR_CODES.HUB_ROUTE_UNKNOWN),
		);
		assert.throws(
			() => void hubs.readResource("main", resourceRoute),
			hasCode(KMCP_ERROR_CODES.HUB_ROUTE_UNKNOWN),
		);
		assert.equal(
			(await hubs.callTool("main", "primary.echo", { value: "current" })).content[0]?.type,
			"text",
		);
	},
);

forEachEra(
	"a hub refresh rejects if its captured definition is replaced in flight",
	async (era, t) => {
		const { manager, hubs } = await createHubFixture(t, era);
		const originalRefresh = manager.refreshCatalog.bind(manager);
		let release!: () => void;
		let markEntered!: () => void;
		const blocker = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		const delayedRefresh: typeof manager.refreshCatalog = async (id, signal, control) => {
			markEntered();
			await blocker;
			return originalRefresh(id, signal, control);
		};
		t.mock.method(manager, "refreshCatalog", delayedRefresh);

		const refresh = hubs.refreshCatalog("main");
		await entered;
		hubs.update(
			new McpHubDefinition({
				id: "main",
				label: "replacement",
				members: [{ connectionId: "alpha", namespace: "primary" }],
			}),
		);
		release();
		await assert.rejects(refresh, hasCode(KMCP_ERROR_CODES.HUB_REVISION_CONFLICT));
	},
);

forEachEra("hub close is idempotent and guards lifecycle and routed operations", async (era, t) => {
	const { hubs } = await createHubFixture(t, era);
	hubs.close();
	hubs.close();

	assert.equal(hubs.closed, true);
	assert.equal(hubs.snapshot().closed, true);
	assert.equal(hubs.state("main").id, "main");
	assert.throws(() => hubs.remove("main"), hasCode(KMCP_ERROR_CODES.MANAGER_CLOSED));
	assert.throws(
		() => void hubs.callTool("main", "primary.echo"),
		hasCode(KMCP_ERROR_CODES.MANAGER_CLOSED),
	);
	assert.throws(
		() => void hubs.getPrompt("main", "primary.welcome", undefined),
		hasCode(KMCP_ERROR_CODES.MANAGER_CLOSED),
	);
	assert.throws(
		() => void hubs.readResource("main", "primary", "status://current"),
		hasCode(KMCP_ERROR_CODES.MANAGER_CLOSED),
	);
	assert.throws(() => hubs.subscribe(() => undefined), hasCode(KMCP_ERROR_CODES.MANAGER_CLOSED));
	await assert.rejects(hubs.refreshCatalog("main"), hasCode(KMCP_ERROR_CODES.MANAGER_CLOSED));
});

function hasCode(code: KmcpErrorCode): (error: unknown) => boolean {
	return (error) => error instanceof KmcpError && error.code === code;
}
