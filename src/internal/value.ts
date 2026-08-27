import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";

export type MaybePromise<Value> = Value | Promise<Value>;

export type McpDeepReadonly<Value> = Value extends CallableFunction
	? Value
	: Value extends readonly unknown[]
		? { readonly [Key in keyof Value]: McpDeepReadonly<Value[Key]> }
		: Value extends object
			? { readonly [Key in keyof Value]: McpDeepReadonly<Value[Key]> }
			: Value;

export function assertNonEmpty(value: string, label: string): void {
	if (value.trim().length === 0) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`${label} must be a non-empty string.`,
		);
	}
}

export function isoTimestamp(now: () => number): string {
	const value = now();
	if (!Number.isFinite(value)) {
		throw new TypeError("The clock must return a finite Unix epoch timestamp.");
	}
	return new Date(value).toISOString();
}

export function safeClock(clock: () => number): () => number {
	return () => {
		try {
			return clock();
		} catch {
			return Date.now();
		}
	};
}

export function immutableClone<Value>(value: Value): Value {
	return deepFreeze(structuredClone(value));
}

export function immutableProtocolClone<Value>(value: Value, label: string): Value {
	assertProtocolValue(value, label, new Set<object>());
	return deepFreeze(structuredClone(value));
}

export function deepFreeze<Value>(value: Value): Value {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
		return value;
	}

	for (const child of Object.values(value)) {
		deepFreeze(child);
	}
	return Object.freeze(value);
}

function assertProtocolValue(value: unknown, path: string, ancestors: Set<object>): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return;
	}
	if (typeof value === "number") {
		if (Number.isFinite(value)) return;
		throw invalidProtocolValue(path, "must be a finite number");
	}
	if (typeof value !== "object") {
		throw invalidProtocolValue(path, `contains an unsupported ${typeof value} value`);
	}
	if (ancestors.has(value)) throw invalidProtocolValue(path, "must not contain cycles");

	const prototype = Object.getPrototypeOf(value) as unknown;
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
		throw invalidProtocolValue(path, "must contain only plain objects and arrays");
	}

	ancestors.add(value);
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			assertProtocolValue(value[index], `${path}[${index}]`, ancestors);
		}
	} else {
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string") {
				throw invalidProtocolValue(path, "must not contain symbol keys");
			}
			assertProtocolValue(
				(value as Readonly<Record<string, unknown>>)[key],
				`${path}.${key}`,
				ancestors,
			);
		}
	}
	ancestors.delete(value);
}

function invalidProtocolValue(path: string, reason: string): KmcpError {
	return new KmcpError(KMCP_ERROR_CODES.INVALID_DEFINITION, `${path} ${reason}.`);
}

export function stableFingerprint(value: unknown): string {
	const serialized = stableStringify(value);
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	for (let index = 0; index < serialized.length; index += 1) {
		const code = serialized.charCodeAt(index);
		first = Math.imul(first ^ code, 0x01000193);
		second = Math.imul(second ^ code, 0x85ebca6b);
	}
	return `fnv1a32:${unsignedHex(first)}${unsignedHex(second)}`;
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "undefined";
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	const record = value as Readonly<Record<string, unknown>>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(",")}}`;
}

function unsignedHex(value: number): string {
	return (value >>> 0).toString(16).padStart(8, "0");
}

export function waitForCaller<Value>(
	promise: Promise<Value>,
	signal?: AbortSignal,
): Promise<Value> {
	if (signal === undefined) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);

	return new Promise<Value>((resolve, reject) => {
		const onAbort = (): void => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
