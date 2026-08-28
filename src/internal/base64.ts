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
