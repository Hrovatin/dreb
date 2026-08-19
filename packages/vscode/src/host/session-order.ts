/**
 * Vscode-free, unit-testable store for the sidebar's manual session order.
 *
 * By default the sessions side panel orders sessions by creation time (newest
 * first) — a stable order that never shifts with activity. Users can override
 * that within a group by dragging rows; this module persists that manual order
 * so it survives refreshes and extension restarts.
 *
 * Like {@link SessionFlagsStore}, the order is UI state (not part of the session
 * `.jsonl` transcript), so it lives in the extension's `globalState`. This module
 * holds the pure, vscode-independent core: `extension.ts` injects the real
 * {@link https://code.visualstudio.com/api | vscode} `Memento` (globalState),
 * while tests inject an in-memory fake.
 *
 * Ranks are keyed by the session's `.jsonl` file path. Within a dragged group the
 * first row gets the largest rank so a **descending** rank sort reproduces the
 * displayed order. Ranks are small positive integers (`1..N`) that deliberately
 * sit below creation-time epoch values, so a session created *after* a manual
 * reorder still surfaces at the top by newest-created while the dragged block
 * keeps its relative order beneath it.
 */

/** Minimal subset of vscode.Memento the store needs (globalState). */
export interface OrderMemento {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

/** globalState key under which the whole order record is stored. */
const STORAGE_KEY = "dreb.sessionOrder";

/** Persisted shape: session path -> its manual rank (higher sorts first). */
type OrderRecord = Record<string, number>;

/**
 * Persists a per-session manual order rank keyed by session `.jsonl` file path in
 * a single globalState record. Sessions with no stored rank fall back to the
 * default creation-time ordering.
 */
export class SessionOrderStore {
	constructor(private readonly memento: OrderMemento) {}

	/** Read the whole persisted record, defaulting to an empty object. */
	private read(): OrderRecord {
		return this.memento.get<OrderRecord>(STORAGE_KEY) ?? {};
	}

	/** Manual rank for a session path, or undefined when none is stored (or the
	 * path is undefined — a brand-new not-yet-persisted session). */
	get(path: string | undefined): number | undefined {
		if (path === undefined) return undefined;
		const rec = this.read();
		return rec[path];
	}

	/**
	 * Persist an explicit manual order for a group of sessions. `orderedPaths` is
	 * the group's rows in the exact top-to-bottom order the user arranged them;
	 * each path is assigned a descending rank so the default rank-DESC sort
	 * reproduces that order. Ranks for paths outside `orderedPaths` are untouched.
	 */
	async setGroupOrder(orderedPaths: string[]): Promise<void> {
		const rec = this.read();
		const n = orderedPaths.length;
		orderedPaths.forEach((path, index) => {
			// First row -> largest rank (n), last row -> 1, so rank-DESC = displayed order.
			rec[path] = n - index;
		});
		await this.memento.update(STORAGE_KEY, rec);
	}

	/** Remove a path's stored rank entirely (call on delete). */
	async clear(path: string): Promise<void> {
		const rec = this.read();
		if (path in rec) {
			delete rec[path];
			await this.memento.update(STORAGE_KEY, rec);
		}
	}
}
