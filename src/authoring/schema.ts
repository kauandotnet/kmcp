import type { StandardSchemaV1, StandardSchemaWithJSON } from "@modelcontextprotocol/server";

/**
 * Couples a Standard Schema validator with an explicitly authored JSON Schema, so the shape
 * advertised in `tools/list` can differ from (or be richer than) what the validator library
 * derives on its own. Both halves stay live; nothing is cloned.
 */
export function withJsonSchema<Input, Output = Input>(
	validator: StandardSchemaV1<Input, Output>,
	jsonSchema: Readonly<Record<string, unknown>>,
): StandardSchemaWithJSON<Input, Output> {
	const json = () => ({ ...jsonSchema });
	return {
		"~standard": {
			...validator["~standard"],
			jsonSchema: { input: json, output: json },
		},
	};
}
