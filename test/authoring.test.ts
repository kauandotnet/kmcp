import assert from "node:assert/strict";
import test from "node:test";

import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";

import { KMCP_ERROR_CODES, KmcpError } from "../src/errors.ts";
import {
	McpServerApp,
	McpServerBuilder,
	McpServerDefinition,
	McpCapabilityDefinition,
	McpTool,
	McpToolDefinition,
	capabilitiesOf,
	definePrompt,
	defineResource,
	defineTool,
	serverFrom,
} from "../src/server.ts";
import { createTestClient, forEachEra } from "./helpers/in-process.ts";

const greetingInput = fromJsonSchema<{ name: string }>({
	type: "object",
	properties: { name: { type: "string" } },
	required: ["name"],
	additionalProperties: false,
});

forEachEra("functional and builder authoring lower to official SDK v2 classes", async (era) => {
	const tool = defineTool(
		"greet",
		{ description: "Greets someone", inputSchema: greetingInput },
		async ({ name }) => ({ content: [{ type: "text", text: `Hello ${name}` }] }),
	);
	const prompt = definePrompt("welcome", {}, async () => ({
		messages: [{ role: "user", content: { type: "text", text: "Say hello" } }],
	}));
	const resource = defineResource("status", "status://current", {}, async (uri) => ({
		contents: [{ uri: uri.href, text: "ok" }],
	}));

	assert.ok(tool instanceof McpToolDefinition);
	const definition = McpServerBuilder.create({ name: "authoring-test", version: "1.0.0" })
		.add(tool)
		.add(prompt)
		.add(resource)
		.build();
	assert.ok(definition instanceof McpServerDefinition);
	const runtime = await definition.instantiate({ era });
	assert.equal(runtime.registrations.length, 3);
	await runtime.close();

	const { client, close } = await createTestClient(definition, { era });
	try {
		const tools = await client.listTools();
		assert.deepEqual(
			tools.tools.map(({ name }) => name),
			["greet"],
		);
		const result = await client.callTool({ name: "greet", arguments: { name: "Ada" } });
		assert.equal(result.content[0]?.type, "text");
		if (result.content[0]?.type === "text") assert.equal(result.content[0].text, "Hello Ada");
		assert.equal((await client.getPrompt({ name: "welcome" })).messages.length, 1);
		assert.equal(
			(await client.readResource({ uri: "status://current" })).contents[0]?.uri,
			"status://current",
		);
	} finally {
		await close();
	}
});

test("standard decorators materialize the same canonical capability classes per instance", () => {
	@McpServerApp({ serverInfo: { name: "decorated", version: "1.0.0" } })
	class DecoratedServer {
		readonly prefix: string;

		constructor(prefix: string) {
			this.prefix = prefix;
		}

		@McpTool({ name: "greet", inputSchema: greetingInput })
		async greet({ name }: { name: string }) {
			return { content: [{ type: "text" as const, text: `${this.prefix} ${name}` }] };
		}
	}

	const first = new DecoratedServer("Hello");
	const second = new DecoratedServer("Hi");
	const firstCapabilities = capabilitiesOf(first);
	assert.strictEqual(capabilitiesOf(first), firstCapabilities);
	assert.ok(firstCapabilities[0] instanceof McpToolDefinition);
	assert.notStrictEqual(firstCapabilities[0], capabilitiesOf(second)[0]);
	assert.ok(serverFrom(first) instanceof McpServerDefinition);
});

