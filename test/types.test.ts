import { fromJsonSchema, type McpServer, type ServerContext } from "@modelcontextprotocol/server";

import {
	McpPrompt,
	McpPromptDefinition,
	McpCapabilityDefinition,
	McpServerBuilder,
	McpTool,
	McpToolDefinition,
	definePrompt,
	defineTool,
	type McpPromptOptions,
	type McpToolOptions,
} from "../src/server.ts";

class ExternallyUnconstructableCapability extends McpCapabilityDefinition<"tool", "external"> {
	constructor() {
		// @ts-expect-error The canonical capability construction token is module-private and required.
		super("tool", "external");
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

	override withAuth(): never {
		throw new Error("not authorizable");
	}
}

void ExternallyUnconstructableCapability;

const schema = fromJsonSchema<{ count: number }>({
	type: "object",
	properties: { count: { type: "number" } },
	required: ["count"],
});

const outputSchema = fromJsonSchema<{ answer: number }>({
	type: "object",
	properties: { answer: { type: "number" } },
	required: ["answer"],
});

const counted = defineTool("count", { inputSchema: schema }, async ({ count }) => ({
	content: [{ type: "text", text: String(count) }],
}));

const schemaHandler = async ({ count }: { count: number }, _context: ServerContext) => ({
	content: [{ type: "text" as const, text: String(count) }],
});

// @ts-expect-error A schema generic requires the matching runtime inputSchema.
defineTool<"missing-schema", typeof schema>("missing-schema", {}, schemaHandler);

// @ts-expect-error Class authoring cannot claim a schema while omitting it at runtime.
new McpToolDefinition<"missing-schema", typeof schema>("missing-schema", {}, schemaHandler);

// @ts-expect-error Ambiguous schema-or-undefined generics are intentionally uninhabitable.
defineTool<"ambiguous", typeof schema | undefined>("ambiguous", {}, schemaHandler);

// @ts-expect-error exactOptionalPropertyTypes rejects an explicit undefined schema slot.
defineTool("explicit-undefined", { inputSchema: undefined }, async () => ({ content: [] }));

// @ts-expect-error A schema-specialized options type requires inputSchema.
const missingToolOptions: McpToolOptions<typeof schema> = {};
void missingToolOptions;

const promptHandler = async ({ count }: { count: number }, _context: ServerContext) => ({
	messages: [{ role: "user" as const, content: { type: "text" as const, text: String(count) } }],
});

// @ts-expect-error A prompt schema generic requires the matching runtime argsSchema.
definePrompt<"missing-prompt-schema", typeof schema>("missing-prompt-schema", {}, promptHandler);

new McpPromptDefinition<"missing-prompt-schema", typeof schema>(
	"missing-prompt-schema",
	// @ts-expect-error Class prompt authoring cannot claim a schema while omitting it.
	{},
	promptHandler,
);

// @ts-expect-error A schema-specialized prompt options type requires argsSchema.
const missingPromptOptions: McpPromptOptions<typeof schema> = {};
void missingPromptOptions;

defineTool("typed-output", { outputSchema }, async () => ({
	content: [],
	structuredContent: { answer: 42 },
}));

defineTool("typed-error", { outputSchema }, async () => ({
	content: [],
	isError: true,
}));

// @ts-expect-error Successful output-schema tools must return structuredContent.
defineTool("missing-output", { outputSchema }, async () => ({ content: [] }));

// @ts-expect-error structuredContent must match the output schema's accepted input.
defineTool("invalid-output", { outputSchema }, async () => ({
	content: [],
	structuredContent: { answer: "wrong" },
}));

// @ts-expect-error Functional handlers cannot influence or widen schema inference.
defineTool("invalid", { inputSchema: schema }, async (input: { count: string }) => ({
	content: [{ type: "text", text: input.count }],
}));

McpServerBuilder.create({ name: "types", version: "1.0.0" }).add(counted);
McpServerBuilder.create({ name: "types", version: "1.0.0" }).tool(counted);

const builderWithCount = McpServerBuilder.create({ name: "types", version: "1.0.0" }).add(counted);

// @ts-expect-error Builder key state is invariant and cannot be erased by widening.
const erasedBuilder: McpServerBuilder = builderWithCount;
void erasedBuilder;

// @ts-expect-error The same capability key cannot be added twice to one typed builder.
McpServerBuilder.create({ name: "types", version: "1.0.0" }).add(counted).add(counted);

class InvalidDecoratedTool {
	// @ts-expect-error The decorated handler must accept the schema's parsed output.
	@McpTool({ name: "count", inputSchema: schema })
	async count(input: { count: string }) {
		return { content: [{ type: "text" as const, text: input.count }] };
	}
}

class ExplicitlyInvalidDecoratedTool {
	// @ts-expect-error Explicit schema generics still require the runtime inputSchema.
	@McpTool<"count", typeof schema>({ name: "count" })
	async count(input: { count: number }) {
		return { content: [{ type: "text" as const, text: String(input.count) }] };
	}

