import type { ServerNotifier } from "@modelcontextprotocol/server";

import type { McpConnectionManager } from "../client/manager.ts";
import type { McpHubManager } from "../hub/hub.ts";

export interface McpNotifyOnCatalogChangeOptions {
	/** Only react to this connection (managers) or hub (hub managers). */
	readonly connectionId?: string;
	readonly hubId?: string;
	/** Coalescing window before notifying, in ms. Default: 300. */
	readonly debounceMs?: number;
}

interface CatalogChangeEvent {
	readonly type: string;
	readonly connection?: { readonly id: string };
	readonly hub?: { readonly id: string };
}

interface CatalogChangeSource {
	subscribe(listener: (event: never) => void): () => void;
}

const MANAGER_EVENTS = new Set(["catalog.refreshed", "connection.removed"]);
const HUB_EVENTS = new Set(["hub.catalog.refreshed", "hub.connection.changed", "hub.updated"]);

/**
 * Bridges catalog changes on a connection manager or hub manager to a serving handler's
 * `notify` (`tools/prompts/resources list_changed`), coalesced by `debounceMs`. Use it alongside
 * `connectionProvider`/`hubProvider` so downstream clients re-list when the projected upstream
 * changes. Returns an unsubscribe function that also cancels a pending notification.
 */
export function notifyOnCatalogChange<Id extends string = string, HubId extends string = string>(
	source: McpConnectionManager<Id> | McpHubManager<HubId, Id> | CatalogChangeSource,
	target: { readonly notify: ServerNotifier },
	options: McpNotifyOnCatalogChangeOptions = {},
): () => void {
	if (typeof (source as CatalogChangeSource)?.subscribe !== "function") {
		throw new TypeError("notifyOnCatalogChange requires a subscribable source.");
	}
	if (typeof target?.notify?.toolsChanged !== "function") {
		throw new TypeError("notifyOnCatalogChange requires a handler with notify.");
	}
	const debounceMs = options.debounceMs ?? 300;
	if (!Number.isFinite(debounceMs) || debounceMs < 0) {
		throw new RangeError("debounceMs must be non-negative.");
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	const fire = () => {
		timer = undefined;
		if (closed) return;
		void Promise.allSettled([
			target.notify.toolsChanged(),
			target.notify.promptsChanged(),
			target.notify.resourcesChanged(),
		]);
	};
	const listener = (raw: never) => {
		const event = raw as CatalogChangeEvent;
		const relevant =
			(MANAGER_EVENTS.has(event.type) &&
				(options.connectionId === undefined || event.connection?.id === options.connectionId)) ||
			(HUB_EVENTS.has(event.type) &&
				(options.hubId === undefined || event.hub?.id === options.hubId));
		if (!relevant || closed) return;
		if (timer !== undefined) return;
		timer = setTimeout(fire, debounceMs);
		timer.unref?.();
	};
	const unsubscribe = (source as CatalogChangeSource).subscribe(listener);
	return () => {
		closed = true;
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		unsubscribe();
	};
}
