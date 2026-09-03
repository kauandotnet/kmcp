import { decodeBase64 } from "../internal/base64.ts";

/** Claims decoded from a JWT payload. Unverified: for expiry checks and display only. */
export type McpJwtClaims = Readonly<Record<string, unknown>>;

const decoder = new TextDecoder();

/**
 * Decodes a JWT payload WITHOUT verifying its signature. Returns `undefined` for anything that
 * is not a three-part token with a JSON-object payload. Never use the result for an authorization
 * decision; it exists for expiry bookkeeping and display-only identity.
 */
export function decodeJwtClaims(jwt: string): McpJwtClaims | undefined {
	const parts = jwt.split(".");
	if (parts.length !== 3 || parts[1] === undefined || parts[1].length === 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(decoder.decode(decodeBase64(parts[1])));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		return Object.freeze({ ...(parsed as Record<string, unknown>) });
	} catch {
		return undefined;
	}
}

/** The `exp` claim (Unix seconds) of a JWT, or `undefined` when absent or not decodable. */
export function jwtExpiresAt(jwt: string): number | undefined {
	const exp = decodeJwtClaims(jwt)?.exp;
	return typeof exp === "number" && Number.isFinite(exp) ? exp : undefined;
}
