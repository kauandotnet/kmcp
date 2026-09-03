import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";
import type { MaybePromise } from "../internal/value.ts";
import type { McpKeyValueStore } from "./oauth.ts";

/**
 * One credential slot of an OS keyring, in the shape of `@napi-rs/keyring`'s `Entry` (and of
 * every keyring binding that models a `(service, account)` pair). kmcp never depends on a native
 * module: the host constructs the entries.
 */
export interface McpKeyringEntry {
	getPassword(): MaybePromise<string | null | undefined>;
	setPassword(value: string): MaybePromise<void>;
	deletePassword(): MaybePromise<boolean | void>;
}

export interface McpKeyringStoreOptions {
	/** The keyring service name every entry is filed under (the application name, typically). */
	readonly service: string;
	/** Builds the entry for a `(service, account)` pair, e.g. `(s, a) => new Entry(s, a)`. */
	readonly entry: (service: string, account: string) => McpKeyringEntry;
	/**
	 * Maps a store key to the keyring account name. Keys are URLs and can be long; some backends
	 * cap account names, so a host may hash or shorten them here. Default: the key verbatim.
	 */
	readonly account?: (key: string) => string;
}

/**
 * An {@link McpKeyValueStore} over an OS keyring (macOS Keychain, Windows Credential Manager,
 * libsecret) through a host-supplied entry factory. Every read or write failure of the keyring is
 * reported as `OPERATION_FAILED` with the backend error as `cause`; an absent entry is
 * `undefined`, never an error.
 */
export class KeyringKeyValueStore implements McpKeyValueStore {
	readonly service: string;
	readonly #entry: (service: string, account: string) => McpKeyringEntry;
	readonly #account: (key: string) => string;

	constructor(options: McpKeyringStoreOptions) {
		if (typeof options.service !== "string" || options.service.trim().length === 0) {
			throw new KmcpError(
				KMCP_ERROR_CODES.INVALID_DEFINITION,
				"KeyringKeyValueStore requires a non-empty service name.",
			);
		}
		if (typeof options.entry !== "function") {
			throw new TypeError("KeyringKeyValueStore requires an entry factory.");
		}
		this.service = options.service;
		this.#entry = options.entry;
		this.#account = options.account ?? ((key) => key);
		Object.freeze(this);
	}

	async get(key: string): Promise<string | undefined> {
		try {
			const value = await this.#slot(key).getPassword();
			return value === null || value === undefined ? undefined : value;
		} catch (error) {
			throw keyringFailure("read", key, error);
		}
	}

	async set(key: string, value: string): Promise<void> {
		try {
			await this.#slot(key).setPassword(value);
		} catch (error) {
			throw keyringFailure("write", key, error);
		}
	}

	async delete(key: string): Promise<void> {
		try {
			await this.#slot(key).deletePassword();
		} catch (error) {
			throw keyringFailure("delete", key, error);
		}
	}

	#slot(key: string): McpKeyringEntry {
		return this.#entry(this.service, this.#account(key));
	}
}

function keyringFailure(action: string, key: string, error: unknown): KmcpError {
	return new KmcpError(
		KMCP_ERROR_CODES.OPERATION_FAILED,
		`The keyring could not ${action} the credential slot for '${key}'.`,
		{ cause: error },
	);
}
