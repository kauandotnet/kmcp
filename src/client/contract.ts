import type { Prompt, Tool } from "@modelcontextprotocol/client";

/**
 * Contract checks: compare the capability a server advertises NOW with the shape a caller was
 * written against. `strict` demands an exact match; `compatible` asks whether a call written
 * against the expected shape still succeeds (new required fields, removed or retyped fields are
 * breaking; new optional fields and description edits are warnings). With `arguments`, only the
 * arguments actually passed are checked, so unused optional drift never blocks a call.
 */
export type McpContractMode = "strict" | "compatible";

export interface McpContractResult {
	readonly valid: boolean;
	readonly errors: readonly string[];
	readonly warnings: readonly string[];
}

/** The subset of a `Tool` a contract can pin (a full `Tool` satisfies it). */
export interface McpExpectedTool {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: McpSchemaShape;
	readonly outputSchema?: McpSchemaShape;
}

/** The subset of a `Prompt` a contract can pin (a full `Prompt` satisfies it). */
export interface McpExpectedPrompt {
	readonly name: string;
	readonly description?: string;
	readonly arguments?: readonly {
		readonly name: string;
		readonly description?: string;
		readonly required?: boolean;
	}[];
}

export interface McpSchemaShape {
	readonly type?: unknown;
	readonly properties?: Readonly<Record<string, unknown>>;
	readonly required?: readonly string[];
	readonly [key: string]: unknown;
}

export interface McpToolContractOptions {
	readonly mode?: McpContractMode;
	/** The arguments about to be sent; narrows `compatible` checks to what the call uses. */
	readonly arguments?: Readonly<Record<string, unknown>>;
}

export interface McpPromptContractOptions {
	readonly mode?: McpContractMode;
	readonly arguments?: Readonly<Record<string, string>>;
}

export function checkToolContract(
	actual: Tool | McpExpectedTool,
	expected: McpExpectedTool,
	options: McpToolContractOptions = {},
): McpContractResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const mode = options.mode ?? "compatible";
	if (actual.name !== expected.name) {
		errors.push(`Tool name mismatch: expected '${expected.name}', got '${actual.name}'.`);
	}
	if (mode === "strict") {
		if (actual.description !== expected.description) {
			errors.push("Tool description does not match exactly.");
		}
		if (!deepEqual(actual.inputSchema, expected.inputSchema)) {
			errors.push("Input schema does not match exactly.");
		}
		if (!deepEqual(actual.outputSchema, expected.outputSchema)) {
			errors.push("Output schema does not match exactly.");
		}
		return finish(errors, warnings);
	}
	if (actual.description !== expected.description) {
		warnings.push("Tool description changed.");
	}
	compareInputSchema(
		actual.inputSchema as McpSchemaShape | undefined,
		expected.inputSchema,
		options.arguments,
		errors,
		warnings,
	);
	compareOutputSchema(
		actual.outputSchema as McpSchemaShape | undefined,
		expected.outputSchema,
		errors,
		warnings,
	);
	return finish(errors, warnings);
}

export function checkPromptContract(
	actual: Prompt | McpExpectedPrompt,
	expected: McpExpectedPrompt,
	options: McpPromptContractOptions = {},
): McpContractResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const mode = options.mode ?? "compatible";
	if (actual.name !== expected.name) {
		errors.push(`Prompt name mismatch: expected '${expected.name}', got '${actual.name}'.`);
	}
	if (mode === "strict") {
		if (actual.description !== expected.description) {
			errors.push("Prompt description does not match exactly.");
		}
		if (!deepEqual(actual.arguments, expected.arguments)) {
			errors.push("Prompt arguments do not match exactly.");
		}
		return finish(errors, warnings);
	}
	if (actual.description !== expected.description) warnings.push("Prompt description changed.");
	const expectedArguments = expected.arguments ?? [];
	const actualArguments = actual.arguments ?? [];
	const expectedRequired = new Set(
		expectedArguments.filter((argument) => argument.required === true).map((a) => a.name),
	);
	const actualRequired = new Set(
		actualArguments.filter((argument) => argument.required === true).map((a) => a.name),
	);
	const passed = options.arguments === undefined ? undefined : Object.keys(options.arguments);
	const hasPassed = passed !== undefined && passed.length > 0;
	for (const name of actualRequired) {
		if (!expectedRequired.has(name) && (!hasPassed || !passed.includes(name))) {
			errors.push(`New required argument '${name}' was added.`);
		}
	}
	if (hasPassed) {
		for (const name of passed) {
			if (!actualArguments.some((argument) => argument.name === name)) {
				errors.push(`Argument '${name}' no longer exists.`);
			}
		}
	} else {
		for (const name of expectedRequired) {
			const current = actualArguments.find((argument) => argument.name === name);
			if (current === undefined) errors.push(`Required argument '${name}' is missing.`);
			else if (current.required !== true) {
				errors.push(`Required argument '${name}' is no longer required.`);
			}
		}
	}
	for (const argument of actualArguments) {
		if (
			!expectedArguments.some((candidate) => candidate.name === argument.name) &&
			argument.required !== true
		) {
			warnings.push(`New optional argument '${argument.name}' was added.`);
		}
	}
	return finish(errors, warnings);
}

