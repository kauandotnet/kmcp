/**
 * Conformance fixture — the kmcp "everything server".
 *
 * A kmcp `defineServer` definition that implements every capability the official MCP conformance
 * suite exercises in *server* mode (`npx @modelcontextprotocol/conformance server`). The tool /
 * prompt / resource NAMES and the exact result shapes are dictated by the scenario contract: each
 * scenario embeds its "Server Implementation Requirements" in its description. Enumerate them with
 * `npx --yes @modelcontextprotocol/conformance@0.1.16 list --server`.
 *
 * The fixture is dual-era by construction: `createNodeMcpHandler` serves the modern 2026-07-28 era
 * and the 2025 legacy era from the same definition. Conformance 0.1.16 connects as a 2025-11-25
 * client, so the suite exercises the legacy path — including the SDK's legacy multi-round-trip
 * shim, which turns the `inputRequired(...)` returns below into real server-to-client
 * `elicitation/create` / `sampling/createMessage` requests plus handler re-entry. The handlers are
 * therefore written once, in the modern MRTR style, and serve both eras.
 *
 * NOT exercised here: the `io.modelcontextprotocol/tasks` extension. Tasks are legacy-only on the
 * modern wire (the 2026 codec strips `execution.taskSupport` / `capabilities.tasks`) and kmcp does
 * not wire them; conformance 0.1.16 ships no task server scenarios either.
 *
 * This module only exports the definition; `server-fixture.ts` serves it directly and
 * `gateway-fixture.ts` serves it through a `kmcp/gateway` projection.
 */
import {
	acceptedContent,
	audioContent,
	createRequestStateCodec,
	defineServer,
	definePrompt,
	defineResource,
	defineResourceTemplate,
	defineTool,
	embeddedTextResource,
	errorResult,
	fromJsonSchema,
	imageContent,
	clientIdentity,
	inputRequired,
	inputResponse,
	jsonResult,
	log,
	progress,
	promptResult,
	resourceResult,
	textContent,
	toolResult,
	userMessage,
	type CallToolResult,
	type InputRequest,
	type InputRequiredResult,
	type ServerContext,
} from "../../src/server.ts";

// --- Test assets ---------------------------------------------------------------------------
// A 1x1 red PNG and a minimal (silent) 16-bit mono WAV, base64-encoded. The image/audio scenarios
// only check the content-block shape and `mimeType`, so a byte-minimal but valid asset suffices.
const PNG_1X1_RED =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const WAV_SILENCE =
	"UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `requestState` round-trips through the client and comes back attacker-controlled. The SDK
 * applies no integrity protection by default, so the fixture seals it with the SDK's HMAC codec
 * and drops `codec.verify` into the handler's `requestState.verify` hook — the shape a real MRTR
 * server is required to have (spec: basic/patterns/mrtr, server requirements 4–5). The key is
 * per-process because one process serves every round of a flow here.
 */
const requestStateCodec = createRequestStateCodec<{
	readonly tool: string;
	readonly round?: number;
}>({
	key: new Uint8Array(32).fill(7),
});

// =============================================================================================
// Tools — content types
// =============================================================================================

// tools-call-simple-text
const simpleText = defineTool(
	"test_simple_text",
	{ description: "Returns a simple text content block." },
	async () => toolResult(textContent("This is a simple text response for testing.")),
);

// tools-call-image
const imageContentTool = defineTool(
	"test_image_content",
	{ description: "Returns an image content block." },
	async () => toolResult(imageContent(PNG_1X1_RED, "image/png")),
);

// tools-call-audio
const audioContentTool = defineTool(
	"test_audio_content",
	{ description: "Returns an audio content block." },
	async () => toolResult(audioContent(WAV_SILENCE, "audio/wav")),
);

// tools-call-embedded-resource
const embeddedResourceTool = defineTool(
	"test_embedded_resource",
	{ description: "Returns an embedded resource content block." },
	async () =>
		toolResult(
			embeddedTextResource("test://embedded-resource", "This is an embedded resource content.", {
				mimeType: "text/plain",
			}),
		),
);

// tools-call-mixed-content
const mixedContentTool = defineTool(
	"test_multiple_content_types",
	{ description: "Returns text, image, and embedded-resource content blocks." },
	async () =>
		toolResult(
			textContent("Multiple content types test:"),
			imageContent(PNG_1X1_RED, "image/png"),
			embeddedTextResource(
				"test://mixed-content-resource",
				JSON.stringify({ test: "data", value: 123 }),
				{ mimeType: "application/json" },
			),
		),
);

