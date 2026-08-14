/**
 * Vscode-free, unit-testable store for per-session pin/archive flags.
 *
 * The sessions side panel lets users pin sessions to the top and archive stale
 * ones. Those flags are UI state, not part of the session `.jsonl` transcript,
 * so they live in the extension's `globalState`. This module holds the pure,
 * vscode-independent core: `extension.ts` injects the real
 * {@link https://code.visualstudio.com/api | vscode} `Memento` (globalState),
 * while tests inject an in-memory fake.
 *
 * Flags are keyed by the session's `.jsonl` file path and stored together in a
 * single record so a whole read-modify-write touches one `globalState` key.
 */

import type { SessionFlags } from "../shared/session-list.js"; // { pinned: boolean; archived: boolean }

/** Minimal subset of vscode.Memento the store needs (globalState). */
export interface FlagMemento {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

/** globalState key under which the whole flag record is stored. */
const STORAGE_KEY = "dreb.sessionFlags";

/** Persisted shape: session path -> its (possibly partial) flags. */
type FlagRecord = Record<string, { pinned?: boolean; archived?: boolean }>;

/**
 * Persists pin/archive flags keyed by session `.jsonl` file path in a single
 * globalState record. Sessions with no stored entry default to
 * unpinned/unarchived.
 */
export class SessionFlagsStore {
	constructor(private readonly memento: FlagMemento) {}

	/** Read the whole persisted record, defaulting to an empty object. */
	private read(): FlagRecord {
		return this.memento.get<FlagRecord>(STORAGE_KEY) ?? {};
	}

	/** Flags for a session path; defaults false/false. Undefined path -> false/false. */
	get(path: string | undefined): SessionFlags {
		if (path === undefined) {
			return { pinned: false, archived: false };
		}
		const rec = this.read();
		return {
			pinned: !!rec[path]?.pinned,
			archived: !!rec[path]?.archived,
		};
	}

	/** Set the pinned flag for a path, then persist. */
	setPinned(path: string, pinned: boolean): Promise<void> {
		return this.write(path, "pinned", pinned);
	}

	/** Set the archived flag for a path, then persist. */
	setArchived(path: string, archived: boolean): Promise<void> {
		return this.write(path, "archived", archived);
	}

	/** Remove a path's stored flags entirely (call on delete). */
	async clear(path: string): Promise<void> {
		const rec = this.read();
		if (path in rec) {
			delete rec[path];
			await this.memento.update(STORAGE_KEY, rec);
		}
	}

	/**
	 * Read-modify-write a single flag field for a path. If both `pinned` and
	 * `archived` end up false, the path key is dropped to keep storage tidy.
	 */
	private async write(path: string, field: "pinned" | "archived", value: boolean): Promise<void> {
		const rec = this.read();
		const entry = { ...rec[path], [field]: value };
		if (!entry.pinned && !entry.archived) {
			delete rec[path];
		} else {
			rec[path] = entry;
		}
		await this.memento.update(STORAGE_KEY, rec);
	}
}
