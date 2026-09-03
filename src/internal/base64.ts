const CHUNK = 0x8000;

/** Runtime-neutral base64 encoding (no `Buffer`), chunked so large payloads do not overflow the call stack. */
export function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
	}
	return globalThis.btoa(binary);
}

/** Accepts raw bytes or an already-encoded base64 string. */
export function toBase64(value: Uint8Array | string): string {
	return typeof value === "string" ? value : encodeBase64(value);
}

/** Runtime-neutral base64 decoding; accepts standard and URL-safe alphabets with or without padding. */
export function decodeBase64(value: string): Uint8Array {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	const binary = globalThis.atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/** Encodes bytes with the URL-safe alphabet and no padding (RFC 4648 §5), as PKCE and JWTs require. */
export function encodeBase64Url(bytes: Uint8Array): string {
	return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