// =============================================================================================
// Tools — logging, errors, progress
// =============================================================================================

// tools-call-with-logging — three info-level messages, spaced so the client sees them mid-call.
const loggingTool = defineTool(
	"test_tool_with_logging",
	{ description: "Emits log notifications during execution." },
	async (ctx) => {
		const logger = log(ctx);
		await logger.info("Tool execution started");
		await sleep(50);
		await logger.info("Tool processing data");
		await sleep(50);
		await logger.info("Tool execution completed");
		return toolResult(textContent("Tool with logging executed."));
	},
);

// tools-call-error — a tool-level error result (`isError: true`), not a JSON-RPC error.
const errorTool = defineTool(
	"test_error_handling",
	{ description: "Always returns a tool-level error result." },
	async () => errorResult("This tool intentionally returns an error for testing"),
);

// tools-call-with-progress — `progress(ctx)` is a no-op unless the request carried a progressToken.
const progressTool = defineTool(
	"test_tool_with_progress",
	{ description: "Reports progress notifications during execution." },
	async (ctx) => {
		const report = progress(ctx);
		await report(0, 100);
		await sleep(50);
		await report(50, 100);
		await sleep(50);
		await report(100, 100);
		return toolResult(textContent("Tool with progress executed."));
	},
);

// =============================================================================================
// Tools — multi-round-trip (sampling and elicitation)
// =============================================================================================

/** Mints the fixture's integrity-protected `requestState` for one MRTR round. */
function roundState(tool: string, ctx: ServerContext): Promise<string> {
	return requestStateCodec.mint({ tool }, ctx);
}

function isTextBlock(value: unknown): value is { readonly type: "text"; readonly text: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { type?: unknown }).type === "text" &&
		typeof (value as { text?: unknown }).text === "string"
	);
}

// tools-call-sampling — asks the client's LLM to complete a prompt. On the 2026 wire the client
// fulfils the embedded request and retries; on the 2025 wire the SDK's legacy shim turns it into a
// real `sampling/createMessage` round trip. Same handler either way.
const samplingTool = defineTool(
	"test_sampling",
	{
		description: "Requests an LLM completion from the client via sampling.",
		inputSchema: fromJsonSchema<{ prompt: string }>({
			type: "object",
			properties: { prompt: { type: "string", description: "The prompt to send to the LLM" } },
			required: ["prompt"],
			additionalProperties: false,
		}),
	},
	async ({ prompt }, ctx): Promise<CallToolResult | InputRequiredResult> => {
		const view = inputResponse(ctx.mcpReq.inputResponses, "completion");
		if (view.kind === "missing") {
			return inputRequired({
				inputRequests: {
					completion: inputRequired.createMessage({
						messages: [{ role: "user", content: { type: "text", text: prompt } }],
						maxTokens: 100,
					}),
				},
				requestState: await roundState("test_sampling", ctx),
			});
		}
		if (view.kind !== "sampling") return errorResult("The client returned no sampling result.");
		// `content` is one block on `CreateMessageResult` and an array on the tool-calling variant.
		const raw: unknown = view.result.content;
		const blocks: readonly unknown[] = Array.isArray(raw) ? raw : [raw];
		const text = blocks.map((block) => (isTextBlock(block) ? block.text : "")).join("");
		return toolResult(textContent(`LLM response: ${text}`));
	},
);

// tools-call-elicitation — asks the client to collect user input through a form.
const elicitationTool = defineTool(
	"test_elicitation",
	{
		description: "Requests user input from the client via elicitation.",
		inputSchema: fromJsonSchema<{ message: string }>({
			type: "object",
			properties: { message: { type: "string", description: "The message to show the user" } },
			required: ["message"],
			additionalProperties: false,
		}),
	},
	async ({ message }, ctx): Promise<CallToolResult | InputRequiredResult> => {
		const view = inputResponse(ctx.mcpReq.inputResponses, "profile");
		if (view.kind === "missing") {
			return inputRequired({
				inputRequests: {
					profile: inputRequired.elicit({
						message,
						requestedSchema: {
							type: "object",
							properties: {
								username: { type: "string", description: "User's response" },
								email: { type: "string", description: "User's email address" },
							},
							required: ["username", "email"],
						},
					}),
				},
				requestState: await roundState("test_elicitation", ctx),
			});
		}
		if (view.kind !== "elicit") return errorResult("The client returned no elicitation result.");
		const content = acceptedContent(ctx.mcpReq.inputResponses, "profile") ?? {};
		return toolResult(
			textContent(`User response: action=${view.action}, content=${JSON.stringify(content)}`),
		);
	},
);