	// @ts-expect-error Explicit prompt schema generics still require argsSchema.
	@McpPrompt<"count-prompt", typeof schema>({ name: "count-prompt" })
	async prompt(input: { count: number }) {
		return {
			messages: [
				{ role: "user" as const, content: { type: "text" as const, text: String(input.count) } },
			],
		};
	}
}

class InvalidDecoratedOutput {
	// @ts-expect-error Decorated structuredContent must match outputSchema.
	@McpTool({ name: "typed-output", outputSchema })
	async output() {
		return { content: [], structuredContent: { answer: "wrong" } };
	}
}

// @ts-expect-error Canonical definitions carry a private nominal identity.
const forgedDefinition: typeof counted = {
	kind: counted.kind,
	name: counted.name,
	options: counted.options,
	handler: counted.handler,
	install: counted.install.bind(counted),
};
void forgedDefinition;

const deeplyReadonly = defineTool(
	"deeply-readonly",
	{ icons: [{ src: "icon.svg", sizes: ["16x16"] }] },
	async () => ({ content: [] }),
);

function assertDeepReadonlyTypes(): void {
	// @ts-expect-error Published protocol metadata is deeply readonly.
	deeplyReadonly.options.icons[0].src = "changed.svg";

	// @ts-expect-error Nested protocol metadata arrays are deeply readonly.
	deeplyReadonly.options.icons[0].sizes?.push("32x32");
}
void assertDeepReadonlyTypes;

void InvalidDecoratedTool;
void ExplicitlyInvalidDecoratedTool;
void InvalidDecoratedOutput;

// --- MCP v2 absorption surface (middleware, auth checks, reconnect, events) ---

import type { CallToolResult } from "@modelcontextprotocol/server";
import type {
	McpAuthCheck,
	McpCapabilityProvider,
	McpConnectionDefinitionOptions,
	McpConnectionEvent,
	McpMiddleware,
	McpParsedToolResult,
} from "../src/index.ts";
import { transformTool, type AnyMcpToolDefinition } from "../src/index.ts";

const passthroughMiddleware: McpMiddleware = (context, next) => next(context);
void passthroughMiddleware;

async function middlewareResultIsUnknown(next: () => Promise<unknown>): Promise<void> {
	// @ts-expect-error A middleware result is `unknown` until the caller narrows it.
	const typed: CallToolResult = await next();
	void typed;
}
void middlewareResultIsUnknown;

const scopeAwareCheck: McpAuthCheck = () => ({
	allowed: false,
	reason: "no",
	missingScopes: ["a"],
});
void scopeAwareCheck;
// @ts-expect-error An auth check verdict cannot be a bare string.
const invalidCheck: McpAuthCheck = () => "denied";
void invalidCheck;

// @ts-expect-error A capability provider must return capability definitions.
const invalidProvider: McpCapabilityProvider = () => [{ name: "loose" }];
void invalidProvider;

function transformKeepsToolShape(tool: AnyMcpToolDefinition): AnyMcpToolDefinition {
	return transformTool(tool, { description: "still a tool" });
}
void transformKeepsToolShape;

function reconnectRequiresBackoff(): McpConnectionDefinitionOptions<"id">["reconnect"] {
	// @ts-expect-error reconnect requires a backoff block.
	return { maxAttempts: 3 };
}
void reconnectRequiresBackoff;

function resourceEventUriIsOptional(event: McpConnectionEvent): string | undefined {
	return event.resource?.uri;
}
void resourceEventUriIsOptional;

function parsedResultIsFrozenShaped(result: McpParsedToolResult): boolean {
	// @ts-expect-error Parsed results are read-only.
	result.isError = false;
	return result.isError;
}
void parsedResultIsFrozenShaped;