function compareInputSchema(
	actual: McpSchemaShape | undefined,
	expected: McpSchemaShape | undefined,
	passedArguments: Readonly<Record<string, unknown>> | undefined,
	errors: string[],
	warnings: string[],
): void {
	if (expected === undefined) return;
	if (actual === undefined) {
		errors.push("Input schema was removed.");
		return;
	}
	const expectedRequired = new Set(expected.required ?? []);
	const actualRequired = new Set(actual.required ?? []);
	const expectedProperties = expected.properties ?? {};
	const actualProperties = actual.properties ?? {};
	const passed = passedArguments === undefined ? undefined : Object.keys(passedArguments);
	const hasPassed = passed !== undefined && passed.length > 0;
	for (const field of actualRequired) {
		if (!expectedRequired.has(field) && (!hasPassed || !passed.includes(field))) {
			errors.push(`New required field '${field}' was added.`);
		}
	}
	if (hasPassed) {
		for (const name of passed) {
			if (!(name in actualProperties)) {
				errors.push(`Argument '${name}' no longer exists in the input schema.`);
				continue;
			}
			compareType(name, expectedProperties[name], actualProperties[name], errors);
		}
	} else {
		for (const [name, expectedProperty] of Object.entries(expectedProperties)) {
			if (!(name in actualProperties)) {
				errors.push(`Property '${name}' is missing from the input schema.`);
				continue;
			}
			compareType(name, expectedProperty, actualProperties[name], errors);
		}
		for (const field of expectedRequired) {
			if (!actualRequired.has(field)) errors.push(`Field '${field}' is no longer required.`);
		}
	}
	for (const name of Object.keys(actualProperties)) {
		if (!(name in expectedProperties) && !actualRequired.has(name)) {
			warnings.push(`New optional field '${name}' was added.`);
		}
	}
}

function compareOutputSchema(
	actual: McpSchemaShape | undefined,
	expected: McpSchemaShape | undefined,
	errors: string[],
	warnings: string[],
): void {
	if (expected === undefined) {
		if (actual !== undefined) warnings.push("An output schema was added.");
		return;
	}
	if (actual === undefined) {
		errors.push("Output schema was removed.");
		return;
	}
	const expectedRequired = new Set(expected.required ?? []);
	const actualRequired = new Set(actual.required ?? []);
	const expectedProperties = expected.properties ?? {};
	const actualProperties = actual.properties ?? {};
	for (const [name, expectedProperty] of Object.entries(expectedProperties)) {
		if (!(name in actualProperties)) {
			errors.push(`Output field '${name}' was removed.`);
			continue;
		}
		compareType(`output field '${name}'`, expectedProperty, actualProperties[name], errors, true);
	}
	for (const field of expectedRequired) {
		if (!actualRequired.has(field) && field in actualProperties) {
			warnings.push(`Output field '${field}' changed from required to optional.`);
		}
	}
	for (const name of Object.keys(actualProperties)) {
		if (!(name in expectedProperties)) warnings.push(`New output field '${name}' was added.`);
	}
	for (const field of actualRequired) {
		if (!expectedRequired.has(field) && field in expectedProperties) {
			warnings.push(`Output field '${field}' changed from optional to required.`);
		}
	}
}

function compareType(
	label: string,
	expectedProperty: unknown,
	actualProperty: unknown,
	errors: string[],
	labelled = false,
): void {
	const expectedType = (expectedProperty as { readonly type?: unknown } | undefined)?.type;
	const actualType = (actualProperty as { readonly type?: unknown } | undefined)?.type;
	if (expectedType !== undefined && !deepEqual(expectedType, actualType)) {
		errors.push(
			`${labelled ? label[0]?.toUpperCase() + label.slice(1) : `Argument '${label}'`} changed type from ${JSON.stringify(expectedType)} to ${JSON.stringify(actualType)}.`,
		);
	}
}

function finish(errors: readonly string[], warnings: readonly string[]): McpContractResult {
	return Object.freeze({
		valid: errors.length === 0,
		errors: Object.freeze([...errors]),
		warnings: Object.freeze([...warnings]),
	});
}

function deepEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (typeof left !== typeof right || left === null || right === null) return false;
	if (Array.isArray(left)) {
		if (!Array.isArray(right) || left.length !== right.length) return false;
		return left.every((item, index) => deepEqual(item, right[index]));
	}
	if (typeof left === "object" && typeof right === "object" && !Array.isArray(right)) {
		const leftRecord = left as Readonly<Record<string, unknown>>;
		const rightRecord = right as Readonly<Record<string, unknown>>;
		const leftKeys = Object.keys(leftRecord).sort();
		const rightKeys = Object.keys(rightRecord).sort();
		if (!deepEqual(leftKeys, rightKeys)) return false;
		return leftKeys.every((key) => deepEqual(leftRecord[key], rightRecord[key]));
	}
	return false;
}