// elicitation-sep1034-defaults — every primitive type carries a `default`, forwarded verbatim.
const elicitationDefaultsTool = defineTool(
	"test_elicitation_sep1034_defaults",
	{ description: "Elicits input with per-field default values (SEP-1034)." },
	async (ctx): Promise<CallToolResult | InputRequiredResult> => {
		const view = inputResponse(ctx.mcpReq.inputResponses, "details");
		if (view.kind === "missing") {
			return inputRequired({
				inputRequests: {
					details: inputRequired.elicit({
						message: "Provide your details",
						requestedSchema: {
							type: "object",
							properties: {
								name: { type: "string", description: "Name", default: "John Doe" },
								age: { type: "integer", description: "Age", default: 30 },
								score: { type: "number", description: "Score", default: 95.5 },
								status: {
									type: "string",
									enum: ["active", "inactive", "pending"],
									default: "active",
								},
								verified: { type: "boolean", description: "Verified", default: true },
							},
						},
					}),
				},
				requestState: await roundState("test_elicitation_sep1034_defaults", ctx),
			});
		}
		if (view.kind !== "elicit") return errorResult("The client returned no elicitation result.");
		const content = acceptedContent(ctx.mcpReq.inputResponses, "details") ?? {};
		return toolResult(
			textContent(
				`Elicitation completed: action=${view.action}, content=${JSON.stringify(content)}`,
			),
		);
	},
);

// elicitation-sep1330-enums — all five enum variants in one requested schema.
const elicitationEnumsTool = defineTool(
	"test_elicitation_sep1330_enums",
	{ description: "Elicits input with all enum schema variants (SEP-1330)." },
	async (ctx): Promise<CallToolResult | InputRequiredResult> => {
		const view = inputResponse(ctx.mcpReq.inputResponses, "choices");
		if (view.kind === "missing") {
			return inputRequired({
				inputRequests: {
					choices: inputRequired.elicit({
						message: "Choose your options",
						requestedSchema: {
							type: "object",
							properties: {
								untitledSingle: { type: "string", enum: ["option1", "option2", "option3"] },
								titledSingle: {
									type: "string",
									oneOf: [
										{ const: "value1", title: "First Option" },
										{ const: "value2", title: "Second Option" },
									],
								},
								legacyEnum: {
									type: "string",
									enum: ["opt1", "opt2", "opt3"],
									enumNames: ["Option One", "Option Two", "Option Three"],
								},
								untitledMulti: {
									type: "array",
									items: { type: "string", enum: ["option1", "option2", "option3"] },
								},
								titledMulti: {
									type: "array",
									items: {
										anyOf: [
											{ const: "value1", title: "First Choice" },
											{ const: "value2", title: "Second Choice" },
										],
									},
								},
							},
						},
					}),
				},
				requestState: await roundState("test_elicitation_sep1330_enums", ctx),
			});
		}
		if (view.kind !== "elicit") return errorResult("The client returned no elicitation result.");
		const content = acceptedContent(ctx.mcpReq.inputResponses, "choices") ?? {};
		return toolResult(
			textContent(
				`Elicitation completed: action=${view.action}, content=${JSON.stringify(content)}`,
			),
		);
	},
);

// =============================================================================================
// Tools — JSON Schema 2020-12 preservation (SEP-1613) and structured output
// =============================================================================================

// json-schema-2020-12 — `fromJsonSchema` advertises the JSON verbatim, so `$schema`, `$defs` and
// `additionalProperties` survive into `tools/list`. The handler is never invoked by the scenario.
const jsonSchema2020Tool = defineTool(
	"json_schema_2020_12_tool",
	{
		description: "Tool with JSON Schema 2020-12 features",
		// The canonical SEP-1613/SEP-2106 fixture: `$schema`, `$defs` with `$anchor`, `$ref`,
		// top-level `allOf` with a nested `anyOf`, sibling `if`/`then`/`else`, and
		// `additionalProperties: false` — all advertised verbatim by `fromJsonSchema`.
		inputSchema: fromJsonSchema<{
			name?: string;
			address?: { street?: string; city?: string };
			contactMethod?: "email" | "phone";
			phone?: string;
			email?: string;
		}>({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			$defs: {
				address: {
					$anchor: "addressDef",
					type: "object",
					properties: { street: { type: "string" }, city: { type: "string" } },
				},
			},
			properties: {
				name: { type: "string" },
				address: { $ref: "#/$defs/address" },
				contactMethod: { type: "string", enum: ["phone", "email"] },
				phone: { type: "string" },
				email: { type: "string" },
			},
			allOf: [{ anyOf: [{ required: ["phone"] }, { required: ["email"] }] }],
			if: { properties: { contactMethod: { const: "phone" } }, required: ["contactMethod"] },
			then: { required: ["phone"] },
			else: { required: ["email"] },
			additionalProperties: false,
		}),
	},
	async () => toolResult(textContent("ok")),
);

