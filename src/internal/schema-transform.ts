import type { StandardSchemaV1, StandardSchemaWithJSON } from "@modelcontextprotocol/server";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";

export interface SchemaArgTransform {
	/** The public (advertised) name replacing the underlying one. */
	readonly name?: string;
	readonly description?: string;
	/** Removes the argument from the advertised schema; the client can no longer supply it. */
	readonly hide?: true;
	/** Injected for a hidden argument on every call. REQUIRED when hiding a required argument. */
	readonly default?: unknown;
}

interface CompiledTransforms {
	/** underlying name -> public name, for renamed arguments only. */
	readonly rename: ReadonlyMap<string, string>;
	/** public name -> underlying name (the reverse of `rename`). */
	readonly unrename: ReadonlyMap<string, string>;
	readonly hidden: ReadonlyMap<string, SchemaArgTransform>;
	readonly describe: ReadonlyMap<string, string>;
}

/**
 * Wraps a `StandardSchemaWithJSON` so its ADVERTISED JSON projection hides/renames/re-describes
 * arguments while validation still happens against the underlying schema: incoming public-shaped
 * values are reverse-renamed, hidden defaults are injected, issues are remapped to public names,
 * and the validated output keeps the underlying shape — the original handler is reused verbatim.
 */
export function transformInputSchema(
	schema: StandardSchemaWithJSON,
	transforms: Readonly<Record<string, SchemaArgTransform>>,
	label: string,
): StandardSchemaWithJSON {
	const standard = schema["~standard"];
	const projection = probeProjection(standard, label);
	const compiled = compile(projection, transforms, label);
	const wrappedInput = (options: Parameters<typeof standard.jsonSchema.input>[0]) =>
		rewriteProjection(standard.jsonSchema.input(options), compiled);
	const validate: StandardSchemaV1.Props["validate"] = (value, options) => {
		const mapped = reverseMap(value, compiled);
		const result = standard.validate(mapped, options);
		if (result instanceof Promise) return result.then((settled) => remapIssues(settled, compiled));
		return remapIssues(result, compiled);
	};
	return {
		"~standard": {
			...standard,
			validate,
			jsonSchema: { input: wrappedInput, output: standard.jsonSchema.output },
		},
	};
}

function probeProjection(
	standard: StandardSchemaWithJSON["~standard"],
	label: string,
): Record<string, unknown> {
	let projection: Record<string, unknown>;
	try {
		projection = standard.jsonSchema.input({ target: "draft-2020-12" });
	} catch (error) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`${label}: the input schema could not be projected to JSON Schema.`,
			{ cause: error },
		);
	}
	if (
		projection === null ||
		typeof projection !== "object" ||
		projection["type"] !== "object" ||
		typeof projection["properties"] !== "object" ||
		projection["properties"] === null
	) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`${label}: argument transforms need an object schema with named properties at its root.`,
		);
	}
	return projection;
}

function compile(
	projection: Record<string, unknown>,
	transforms: Readonly<Record<string, SchemaArgTransform>>,
	label: string,
): CompiledTransforms {
	const properties = projection["properties"] as Record<string, unknown>;
	const required = new Set(
		Array.isArray(projection["required"]) ? (projection["required"] as string[]) : [],
	);
	const rename = new Map<string, string>();
	const hidden = new Map<string, SchemaArgTransform>();
	const describe = new Map<string, string>();
	for (const [argument, transform] of Object.entries(transforms)) {
		if (!(argument in properties)) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				`${label}: argument '${argument}' does not exist in the input schema.`,
			);
		}
		if (transform.hide === true) {
			if (transform.name !== undefined) {
				throw new KmcpError(
					KMCP_ERROR_CODES.INVALID_DEFINITION,
					`${label}: argument '${argument}' cannot be both hidden and renamed.`,
				);
			}
			if (required.has(argument) && transform.default === undefined) {
				throw new KmcpError(
					KMCP_ERROR_CODES.INVALID_DEFINITION,
					`${label}: hiding required argument '${argument}' needs a default.`,
				);
			}
			hidden.set(argument, transform);
		} else if (transform.name !== undefined && transform.name !== argument) {
			rename.set(argument, transform.name);
		}
		if (transform.description !== undefined) describe.set(argument, transform.description);
	}
	const publicNames = new Set<string>();
	for (const argument of Object.keys(properties)) {
		if (hidden.has(argument)) continue;
		const publicName = rename.get(argument) ?? argument;
		if (publicNames.has(publicName)) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				`${label}: renamed argument '${publicName}' collides with another argument.`,
			);
		}
		publicNames.add(publicName);
	}
	const unrename = new Map<string, string>();
	for (const [underlying, publicName] of rename) unrename.set(publicName, underlying);
	return { rename, unrename, hidden, describe };
}

function rewriteProjection(
	projection: Record<string, unknown>,
	compiled: CompiledTransforms,
): Record<string, unknown> {
	const clone = structuredClone(projection);
	const properties = clone["properties"];
	if (properties === null || typeof properties !== "object") return clone;
	const next: Record<string, unknown> = {};
	for (const [argument, definition] of Object.entries(properties as Record<string, unknown>)) {
		if (compiled.hidden.has(argument)) continue;
		const description = compiled.describe.get(argument);
		const value =
			description === undefined ||
			definition === null ||
			typeof definition !== "object" ||
			Array.isArray(definition)
				? definition
				: { ...(definition as Record<string, unknown>), description };
		next[compiled.rename.get(argument) ?? argument] = value;
	}
	clone["properties"] = next;
	if (Array.isArray(clone["required"])) {
		clone["required"] = (clone["required"] as string[])
			.filter((argument) => !compiled.hidden.has(argument))
			.map((argument) => compiled.rename.get(argument) ?? argument);
	}
	return clone;
}

function reverseMap(value: unknown, compiled: CompiledTransforms): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
	const mapped: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		// A client cannot address a hidden argument or a renamed argument's underlying name.
		if (compiled.hidden.has(key)) continue;
		if (compiled.rename.has(key)) continue;
		mapped[compiled.unrename.get(key) ?? key] = entry;
	}
	for (const [argument, transform] of compiled.hidden) {
		if (transform.default !== undefined) mapped[argument] = structuredClone(transform.default);
	}
	return mapped;
}

function remapIssues<Output>(
	result: StandardSchemaV1.Result<Output>,
	compiled: CompiledTransforms,
): StandardSchemaV1.Result<Output> {
	if (result.issues === undefined || compiled.rename.size === 0) return result;
	return {
		issues: result.issues.map((issue) => {
			if (issue.path === undefined || issue.path.length === 0) return issue;
			const head = issue.path[0];
			const key = typeof head === "object" && head !== null ? head.key : head;
			const publicName = typeof key === "string" ? compiled.rename.get(key) : undefined;
			if (publicName === undefined) return issue;
			return { ...issue, path: [publicName, ...issue.path.slice(1)] };
		}),
	};
}
