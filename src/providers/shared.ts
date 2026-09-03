import { CLIENT_CAPABILITIES_META_KEY, type ServerContext } from "@modelcontextprotocol/server";

/** The current MRTR round to relay upstream: embedded responses, echoed state, client capabilities. */
export function forwardedRound(ctx: ServerContext): {
	inputResponses?: Readonly<Record<string, unknown>>;
	requestState?: string;
	meta?: Readonly<Record<string, unknown>>;
} {
	const requestState = ctx.mcpReq.requestState<unknown>();
	return {
		...(ctx.mcpReq.inputResponses === undefined
			? {}
			: { inputResponses: ctx.mcpReq.inputResponses }),
		...(typeof requestState === "string" ? { requestState } : {}),
		...forwardedMeta(ctx),
	};
}

/** Forwards the DOWNSTREAM client's capabilities so the upstream MRTR capability check sees them. */
export function forwardedMeta(ctx: ServerContext): {
	meta?: Readonly<Record<string, unknown>>;
} {
	const envelope = (ctx.mcpReq.envelope ?? {}) as Readonly<Record<string, unknown>>;
	const capabilities = envelope[CLIENT_CAPABILITIES_META_KEY];
	if (capabilities === undefined || capabilities === null || typeof capabilities !== "object") {
		return {};
	}
	return { meta: { [CLIENT_CAPABILITIES_META_KEY]: capabilities } };
}

export const PROJECTED_NAME_REGEX = /^[A-Za-z0-9._-]{1,128}$/;

export interface McpProjectionDrop {
	readonly kind: "prompt" | "resource" | "resource-template" | "tool";
	/** The upstream name (tools, prompts) or URI / URI template (resources). */
	readonly source: string;
	readonly reason: "invalid-name" | "invalid-template" | "namespace-not-uri-scheme";
}

export function stringArguments(values: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		if (typeof value === "string") out[key] = value;
		else if (value !== undefined) out[key] = String(value);
	}
	return out;
}

export function promptArgumentsJsonSchema(
	args: readonly {
		readonly name: string;
		readonly description?: string | undefined;
		readonly required?: boolean | undefined;
	}[],
): Record<string, unknown> {
	return {
		type: "object",
		properties: Object.fromEntries(
			args.map((argument) => [
				argument.name,
				{
					type: "string",
					...(argument.description === undefined ? {} : { description: argument.description }),
				},
			]),
		),
		required: args.filter((argument) => argument.required === true).map((a) => a.name),
	};
}