test("protocol metadata is detached and deeply frozen while runtime objects stay live", () => {
	const icons = [{ src: "before.svg", sizes: ["16x16"] }];
	const annotations = { title: "Before", readOnlyHint: true };
	const metadata = { nested: { owner: "before" } };
	const handler = async ({ name }: { name: string }) => ({
		content: [{ type: "text" as const, text: name }],
	});
	const tool = defineTool(
		"immutable",
		{ inputSchema: greetingInput, annotations, icons, _meta: metadata },
		handler,
	);

	icons[0]!.src = "after.svg";
	icons[0]!.sizes.push("32x32");
	annotations.title = "After";
	metadata.nested.owner = "after";

	assert.strictEqual(tool.options.inputSchema, greetingInput);
	assert.strictEqual(tool.handler, handler);
	const publishedIcons = tool.options.icons;
	assert.ok(publishedIcons);
	assert.equal(publishedIcons[0]?.src, "before.svg");
	assert.deepEqual(publishedIcons[0]?.sizes, ["16x16"]);
	assert.equal(tool.options.annotations?.title, "Before");
	assert.deepEqual(tool.options._meta, { nested: { owner: "before" } });
	assert.ok(Object.isFrozen(tool.options));
	assert.ok(Object.isFrozen(publishedIcons));
	assert.ok(Object.isFrozen(publishedIcons[0]));
	assert.ok(Object.isFrozen(publishedIcons[0]?.sizes));
	assert.ok(Object.isFrozen(tool.options._meta));
	assert.ok(Object.isFrozen((tool.options._meta as { nested: object }).nested));

	const cacheHint = { ttlMs: 50, cacheScope: "private" as const };
	const resource = defineResource("cached", "status://cached", { cacheHint }, async (uri) => ({
		contents: [{ uri: uri.href, text: "cached" }],
	}));
	cacheHint.ttlMs = 500;
	assert.equal(resource.options.cacheHint?.ttlMs, 50);
	assert.ok(Object.isFrozen(resource.options.cacheHint));

	const serverInfo = {
		name: "metadata-server",
		version: "1.0.0",
		icons: [{ src: "server-before.svg", sizes: ["16x16"] }],
	};
	const server = new McpServerDefinition(serverInfo);
	serverInfo.icons[0]!.src = "server-after.svg";
	serverInfo.icons[0]!.sizes.push("32x32");
	assert.equal(server.serverInfo.icons?.[0]?.src, "server-before.svg");
	assert.deepEqual(server.serverInfo.icons?.[0]?.sizes, ["16x16"]);
	assert.ok(Object.isFrozen(server.serverInfo.icons?.[0]?.sizes));

	assert.throws(
		() =>
			defineTool("invalid-metadata", { _meta: { callback: () => undefined } }, async () => ({
				content: [],
			})),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
});

test("server definitions reject structural and overridden capabilities", () => {
	const canonical = defineTool("canonical", {}, async () => ({ content: [] }));
	const structural = {
		kind: canonical.kind,
		name: canonical.name,
		options: canonical.options,
		handler: canonical.handler,
		install: canonical.install.bind(canonical),
	};

	assert.throws(
		() =>
			Reflect.construct(McpServerDefinition, [
				{ name: "structural", version: "1.0.0" },
				{ capabilities: [structural] },
			]),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);

	class OverriddenTool extends McpToolDefinition<"overridden"> {
		override install(server: McpServer) {
			return super.install(server);
		}
	}

	const overridden = new OverriddenTool("overridden", {}, async () => ({ content: [] }));
	assert.throws(
		() =>
			new McpServerDefinition(
				{ name: "overridden", version: "1.0.0" },
				{ capabilities: [overridden] },
			),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
});

test("the canonical capability base rejects forged external construction tokens", () => {
	class ForgedCapability extends McpCapabilityDefinition<"tool", "forged"> {
		constructor() {
			super("tool", "forged", undefined!);
		}

		override install(_server: McpServer): never {
			throw new Error("not installable");
		}

		override withName(): never {
			throw new Error("not renameable");
		}

		override withMetadata(): never {
			throw new Error("not patchable");
		}

		override readonly handler = undefined;

		override withHandler(): never {
			throw new Error("not decoratable");
		}
	}

	assert.throws(
		() => new ForgedCapability(),
		(error: unknown) =>
			error instanceof KmcpError && error.code === KMCP_ERROR_CODES.INVALID_DEFINITION,
	);
});

test("class decorator metadata follows a replacement constructor", () => {
	function Replace<Class extends new () => object>(value: Class): Class {
		function Replacement(this: object): object {
			return Reflect.construct(value, [], new.target);
		}
		Object.setPrototypeOf(Replacement, value);
		Replacement.prototype = Object.create(value.prototype, {
			constructor: { configurable: true, value: Replacement, writable: true },
		});
		return Replacement as unknown as Class;
	}

	@Replace
	@McpServerApp({ serverInfo: { name: "wrapped", version: "1.0.0" } })
	class WrappedServer {
		@McpTool({ name: "wrapped-tool" })
		async tool() {
			return { content: [] };
		}
	}

	const definition = serverFrom(new WrappedServer());
	assert.equal(definition.serverInfo.name, "wrapped");
	assert.equal(definition.capabilities[0]?.name, "wrapped-tool");
});

test("instantiate closes the partial server after install or setup failure", async () => {
	const originalClose = McpServer.prototype.close;
	const originalRegisterTool = Object.getOwnPropertyDescriptor(McpServer.prototype, "registerTool");
	assert.ok(originalRegisterTool);
	let closeCalls = 0;
	Object.defineProperty(McpServer.prototype, "close", {
		configurable: true,
		value: async function (this: McpServer): Promise<void> {
			closeCalls += 1;
			await originalClose.call(this);
		},
		writable: true,
	});

	try {
		const setupFailure = new Error("setup failed");
		const setupDefinition = new McpServerDefinition(
			{ name: "setup-failure", version: "1.0.0" },
			{ setup: () => Promise.reject(setupFailure) },
		);
		await assert.rejects(setupDefinition.instantiate({ era: "legacy" }), setupFailure);
		assert.equal(closeCalls, 1);

		const installFailure = new Error("install failed");
		Object.defineProperty(McpServer.prototype, "registerTool", {
			...originalRegisterTool,
			value: () => {
				throw installFailure;
			},
		});
		const installDefinition = new McpServerDefinition(
			{ name: "install-failure", version: "1.0.0" },
			{ capabilities: [defineTool("explode", {}, async () => ({ content: [] }))] },
		);
		await assert.rejects(installDefinition.instantiate({ era: "legacy" }), installFailure);
		assert.equal(closeCalls, 2);
	} finally {
		Object.defineProperty(McpServer.prototype, "close", {
			configurable: true,
			value: originalClose,
			writable: true,
		});
		Object.defineProperty(McpServer.prototype, "registerTool", originalRegisterTool);
	}
});
