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
 * Ordering is deliberately **deterministic** and stable — pinned-first, then a
 * per-session manual order (when the user has dragged rows) else creation time
 * DESC (newest-created first), then title, then key. Neither live run-state nor
 * the mutable `modified` timestamp affects placement, so rows keep a fixed
 * position and don't jump around as sessions become active or stream (see
 * AGENTS.md "Determinism Over Recency").
 *
 * Like `shared/tagged-context.ts`, this module is intentionally free of
 * `vscode` AND of any `node:` builtins so it can be bundled into the webview,
 * imported by the host, and unit tested in plain node.
 */

/** A session's live run state derived from its projected transcript. */
export type SessionRunState = "running" | "needs-input" | "background" | "idle";

/** Per-session flags the host persists (keyed by session path). */
export interface SessionFlags {
	pinned: boolean;
	archived: boolean;
}

/** Derive a session's live run state from its projected transcript.
 *
 * Precedence: an in-flight main turn is `running`; otherwise a pending blocking
 * UI request means the model is `needs-input` (the user must act now, so it
 * outranks background work); otherwise any still-running background agent means
 * work is happening in the `background`; otherwise the session is `idle`. */
export function deriveSessionStatus(transcript: {
	streaming: boolean;
	uiRequests: unknown[];
	backgroundAgentIds?: unknown[];
}): SessionRunState {
	if (transcript.streaming) return "running";
	if (transcript.uiRequests.length > 0) return "needs-input";
	if (transcript.backgroundAgentIds && transcript.backgroundAgentIds.length > 0) return "background";
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
	/** ISO timestamp of session creation. Stable — drives default ordering
	 * (newest-created first) and, unlike `modified`, never changes with activity. */
	created: string;
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
	/** Row `key` of the session whose chat tab is currently focused, so the
	 * sidebar can highlight "the session you're looking at". `undefined` when no
	 * dreb chat tab is focused. Never affects row ordering (see the module doc's
	 * determinism note). */
	activeKey?: string;
}

/** A persisted session discovered on disk. */
export interface DiskSessionInput {
	path: string;
	cwd: string;
	name?: string;
	firstMessage: string;
	modified: string;
	/** ISO timestamp of session creation (stable; drives default ordering). */
	created: string;
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
	/** ISO timestamp of session creation, when known. A brand-new not-yet-persisted
	 * session has none; ordering then falls back to `modified` or now. */
	created?: string;
	messageCount?: number;
}

/** Inputs to {@link buildSessionList}. */
export interface BuildSessionListInput {
	currentCwd: string;
	disk: DiskSessionInput[];
	live: LiveSessionInput[];
	flags: (path: string | undefined) => SessionFlags;
	/** Row `key` of the currently-focused chat tab, passed straight through to
	 * {@link SessionListDto.activeKey}. Does not influence ordering or grouping. */
	activeKey?: string;
	/** Optional per-session manual order rank (keyed by session path). Present
	 * only for sessions the user has dragged to reorder; a defined rank overrides
	 * the default creation-time ordering within a group. Undefined -> use
	 * creation time. */
	order?: (path: string | undefined) => number | undefined;
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
	const { currentCwd, disk, live, flags, order } = input;
	const orderOf = (path: string | undefined): number | undefined => (order ? order(path) : undefined);

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
			created: d.created,
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
			created: l.created ?? l.modified ?? new Date().toISOString(),
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

	// 4. Deterministic, stable ordering — pinned first, then by an effective rank
	//    (a persisted manual drag order when present, else creation time), highest
	//    rank first, then title ascending, then key ascending. Neither live
	//    run-state nor the mutable `modified` timestamp affects ordering, so rows
	//    keep a fixed position (see AGENTS.md "Determinism Over Recency").
	//
	//    Manual ranks are small integers (see SessionOrderStore), which sit below
	//    creation-time epoch values, so a session created *after* a manual reorder
	//    still surfaces at the top by newest-created while the dragged block keeps
	//    its relative order beneath it.
	const rankOf = (row: SessionSummaryDto): number => {
		const manual = orderOf(row.path);
		if (manual !== undefined) return manual;
		const t = Date.parse(row.created);
		return Number.isNaN(t) ? 0 : t;
	};
	const sortRows = (list: SessionSummaryDto[]): SessionSummaryDto[] =>
		list.slice().sort((a, b) => {
			if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
			const ra = rankOf(a);
			const rb = rankOf(b);
			if (ra !== rb) return ra < rb ? 1 : -1;
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

	return { currentCwd, groups, activeKey: input.activeKey };
}
