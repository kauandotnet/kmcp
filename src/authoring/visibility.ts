import type { AnyMcpCapabilityDefinition, McpCapabilityKind } from "./capability.ts";

/**
 * Selects capabilities by name, tag, and kind. Every present criterion must match (AND); a
 * selector with no criteria matches every capability — `disable({})` is the allowlist base.
 */
export interface McpVisibilitySelector {
	readonly names?: readonly string[];
	/** Matches when the capability carries at least one of these tags. */
	readonly tags?: readonly string[];
	readonly kinds?: readonly McpCapabilityKind[];
}

export interface McpVisibilityRule extends McpVisibilitySelector {
	readonly enabled: boolean;
}

/** A rule making the selected capabilities visible. */
export function enable(selector: McpVisibilitySelector = {}): McpVisibilityRule {
	return Object.freeze({ ...normalizeSelector(selector), enabled: true });
}

/** A rule hiding the selected capabilities. */
export function disable(selector: McpVisibilitySelector = {}): McpVisibilityRule {
	return Object.freeze({ ...normalizeSelector(selector), enabled: false });
}

export function normalizeVisibilityRules(
	rules: readonly McpVisibilityRule[] | undefined,
): readonly McpVisibilityRule[] {
	if (rules === undefined) return Object.freeze([]);
	return Object.freeze(
		rules.map((rule) => {
			if (typeof rule !== "object" || rule === null || typeof rule.enabled !== "boolean") {
				throw new TypeError("A visibility rule must be an object with a boolean `enabled`.");
			}
			return Object.freeze({ ...normalizeSelector(rule), enabled: rule.enabled });
		}),
	);
}

/**
 * Applies visibility rules to a capability list. Rules run left to right; the LAST matching rule
 * wins; a capability no rule matches stays visible. A hidden capability is simply not installed —
 * absent from lists and answering "not found" on calls.
 */
export function applyVisibility(
	capabilities: readonly AnyMcpCapabilityDefinition[],
	rules: readonly McpVisibilityRule[],
): readonly AnyMcpCapabilityDefinition[] {
	if (rules.length === 0) return capabilities;
	return capabilities.filter((capability) => {
		let visible = true;
		for (const rule of rules) {
			if (matches(rule, capability)) visible = rule.enabled;
		}
		return visible;
	});
}

function matches(selector: McpVisibilitySelector, capability: AnyMcpCapabilityDefinition): boolean {
	if (selector.names !== undefined && !selector.names.includes(capability.name)) return false;
	if (selector.kinds !== undefined && !selector.kinds.includes(capability.kind)) return false;
	if (selector.tags !== undefined && !selector.tags.some((tag) => capability.tags.includes(tag))) {
		return false;
	}
	return true;
}

function normalizeSelector(selector: McpVisibilitySelector): McpVisibilitySelector {
	for (const list of [selector.names, selector.tags, selector.kinds]) {
		if (list !== undefined && !Array.isArray(list)) {
			throw new TypeError("Visibility selector criteria must be arrays.");
		}
	}
	return {
		...(selector.names === undefined ? {} : { names: Object.freeze([...selector.names]) }),
		...(selector.tags === undefined ? {} : { tags: Object.freeze([...selector.tags]) }),
		...(selector.kinds === undefined ? {} : { kinds: Object.freeze([...selector.kinds]) }),
	};
}