// No 0.1.16 server scenario exercises structured output; this tool covers kmcp's `outputSchema` +
// `jsonResult` surface (the result populates both `structuredContent` and a JSON text block).
const structuredOutputTool = defineTool(
	"test_structured_output",
	{
		description: "Returns structured output validated against an output schema.",
		inputSchema: fromJsonSchema<{ city: string }>({
			type: "object",
			properties: { city: { type: "string" } },
			required: ["city"],
			additionalProperties: false,
		}),
		outputSchema: fromJsonSchema<{ city: string; tempC: number; conditions: string }>({
			type: "object",
			properties: {
				city: { type: "string" },
				tempC: { type: "number" },
				conditions: { type: "string" },
			},
			required: ["city", "tempC", "conditions"],
			additionalProperties: false,
		}),
	},
	async ({ city }) => jsonResult({ city, tempC: 21, conditions: "clear" }),
);

// server-sse-polling drives a raw POST `tools/call` for `test_reconnection` and then inspects the
// SSE stream (priming event, retry field, mid-call disconnect). The tool only has to exist.
const reconnectionTool = defineTool(
	"test_reconnection",
	{ description: "Returns a normal result; probed by the SSE polling scenario." },
	async () => toolResult(textContent("Reconnection test completed.")),
);

// =============================================================================================
// Resources — direct, binary, template
// =============================================================================================

// resources-read-text
const staticText = defineResource(
	"static-text",
	"test://static-text",
	{ description: "A static text resource", mimeType: "text/plain" },
	async (uri) =>
		resourceResult(uri.href, {
			text: "This is the content of the static text resource.",
			mimeType: "text/plain",
		}),
);

// resources-read-binary
const staticBinary = defineResource(
	"static-binary",
	"test://static-binary",
	{ description: "A static binary resource", mimeType: "image/png" },
	async (uri) => resourceResult(uri.href, { blob: PNG_1X1_RED, mimeType: "image/png" }),
);

// The resource `test_embedded_resource` embeds, also readable on its own.
const embeddedResource = defineResource(
	"embedded-resource",
	"test://embedded-resource",
	{ description: "An embeddable text resource", mimeType: "text/plain" },
	async (uri) =>
		resourceResult(uri.href, {
			text: "This is an embedded resource content.",
			mimeType: "text/plain",
		}),
);

// resources-subscribe / resources-unsubscribe target this URI.
const watchedResource = defineResource(
	"watched-resource",
	"test://watched-resource",
	{ description: "A resource clients can subscribe to", mimeType: "text/plain" },
	async (uri) =>
		resourceResult(uri.href, { text: "Watched resource content.", mimeType: "text/plain" }),
);

// resources-templates-read — `{id}` is substituted from the requested URI.
const templateResource = defineResourceTemplate(
	"template-data",
	"test://template/{id}/data",
	{
		description: "A resource template keyed by id",
		mimeType: "application/json",
		complete: { id: (value) => ["1", "10", "100", "123"].filter((id) => id.startsWith(value)) },
	},
	async (uri, variables) => {
		const raw = variables["id"];
		const id = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
		return resourceResult(uri.href, {
			text: JSON.stringify({ id, templateTest: true, data: `Data for ID: ${id}` }),
			mimeType: "application/json",
		});
	},
);

// =============================================================================================
// Prompts
// =============================================================================================

// prompts-get-simple
const simplePrompt = definePrompt(
	"test_simple_prompt",
	{ description: "A simple prompt with no arguments" },
	async () => promptResult(userMessage("This is a simple prompt for testing.")),
);

