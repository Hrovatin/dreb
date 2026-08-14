/**
 * Enumerate on-disk dreb sessions for the extension sidebar without importing
 * `vscode`. The heavy lifting lives in `@dreb/coding-agent`'s `SessionManager`,
 * which is ESM-only and therefore lazily imported at call time (the same pattern
 * the dashboard uses: `const { SessionManager } = await import("@dreb/coding-agent")`).
 *
 * The core `SessionInfo` records carry `Date` timestamps and extra fields that
 * are neither JSON-serialisable nor needed by the webview, so they are mapped to
 * a trimmed, ISO-string `DiskSession` shape. Mapping and manager wiring are
 * factored apart so the pure conversion and the delegation logic are unit-testable
 * without a real filesystem or a resolvable dependency.
 */

/** A disk session mapped to JSON-serialisable, sidebar-ready fields. */
export interface DiskSession {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
}

/** Outcome of a delete: `SessionManager.deleteSession` trashes first (recoverable)
 * and falls back to a permanent unlink, reporting which path was taken. It never
 * throws — a failure is signalled by `ok: false` plus an `error` message. */
export interface DeleteSessionResult {
	ok: boolean;
	method: "trash" | "unlink";
	error?: string;
}

export interface SessionInventory {
	listForCwd(cwd: string): Promise<DiskSession[]>;
	listAll(): Promise<DiskSession[]>;
	/** Delete a session `.jsonl` via dreb's manager: trash-first with an unlink
	 * fallback, `.jsonl` validation, and an active-session guard. */
	deleteSession(path: string, opts?: { activeSessionPath?: string }): Promise<DeleteSessionResult>;
}

/**
 * A `SessionManager.list`/`.listAll`-returned record. Timestamps may arrive as
 * `Date` (in-process) or `string` (already serialised), so both are accepted.
 */
export interface RawSessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: Date | string;
	modified: Date | string;
	messageCount: number;
	firstMessage: string;
}

/** Test seam: the subset of `SessionManager`'s static API this module consumes. */
export interface SessionManagerLike {
	list(cwd: string): Promise<RawSessionInfo[]>;
	listAll(): Promise<RawSessionInfo[]>;
	deleteSession(path: string, opts?: { activeSessionPath?: string }): Promise<DeleteSessionResult>;
}

/**
 * Convert a raw `SessionInfo`-like record into a trimmed `DiskSession`. Both
 * timestamps are normalised to ISO strings via `new Date(x).toISOString()`, and
 * an absent `name` is omitted rather than emitted as `undefined`.
 */
export function toDiskSession(info: RawSessionInfo): DiskSession {
	const disk: DiskSession = {
		path: info.path,
		id: info.id,
		cwd: info.cwd,
		created: new Date(info.created).toISOString(),
		modified: new Date(info.modified).toISOString(),
		messageCount: info.messageCount,
		firstMessage: info.firstMessage,
	};
	if (info.name !== undefined) disk.name = info.name;
	return disk;
}

/** Test seam: build an inventory from an injected SessionManager-like object. */
export function inventoryFrom(manager: SessionManagerLike): SessionInventory {
	return {
		async listForCwd(cwd: string): Promise<DiskSession[]> {
			const sessions = await manager.list(cwd);
			return sessions.map(toDiskSession);
		},
		async listAll(): Promise<DiskSession[]> {
			const sessions = await manager.listAll();
			return sessions.map(toDiskSession);
		},
		deleteSession(path: string, opts?: { activeSessionPath?: string }): Promise<DeleteSessionResult> {
			return manager.deleteSession(path, opts);
		},
	};
}

/** Real inventory backed by @dreb/coding-agent's SessionManager (lazy-imported). */
export function createSessionInventory(): SessionInventory {
	// The specifier is held in a variable so bundlers treat this as a genuine
	// runtime dynamic import (the package is ESM-only and resolved on demand,
	// mirroring the dashboard's `await import("@dreb/coding-agent")`) rather than
	// eagerly attempting to resolve/bundle the package entry at build time.
	const pkg = "@dreb/coding-agent";
	return {
		async listForCwd(cwd: string): Promise<DiskSession[]> {
			const { SessionManager } = await import(pkg);
			return inventoryFrom(SessionManager as unknown as SessionManagerLike).listForCwd(cwd);
		},
		async listAll(): Promise<DiskSession[]> {
			const { SessionManager } = await import(pkg);
			return inventoryFrom(SessionManager as unknown as SessionManagerLike).listAll();
		},
		async deleteSession(path: string, opts?: { activeSessionPath?: string }): Promise<DeleteSessionResult> {
			const { SessionManager } = await import(pkg);
			return inventoryFrom(SessionManager as unknown as SessionManagerLike).deleteSession(path, opts);
		},
	};
}
