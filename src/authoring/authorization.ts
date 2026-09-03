import type { AuthInfo, McpRequestContext } from "@modelcontextprotocol/server";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import {
	requireScopes,
	type AnyMcpCapabilityDefinition,
	type McpAuthVerdict,
	type McpCapabilityAuth,
} from "./capability.ts";
import { mapCapabilities, type McpDefinitionTransform } from "./transform.ts";
import type { McpMiddleware } from "./middleware.ts";

export { requireScopes };

export type McpAuthCheck = McpCapabilityAuth["check"];

/** Raised by `authorize()` when the failure is scope-shaped; carries only the MISSING scopes. */
export class McpInsufficientScopeError extends KmcpError {
	readonly missingScopes: readonly string[];

	constructor(missingScopes: readonly string[], message?: string) {
		super(
			KMCP_ERROR_CODES.CAPABILITY_INSUFFICIENT_SCOPE,
			message ?? `Missing scope(s): ${missingScopes.join(", ")}.`,
		);
		this.name = "McpInsufficientScopeError";
		this.missingScopes = Object.freeze([...missingScopes]);
	}
}

/**
 * A check requiring every listed role, extracted from the verified token by `extract` (roles are
 * deployment-specific claims; there is no standard location). A role shortfall is never reported
 * as `missingScopes` — OAuth cannot request a role.
 */
export function requireRoles(
	extract: (authInfo: AuthInfo) => readonly string[],
	...roles: readonly string[]
): McpAuthCheck {
	if (typeof extract !== "function") throw new TypeError("extract must be a function.");
	const required = Object.freeze([...roles]);
	return (authInfo) => {
		let held: readonly string[];
		try {
			held = extract(authInfo) ?? [];
		} catch {
			return { allowed: false, reason: "role extraction failed" };
		}
		const missing = required.filter((role) => !held.includes(role));
		return missing.length === 0
			? { allowed: true }
			: { allowed: false, reason: `missing role(s): ${missing.join(", ")}` };
	};
}

/**
 * Passes only when every check passes. Scope shortfalls are aggregated (unioned) across
 * scope-aware failures; aggregation STOPS at the first opaque failure so requirements behind a
 * gate the request did not pass are never disclosed.
 */
export function allOf(...checks: readonly McpAuthCheck[]): McpAuthCheck {
	assertChecks(checks);
	return async (authInfo, context) => {
		const reasons: string[] = [];
		const missingScopes = new Set<string>();
		for (const check of checks) {
			const verdict = normalizeVerdict(await check(authInfo, context));
			if (verdict.allowed) continue;
			reasons.push(verdict.reason);
			if (verdict.missingScopes === undefined || verdict.missingScopes.length === 0) {
				// Opaque failure: stop aggregating and report only what accumulated so far.
				return failure(reasons, missingScopes);
			}
			for (const scope of verdict.missingScopes) missingScopes.add(scope);
		}
		if (reasons.length === 0) return { allowed: true };
		return failure(reasons, missingScopes);
	};
}

/** Passes when any check passes (evaluated in order; the first success short-circuits). */
export function anyOf(...checks: readonly McpAuthCheck[]): McpAuthCheck {
	assertChecks(checks);
	return async (authInfo, context) => {
		const reasons: string[] = [];
		let firstFailure: McpAuthVerdict | undefined;
		for (const check of checks) {
			const verdict = normalizeVerdict(await check(authInfo, context));
			if (verdict.allowed) return { allowed: true };
			firstFailure ??= verdict;
			reasons.push(verdict.reason);
		}
		if (firstFailure === undefined) return { allowed: true };
		return { ...firstFailure, reason: reasons.join("; ") };
	};
}

/**
 * A definition transform that requires `scopes` on every capability carrying `tag`. It composes
 * with an existing `auth` (both must pass) and forces `anonymous: "deny"` — an anonymous request
 * cannot hold a scope.
 */
export function restrictTag(tag: string, ...scopes: readonly string[]): McpDefinitionTransform {
	if (typeof tag !== "string" || tag.length === 0) throw new TypeError("tag must be non-empty.");
	const scopeCheck = requireScopes(...scopes);
	const restrict = <Definition extends AnyMcpCapabilityDefinition>(
		definition: Definition,
	): Definition => {
		if (!definition.tags.includes(tag)) return definition;
		const existing = definition.auth;
		const auth: McpCapabilityAuth = {
			anonymous: "deny",
			check: existing === undefined ? scopeCheck : allOf(existing.check, scopeCheck),
		};
		return definition.withAuth(auth) as Definition;
	};
	return mapCapabilities({
		tool: restrict,
		prompt: restrict,
		resource: restrict,
		resourceTemplate: restrict,
	});
}

/**
 * Call-time authorization middleware. With no arguments it re-enforces each capability's own
 * `auth` on every call (materialization-time `admit` already hides denied capabilities; the
 * middleware matters for long-lived instances whose principal can outlive a token). Extra checks
 * apply to every capability the chain wraps. Failures throw `McpInsufficientScopeError` when the
 * shortfall is scope-shaped, `AUTH_FORBIDDEN` otherwise.
 */
export function authorize(...checks: readonly McpAuthCheck[]): McpMiddleware {
	assertChecks(checks);
	return async (context, next) => {
		const authInfo = context.request.authInfo ?? context.server.http?.authInfo;
		const capabilityAuth = context.definition.auth;
		if (capabilityAuth !== undefined) {
			await enforce(capabilityAuth.check, capabilityAuth.anonymous, authInfo, context.request);
		}
		for (const check of checks) {
			await enforce(check, "deny", authInfo, context.request);
		}
		return next(context);
	};
}

async function enforce(
	check: McpAuthCheck,
	anonymous: McpCapabilityAuth["anonymous"],
	authInfo: AuthInfo | undefined,
	context: McpRequestContext,
): Promise<void> {
	if (authInfo === undefined) {
		if (anonymous === "allow") return;
		throw new KmcpError(KMCP_ERROR_CODES.AUTH_FORBIDDEN, "Anonymous requests are not authorized.");
	}
	let verdict: McpAuthVerdict;
	try {
		verdict = normalizeVerdict(await check(authInfo, context));
	} catch (error) {
		throw new KmcpError(KMCP_ERROR_CODES.AUTH_FORBIDDEN, "The authorization check failed.", {
			cause: error,
		});
	}
	if (verdict.allowed) return;
	if (verdict.missingScopes !== undefined && verdict.missingScopes.length > 0) {
		throw new McpInsufficientScopeError(verdict.missingScopes);
	}
	throw new KmcpError(KMCP_ERROR_CODES.AUTH_FORBIDDEN, `Not authorized: ${verdict.reason}.`);
}

function normalizeVerdict(verdict: McpAuthVerdict | boolean): McpAuthVerdict {
	if (verdict === true) return { allowed: true };
	if (verdict === false) return { allowed: false, reason: "denied" };
	return verdict;
}

function failure(reasons: readonly string[], missingScopes: ReadonlySet<string>): McpAuthVerdict {
	return {
		allowed: false,
		reason: reasons.join("; "),
		...(missingScopes.size === 0 ? {} : { missingScopes: Object.freeze([...missingScopes]) }),
	};
}

function assertChecks(checks: readonly McpAuthCheck[]): void {
	for (const check of checks) {
		if (typeof check !== "function") throw new TypeError("auth checks must be functions.");
	}
}