// prompts-get-with-args + completion-complete. The completion scenario calls
// `complete({ ref: { type: 'ref/prompt', name: 'test_prompt_with_arguments' },
// argument: { name: 'arg1', value: 'test' } })` and asserts `completion.values` is an array. kmcp
// serves `completion/complete` itself from this `complete` map, so it works for a `fromJsonSchema`
// prompt (the SDK's own handler only finds Zod `completable()` fields).
const argumentsPrompt = definePrompt(
	"test_prompt_with_arguments",
	{
		description: "A prompt with two required arguments",
		argsSchema: fromJsonSchema<{ arg1: string; arg2: string }>({
			type: "object",
			properties: {
				arg1: { type: "string", description: "First test argument" },
				arg2: { type: "string", description: "Second test argument" },
			},
			required: ["arg1", "arg2"],
			additionalProperties: false,
		}),
		complete: {
			arg1: (value) => ["testAlpha", "testBeta", "gamma"].filter((v) => v.startsWith(value)),
		},
	},
	async ({ arg1, arg2 }) =>
		promptResult(userMessage(`Prompt with arguments: arg1='${arg1}', arg2='${arg2}'`)),
);

// prompts-get-embedded-resource
const embeddedResourcePrompt = definePrompt(
	"test_prompt_with_embedded_resource",
	{
		description: "A prompt that embeds a resource",
		argsSchema: fromJsonSchema<{ resourceUri: string }>({
			type: "object",
			properties: {
				resourceUri: { type: "string", description: "URI of the resource to embed" },
			},
			required: ["resourceUri"],
			additionalProperties: false,
		}),
	},
	async ({ resourceUri }) =>
		promptResult([
			userMessage(
				embeddedTextResource(resourceUri, "Embedded resource content for testing.", {
					mimeType: "text/plain",
				}),
			),
			userMessage("Please process the embedded resource above."),
		]),
);

// prompts-get-with-image
const imagePrompt = definePrompt(
	"test_prompt_with_image",
	{ description: "A prompt that includes an image" },
	async () =>
		promptResult([
			userMessage(imageContent(PNG_1X1_RED, "image/png")),
			userMessage("Please analyze the image above."),
		]),
);

// =============================================================================================
// The definition
// =============================================================================================

// =============================================================================================
// 2026-07-28 scenarios — SEP-2322 input-required results (input-required-result-*)
// =============================================================================================

/** Validated `user_name` elicitation gate shared by the A1-family scenarios. */
function elicitName(message: string): InputRequiredResult {
	return inputRequired({
		inputRequests: {
			// The scenario asserts this literal key.
			user_name: inputRequired.elicit({
				message,
				requestedSchema: {
					type: "object",
					properties: { name: { type: "string", description: "Your name" } },
					required: ["name"],
				},
			}),
		},
	});
}

// input-required-result-basic-elicitation / -result-type / -missing-input-response /
// -ignore-extra-params / -validate-input all drive this one tool. Contract points: the
// inputRequests key is literally `user_name`; completion is gated on a VALID accepted response
// under that key (an unknown key or a malformed value re-requests via a fresh
// InputRequiredResult); no requestState is minted, so retries arrive without one.
const irElicitation = defineTool(
	"test_input_required_result_elicitation",
	{ description: "Requests the user name via an embedded elicitation and greets them." },
	async (ctx): Promise<CallToolResult | InputRequiredResult> => {
		const content = acceptedContent<{ name?: unknown }>(ctx.mcpReq.inputResponses, "user_name");
		if (content === undefined || typeof content.name !== "string") {
			return elicitName("What is your name?");
		}
		return toolResult(textContent(`Hello, ${content.name}!`));
	},
);

// input-required-result-basic-sampling — the key name is scenario-arbitrary.
const irSampling = defineTool(
	"test_input_required_result_sampling",
	{ description: "Requests one LLM completion via an embedded sampling request." },
	async (ctx): Promise<CallToolResult | InputRequiredResult> => {
		const view = inputResponse(ctx.mcpReq.inputResponses, "sample_request");
		if (view.kind !== "sampling") {
			return inputRequired({
				inputRequests: {
					sample_request: inputRequired.createMessage({
						messages: [
							{ role: "user", content: { type: "text", text: "What is the capital of France?" } },
						],
						maxTokens: 100,
					}),
				},
			});
		}
		const raw: unknown = view.result.content;
		const blocks: readonly unknown[] = Array.isArray(raw) ? raw : [raw];
		const text = blocks.map((block) => (isTextBlock(block) ? block.text : "")).join("");
		return toolResult(textContent(`Sampled: ${text}`));
	},
);

// input-required-result-basic-list-roots
const irListRoots = defineTool(
	"test_input_required_result_list_roots",
	{ description: "Requests the client's roots via an embedded roots/list request." },
	async (ctx): Promise<CallToolResult | InputRequiredResult> => {
		const view = inputResponse(ctx.mcpReq.inputResponses, "roots_request");
		if (view.kind !== "roots") {
			return inputRequired({
				inputRequests: { roots_request: inputRequired.listRoots() },
			});
		}
		const uris = view.roots.map((root) => root.uri).join(", ");
		return toolResult(textContent(`Roots: ${uris}`));
	},
);

