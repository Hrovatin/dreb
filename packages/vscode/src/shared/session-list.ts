/**
 * Pure session-list model shared between the host and the sidebar webview.
 *
 * The sidebar lists sessions from two sources that must be reconciled into a
 * single, deterministically ordered set of grouped rows: **disk** sessions
 * (persisted `.jsonl` transcripts discovered on the filesystem) and **live**
 * sessions (controllers currently running in the host's pool). A live session
 * whose `path` matches a disk row is the *same* session — it must merge onto
 * that row (so opening it round-trips through the pool key) rather than showing
 * twice; a live session without a path is a brand-new not-yet-persisted one.
 *
 * Ordering is deliberately **deterministic** — pinned-first, then modified
 * DESC, then title, then key — and live run-state never affects placement, so
 * rows don't jump around as sessions stream (see AGENTS.md "Determinism Over
 * Recency").
 *
 * Like `shared/tagged-context.ts`, this module is intentionally free of
 * `vscode` AND of any `node:` builtins so it can be bundled into the webview,
 * imported by the host, and unit tested in plain node.
 */

/** A session's live run state derived from its projected transcript. */
export type SessionRunState = "running" | "needs-input" | "idle";

/** Per-session flags the host persists (keyed by session path). */
export interface SessionFlags {
	pinned: boolean;
	archived: boolean;
}

/** Derive a session's live run state from its projected transcript. */
export function deriveSessionStatus(transcript: { streaming: boolean; uiRequests: unknown[] }): SessionRunState {
	if (transcript.streaming) return "running";
	if (transcript.uiRequests.length > 0) return "needs-input";
	return "idle";
}

/** One row in the sidebar list, carried across the host↔webview boundary. */
export interface SessionSummaryDto {
	/** Stable identity used to open/dispose (pool key; = path for disk-only rows). */
	key: string;
	/** Session `.jsonl` file path when known (undefined for a brand-new not-yet-persisted live session). */
	path?: string;
	cwd: string;
	/** `name || firstMessage || "New session"`. */
	title: string;
	/** ISO timestamp. */
	modified: string;
	messageCount: number;
	/** `"idle"` for disk-only rows. */
	state: SessionRunState;
	/** True when a controller is live for this row. */
	live: boolean;
	pinned: boolean;
	archived: boolean;
}

/** A labelled group of session rows. */
export interface SessionGroupDto {
	/** Stable identity (`"<kind>:<cwd>"`) so the webview can reconcile groups by
	 * key across refreshes instead of remounting them. */
	key: string;
	kind: "current" | "project" | "archived";
	/** Group cwd (`""` for archived). */
	cwd: string;
	/** `"This workspace" | basename(cwd) | "Archived"`. */
	label: string;
	sessions: SessionSummaryDto[];
}

/** The full grouped list sent host → sidebar webview. */
export interface SessionListDto {
	currentCwd: string;
	groups: SessionGroupDto[];
}

/** A persisted session discovered on disk. */
export interface DiskSessionInput {
	path: string;
	cwd: string;
	name?: string;
	firstMessage: string;
	modified: string;
	messageCount: number;
}

/** A session with a live controller in the host's pool. */
export interface LiveSessionInput {
	key: string;
	cwd: string;
	path?: string;
	state: SessionRunState;
	title?: string;
	modified?: string;
	messageCount?: number;
}

/** Inputs to {@link buildSessionList}. */
export interface BuildSessionListInput {
	currentCwd: string;
	disk: DiskSessionInput[];
	live: LiveSessionInput[];
	flags: (path: string | undefined) => SessionFlags;
}

/** Last path segment of a slash/back-slash separated path (falls back to the
 * whole path when there is no separator). */
function basename(cwd: string): string {
	return (
		cwd
			.replace(/[\\/]+$/, "")
			.split(/[\\/]/)
			.filter(Boolean)
			.pop() ?? cwd
	);
}

/**
 * Reconcile disk and live sessions into a single deterministically ordered,
 * grouped list. See the module doc for the merge/ordering rules.
 */
export function buildSessionList(input: BuildSessionListInput): SessionListDto {
	const { currentCwd, disk, live, flags } = input;

	// 1. Map disk sessions to rows, indexed by path for live merging.
	const rows: SessionSummaryDto[] = [];
	const byPath = new Map<string, SessionSummaryDto>();
	for (const d of disk) {
		const f = flags(d.path);
		const row: SessionSummaryDto = {
			key: d.path,
			path: d.path,
			cwd: d.cwd,
			title: d.name?.trim() || d.firstMessage?.trim() || "(untitled session)",
			modified: d.modified,
			messageCount: d.messageCount,
			state: "idle",
			live: false,
			pinned: f.pinned,
			archived: f.archived,
		};
		rows.push(row);
		byPath.set(d.path, row);
	}

	// 2. Merge live sessions onto matching disk rows, else append.
	for (const l of live) {
		const existing = l.path ? byPath.get(l.path) : undefined;
		if (existing) {
			existing.state = l.state;
			existing.live = true;
			existing.key = l.key;
			if (l.title !== undefined) existing.title = l.title;
			if (l.modified !== undefined) existing.modified = l.modified;
			if (l.messageCount !== undefined) existing.messageCount = l.messageCount;
			continue;
		}
		const f = flags(l.path);
		const row: SessionSummaryDto = {
			key: l.key,
			path: l.path,
			cwd: l.cwd,
			title: l.title?.trim() || "New session",
			modified: l.modified ?? new Date().toISOString(),
			messageCount: l.messageCount ?? 0,
			state: l.state,
			live: true,
			pinned: f.pinned,
			archived: f.archived,
		};
		rows.push(row);
		if (l.path) byPath.set(l.path, row);
	}

	// 3. Group over the merged rows.
	const archived: SessionSummaryDto[] = [];
	const current: SessionSummaryDto[] = [];
	const projects = new Map<string, SessionSummaryDto[]>();
	for (const row of rows) {
		if (row.archived) {
			archived.push(row);
		} else if (row.cwd === currentCwd) {
			current.push(row);
		} else {
			const bucket = projects.get(row.cwd);
			if (bucket) bucket.push(row);
			else projects.set(row.cwd, [row]);
		}
	}

	// 4. Deterministic ordering — pinned first, then modified DESC, then title
	//    ascending, then key ascending. Live run-state never affects ordering.
	const sortRows = (list: SessionSummaryDto[]): SessionSummaryDto[] =>
		list.slice().sort((a, b) => {
			if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
			if (a.modified !== b.modified) return a.modified < b.modified ? 1 : -1;
			if (a.title !== b.title) return a.title < b.title ? -1 : 1;
			return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
		});

	// 5. Assemble groups: current first, project groups sorted by cwd ascending,
	//    archived last. Omit empty groups.
	const groups: SessionGroupDto[] = [];
	if (current.length > 0) {
		groups.push({
			key: `current:${currentCwd}`,
			kind: "current",
			cwd: currentCwd,
			label: "This workspace",
			sessions: sortRows(current),
		});
	}
	for (const cwd of [...projects.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
		const bucket = projects.get(cwd);
		if (bucket && bucket.length > 0) {
			groups.push({ key: `project:${cwd}`, kind: "project", cwd, label: basename(cwd), sessions: sortRows(bucket) });
		}
	}
	if (archived.length > 0) {
		groups.push({ key: "archived:", kind: "archived", cwd: "", label: "Archived", sessions: sortRows(archived) });
	}

	return { currentCwd, groups };
}
