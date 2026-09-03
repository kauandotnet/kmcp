import type { McpCapabilityKind } from "../authoring/capability.ts";
import type {
	McpCapabilityProvider,
	McpServerDefinition,
	McpServerDefinitionOptions,
} from "../authoring/server-definition.ts";
import { McpServerDefinition as ServerDefinitionClass } from "../authoring/server-definition.ts";
import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";

/**
 * Builds a provider-backed derivation of `base`: the base's own providers, visibility, and auth
 * all run inside `provider` (which resolves through `base.admit`), so they must not run again on
 * the derived definition.
 */
export function deriveProviderDefinition(
	base: McpServerDefinition,
	provider: McpCapabilityProvider,
	extraKinds: readonly McpCapabilityKind[],
): McpServerDefinition {
	if (!(base instanceof ServerDefinitionClass)) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			"A discovery transform requires an McpServerDefinition.",
		);
	}
	const {
		providers: _providers,
		declare: _declare,
		visibility: _visibility,
		...configuration
	} = base.configuration();
	void _providers;
	void _declare;
	void _visibility;
	const declare = [
		...new Set<McpCapabilityKind>([
			...base.capabilities.map((capability) => capability.kind),
			...base.declaredKinds,
			...extraKinds,
		]),
	];
	return new ServerDefinitionClass(base.serverInfo, {
		...(configuration as McpServerDefinitionOptions),
		capabilities: [],
		providers: [provider],
		declare,
	});
}

/** A tiny fingerprint-keyed cache for per-request derived state (search indexes). */
export class FingerprintCache<Value> {
	readonly #entries = new Map<string, Value>();
	readonly #capacity: number;

	constructor(capacity = 8) {
		this.#capacity = capacity;
	}

	get(key: string, build: () => Value): Value {
		const existing = this.#entries.get(key);
		if (existing !== undefined) {
			// Refresh recency.
			this.#entries.delete(key);
			this.#entries.set(key, existing);
			return existing;
		}
		const value = build();
		if (this.#entries.size >= this.#capacity) {
			const oldest = this.#entries.keys().next().value;
			if (oldest !== undefined) this.#entries.delete(oldest);
		}
		this.#entries.set(key, value);
		return value;
	}
}