// input-required-result-request-state — the round MUST carry a string requestState; it is
// minted (and later verified) by the fixture's HMAC codec.
const irRequestState = defineTool(
	"test_input_required_result_request_state",
	{ description: "Round-trips integrity-protected request state with a confirmation." },
	async (ctx): Promise<CallToolResult | InputRequiredResult> => {
		const content = acceptedContent<{ ok?: unknown }>(ctx.mcpReq.inputResponses, "confirm");
		if (content === undefined) {
			return inputRequired({
				inputRequests: {
					confirm: inputRequired.elicit({
						message: "Proceed?",
						requestedSchema: {
							type: "object",
							properties: { ok: { type: "boolean" } },
							required: ["ok"],
						},
					}),
				},
				requestState: await requestStateCodec.mint(
					{ tool: "test_input_required_result_request_state" },
					ctx,
				),
			});
		}
		return toolResult(textContent(`state-ok: confirmed=${String(content.ok)}`));
	},
);

// input-required-result-multiple-input-requests — one round carrying all three request kinds
// plus requestState; any-of completion once the responses arrive.
const irMultipleInputs = defineTool(
	"test_input_required_result_multiple_inputs",
	{ description: "Requests elicitation, sampling, and roots in a single round." },
	async (ctx): Promise<CallToolResult | InputRequiredResult> => {
		const name = acceptedContent<{ name?: unknown }>(ctx.mcpReq.inputResponses, "user_name");
		const sample = inputResponse(ctx.mcpReq.inputResponses, "greeting");
		const roots = inputResponse(ctx.mcpReq.inputResponses, "client_roots");
		if (name === undefined && sample.kind === "missing" && roots.kind === "missing") {
			return inputRequired({
				inputRequests: {
					user_name: inputRequired.elicit({
						message: "Name?",
						requestedSchema: {
							type: "object",
							properties: { name: { type: "string" } },
							required: ["name"],
						},
					}),
					greeting: inputRequired.createMessage({
						messages: [{ role: "user", content: { type: "text", text: "Say hello." } }],
						maxTokens: 50,
					}),
					client_roots: inputRequired.listRoots(),
				},
				requestState: await requestStateCodec.mint(
					{ tool: "test_input_required_result_multiple_inputs" },
					ctx,
				),
			});
		}
		return toolResult(textContent("All inputs received."));
	},
);

// input-required-result-multi-round — three rounds; the state changes every round (the round
// number is inside the signed payload) and the final round completes.
const irMultiRound = defineTool(
	"test_input_required_result_multi_round",
	{ description: "Collects input over two sequential rounds before completing." },
	async (ctx): Promise<CallToolResult | InputRequiredResult> => {
		const state = ctx.mcpReq.requestState<{ tool?: string; round?: number }>();
		const round = state?.round ?? 0;
		if (round === 0) {
			return inputRequired({
				inputRequests: {
					step1: inputRequired.elicit({
						message: "Step 1: your name?",
						requestedSchema: {
							type: "object",
							properties: { name: { type: "string" } },
							required: ["name"],
						},
					}),
				},
				requestState: await requestStateCodec.mint(
					{ tool: "test_input_required_result_multi_round", round: 1 },
					ctx,
				),
			});
		}
		if (round === 1) {
			return inputRequired({
				inputRequests: {
					step2: inputRequired.elicit({
						message: "Step 2: favourite colour?",
						requestedSchema: {
							type: "object",
							properties: { color: { type: "string" } },
							required: ["color"],
						},
					}),
				},
				requestState: await requestStateCodec.mint(
					{ tool: "test_input_required_result_multi_round", round: 2 },
					ctx,
				),
			});
		}
		return toolResult(textContent("Multi-round flow complete."));
	},
);

// input-required-result-tampered-state — the codec's `verify` hook (ServerOptions.requestState)
// rejects the tampered string before re-entry; the seam answers with a JSON-RPC error, which is
// exactly what the scenario requires. The handler itself never sees the tampered round.
const irTamperedState = defineTool(
	"test_input_required_result_tampered_state",
	{ description: "Round-trips signed state; tampered state is rejected at the seam." },
	async (ctx): Promise<CallToolResult | InputRequiredResult> => {
		const content = acceptedContent<{ ok?: unknown }>(ctx.mcpReq.inputResponses, "confirm");
		if (content === undefined) {
			return inputRequired({
				inputRequests: {
					confirm: inputRequired.elicit({
						message: "Confirm?",
						requestedSchema: {
							type: "object",
							properties: { ok: { type: "boolean" } },
							required: ["ok"],
						},
					}),
				},
				requestState: await requestStateCodec.mint(
					{ tool: "test_input_required_result_tampered_state" },
					ctx,
				),
			});
		}
		return toolResult(textContent("State verified."));
	},
);

// input-required-result-capability-check — only request kinds the CLIENT DECLARED (per-request
// `_meta` envelope) are embedded; with `{ sampling: {} }` the round is sampling-only.
const irCapabilities = defineTool(
	"test_input_required_result_capabilities",
	{ description: "Embeds only the input requests the client's declared capabilities allow." },
	async (ctx): Promise<CallToolResult | InputRequiredResult> => {
		const elicited = acceptedContent<Record<string, unknown>>(
			ctx.mcpReq.inputResponses,
			"elicit_input",
		);
		const sampled = inputResponse(ctx.mcpReq.inputResponses, "sample_input");
		if (elicited !== undefined || sampled.kind === "sampling") {
			return toolResult(textContent("Capability-scoped inputs received."));
		}
		const capabilities = clientIdentity(ctx).clientCapabilities ?? {};
		const requests: Record<string, InputRequest> = {};
		if (capabilities.elicitation !== undefined) {
			requests["elicit_input"] = inputRequired.elicit({
				message: "Provide input",
				requestedSchema: {
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
				},
			});
		}
		if (capabilities.sampling !== undefined) {
			requests["sample_input"] = inputRequired.createMessage({
				messages: [{ role: "user", content: { type: "text", text: "Say hi." } }],
				maxTokens: 50,
			});
		}
		if (Object.keys(requests).length === 0) {
			return toolResult(textContent("The client declared no input capabilities."));
		}
		return inputRequired({
			inputRequests: requests,
			requestState: await requestStateCodec.mint(
				{ tool: "test_input_required_result_capabilities" },
				ctx,
			),
		});
	},
);

// input-required-result-non-tool-request — MRTR on `prompts/get`.
const irPrompt = definePrompt(
	"test_input_required_result_prompt",
	{ description: "A prompt that elicits context before rendering." },
	async (ctx) => {
		const content = acceptedContent<{ context?: unknown }>(
			ctx.mcpReq.inputResponses,
			"user_context",
		);
		if (content === undefined || typeof content.context !== "string") {
			return inputRequired({
				inputRequests: {
					user_context: inputRequired.elicit({
						message: "What context should the prompt use?",
						requestedSchema: {
							type: "object",
							properties: { context: { type: "string" } },
							required: ["context"],
						},
					}),
				},
			});
		}
		return promptResult(userMessage(`Prompt with context: ${content.context}`));
	},
);

// =============================================================================================
// 2026-07-28 scenarios — SEP-2575 server-stateless probes
// =============================================================================================

// server-stateless (sep-2575-server-rejects-undeclared-capability): the handler embeds a
// sampling request; when the request's declared client capabilities lack `sampling`, the SDK
// seam answers -32021 with the required-capabilities data — the handler result never leaves.
const statelessMissingCapability = defineTool(
	"test_missing_capability",
	{ description: "Requires the sampling capability; rejected for clients that lack it." },
	async (ctx): Promise<CallToolResult | InputRequiredResult> => {
		const view = inputResponse(ctx.mcpReq.inputResponses, "sample");
		if (view.kind !== "sampling") {
			return inputRequired({
				inputRequests: {
					sample: inputRequired.createMessage({
						messages: [{ role: "user", content: { type: "text", text: "Ping." } }],
						maxTokens: 10,
					}),
				},
			});
		}
		return toolResult(textContent("Sampled."));
	},
);

// server-stateless (sep-2575-http-server-no-independent-requests-on-stream): the response
// stream must carry the InputRequiredResult, never a pushed `elicitation/create` request.
const statelessStreamingElicitation = defineTool(
	"test_streaming_elicitation",
	{ description: "Elicits via an input_required result — never a pushed server request." },
	async (ctx): Promise<CallToolResult | InputRequiredResult> => {
		const content = acceptedContent<{ answer?: unknown }>(ctx.mcpReq.inputResponses, "answer");
		if (content === undefined) {
			return inputRequired({
				inputRequests: {
					answer: inputRequired.elicit({
						message: "Answer?",
						requestedSchema: {
							type: "object",
							properties: { answer: { type: "string" } },
							required: ["answer"],
						},
					}),
				},
			});
		}
		return toolResult(textContent("Answered."));
	},
);

// server-stateless (sep-2575-server-no-log-without-loglevel): the log call below is suppressed
// by the SDK unless the request's `_meta` carried a logLevel.
const statelessLoggingTool = defineTool(
	"test_logging_tool",
	{ description: "Logs during execution; silent unless the request opted into logging." },
	async (ctx) => {
		const logger = log(ctx);
		await logger.info("test_logging_tool ran");
		return toolResult(textContent("Logging tool executed."));
	},
);

/**
 * Change-notification hooks for the SEP-2575 subscription checks. The serving entry wires this
 * to its live handler (`handleMcp.notify.*`) — a definition alone has no bus to publish to.
 */
export const changeNotifier: {
	tools?: () => unknown;
	prompts?: () => unknown;
} = {};

// server-stateless triggers: calling these MUST push the matching list_changed notification to
// every open `subscriptions/listen` stream whose filter asked for it.
const statelessTriggerToolChange = defineTool(
	"test_trigger_tool_change",
	{ description: "Publishes a tools/list_changed event to open listen streams." },
	async () => {
		await changeNotifier.tools?.();
		return toolResult(textContent("Tool list change published."));
	},
);

const statelessTriggerPromptChange = defineTool(
	"test_trigger_prompt_change",
	{ description: "Publishes a prompts/list_changed event to open listen streams." },
	async () => {
		await changeNotifier.prompts?.();
		return toolResult(textContent("Prompt list change published."));
	},
);

// =============================================================================================
// 2026-07-28 scenarios — SEP-2243 custom header validation
// =============================================================================================

// http-custom-header-server-validation: `x-mcp-header` is a plain JSON-Schema extension key on
// the property, advertised verbatim; the SDK's modern inbound seam validates the matching
// `Mcp-Param-Message` header (base64 wrapper, strict alphabet, header/body equality) and answers
// 400 / -32020 on mismatch before the handler runs.
const customHeaderTool = defineTool(
	"test_custom_header_tool",
	{
		description: "Declares an x-mcp-header parameter for SEP-2243 validation.",
		// `x-mcp-header` is a schema extension keyword the compile-time JSONSchema type does not
		// know; the cast keeps the literal intact on the wire.
		inputSchema: fromJsonSchema<{ message: string }>({
			type: "object",
			properties: { message: { type: "string", "x-mcp-header": "Message" } },
			required: ["message"],
			additionalProperties: false,
		} as Parameters<typeof fromJsonSchema>[0]),
	},
	async ({ message }) => toolResult(textContent(`Message: ${message}`)),
);

export const definition = defineServer(
	{ name: "kmcp-everything", version: "1.0.0" },
	{
		instructions:
			"The kmcp conformance fixture. Every capability here mirrors one official MCP " +
			"conformance server scenario; nothing has side effects.",
		// `requestState.verify` is a `ServerOptions` knob, so it rides `sdk`, not the handler
		// options. The seam runs it before every MRTR re-entry — including the legacy shim's
		// in-process rounds — and hands the decoded payload to `ctx.mcpReq.requestState<T>()`.
		sdk: { requestState: { verify: requestStateCodec.verify } },
		// `logging` is off by default in kmcp (deprecated by SEP-2577); tools-call-with-logging and
		// logging-set-level need the capability advertised.
		logging: true,
		capabilities: [
			simpleText,
			imageContentTool,
			audioContentTool,
			embeddedResourceTool,
			mixedContentTool,
			loggingTool,
			errorTool,
			progressTool,
			samplingTool,
			elicitationTool,
			elicitationDefaultsTool,
			elicitationEnumsTool,
			jsonSchema2020Tool,
			structuredOutputTool,
			reconnectionTool,
			staticText,
			staticBinary,
			embeddedResource,
			watchedResource,
			templateResource,
			simplePrompt,
			argumentsPrompt,
			embeddedResourcePrompt,
			imagePrompt,
			irElicitation,
			irSampling,
			irListRoots,
			irRequestState,
			irMultipleInputs,
			irMultiRound,
			irTamperedState,
			irCapabilities,
			irPrompt,
			statelessMissingCapability,
			statelessStreamingElicitation,
			statelessLoggingTool,
			statelessTriggerToolChange,
			statelessTriggerPromptChange,
			customHeaderTool,
		],
	},
);
