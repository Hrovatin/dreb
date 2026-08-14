import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { SessionGroupDto, SessionListDto, SessionSummaryDto } from "../../shared/session-list.js";
import { onHostMessage, postToHost } from "./vscode-api.js";

export function SidebarApp() {
	const [list, setList] = createStore<SessionListDto>({ currentCwd: "", groups: [] });

	onMount(() => {
		const off = onHostMessage((msg) => {
			// Reconcile by stable `key` (present on both groups and session rows) so
			// unchanged rows/groups keep their component + DOM identity across the
			// ~150ms streaming refreshes. Without this, replacing the whole list
			// remounts every row and discards in-progress inline renames and the
			// user's expanded/collapsed group state.
			if (msg.type === "list") setList(reconcile(msg.list, { key: "key", merge: false }));
		});
		postToHost({ type: "ready" });
		onCleanup(off);
	});

	return (
		<div class="dreb-sidebar">
			<header class="dreb-side-header">
				<span class="dreb-side-title">SESSIONS</span>
				<span class="dreb-side-spacer" />
				<button
					type="button"
					class="dreb-side-iconbtn"
					title="New session"
					aria-label="New session"
					onClick={() => postToHost({ type: "new" })}
				>
					＋
				</button>
				<button
					type="button"
					class="dreb-side-iconbtn"
					title="Refresh"
					aria-label="Refresh"
					onClick={() => postToHost({ type: "refresh" })}
				>
					⟳
				</button>
			</header>

			<Show
				when={list.groups.length > 0}
				fallback={
					<div class="dreb-side-empty">
						<div class="dreb-side-empty-text">No sessions yet</div>
						<button type="button" class="dreb-side-empty-btn" onClick={() => postToHost({ type: "new" })}>
							New session
						</button>
					</div>
				}
			>
				<div class="dreb-side-list">
					<For each={list.groups}>{(group) => <GroupView group={group} />}</For>
				</div>
			</Show>
		</div>
	);
}

function GroupView(props: { group: SessionGroupDto }) {
	const group = props.group;
	return (
		<details class="dreb-side-group" open={group.kind === "current"}>
			<summary class="dreb-side-group-head">
				<span class="dreb-side-group-label">{group.label}</span>
				<span class="dreb-side-group-count">{group.sessions.length}</span>
			</summary>
			<div class="dreb-side-group-body">
				<For each={group.sessions}>{(session) => <SessionRow session={session} groupKind={group.kind} />}</For>
			</div>
		</details>
	);
}

function SessionRow(props: { session: SessionSummaryDto; groupKind: SessionGroupDto["kind"] }) {
	const [editing, setEditing] = createSignal(false);
	const [draft, setDraft] = createSignal("");

	const session = () => props.session;

	const startRename = () => {
		setDraft(session().title);
		setEditing(true);
	};

	const commitRename = () => {
		if (!editing()) return;
		setEditing(false);
		const name = draft().trim();
		if (name.length === 0 || name === session().title) return;
		postToHost({ type: "rename", key: session().key, name });
	};

	const cancelRename = () => setEditing(false);

	const onEditKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Enter") {
			event.preventDefault();
			commitRename();
		} else if (event.key === "Escape") {
			event.preventDefault();
			cancelRename();
		}
	};

	const stop = (event: Event) => event.stopPropagation();

	const open = () => postToHost({ type: "open", key: session().key });

	const meta = () => {
		const parts = [relativeTime(session().modified), `${session().messageCount} msgs`];
		if (props.groupKind !== "current") {
			const base = lastSegment(session().cwd);
			if (base) parts.push(base);
		}
		return parts.join(" · ");
	};

	return (
		<div class="dreb-side-row" classList={{ "dreb-side-row-live": session().live }}>
			<Show
				when={editing()}
				fallback={
					<button type="button" class="dreb-side-row-main" onClick={open}>
						<div class="dreb-side-row-line1">
							<StatusIndicator state={session().state} />
							<span class="dreb-side-row-title" title={session().title}>
								<Show when={session().pinned}>
									<span class="dreb-side-pin" title="Pinned">
										📌
									</span>
								</Show>
								{session().title}
							</span>
						</div>
						<div class="dreb-side-row-line2">{meta()}</div>
					</button>
				}
			>
				<div class="dreb-side-row-main">
					<div class="dreb-side-row-line1">
						<StatusIndicator state={session().state} />
						<input
							type="text"
							class="dreb-side-rename-input"
							value={draft()}
							onClick={stop}
							onInput={(e) => setDraft(e.currentTarget.value)}
							onKeyDown={onEditKeyDown}
							onBlur={commitRename}
							ref={(el) => queueMicrotask(() => el.focus())}
						/>
					</div>
					<div class="dreb-side-row-line2">{meta()}</div>
				</div>
			</Show>

			<div class="dreb-side-actions">
				<button
					type="button"
					class="dreb-side-action"
					title="Rename"
					aria-label="Rename session"
					onClick={(e) => {
						stop(e);
						startRename();
					}}
				>
					✎
				</button>
				<button
					type="button"
					class="dreb-side-action"
					title={session().pinned ? "Unpin" : "Pin"}
					aria-label={session().pinned ? "Unpin session" : "Pin session"}
					onClick={(e) => {
						stop(e);
						postToHost({ type: "pin", key: session().key, pinned: !session().pinned });
					}}
				>
					📌
				</button>
				<button
					type="button"
					class="dreb-side-action"
					title={session().archived ? "Unarchive" : "Archive"}
					aria-label={session().archived ? "Unarchive session" : "Archive session"}
					onClick={(e) => {
						stop(e);
						postToHost({ type: "archive", key: session().key, archived: !session().archived });
					}}
				>
					🗄
				</button>
				<button
					type="button"
					class="dreb-side-action"
					title="Delete"
					aria-label="Delete session"
					onClick={(e) => {
						stop(e);
						postToHost({ type: "delete", key: session().key });
					}}
				>
					🗑
				</button>
			</div>
		</div>
	);
}

function StatusIndicator(props: { state: SessionSummaryDto["state"] }) {
	return (
		<Show
			when={props.state === "running"}
			fallback={
				<Show
					when={props.state === "needs-input"}
					fallback={<span class="dreb-state-idle" role="img" title="Idle" aria-label="Idle" />}
				>
					<span class="dreb-state-needs-input" role="img" title="Needs input" aria-label="Needs input" />
				</Show>
			}
		>
			<span class="dreb-state-running" role="img" title="Running" aria-label="Running" />
		</Show>
	);
}

/** Human-friendly relative time from an ISO timestamp. */
export function relativeTime(iso: string): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "";
	const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/** Last path segment of a slash/back-slash separated path. */
function lastSegment(path: string): string {
	if (!path) return "";
	return (
		path
			.replace(/[\\/]+$/, "")
			.split(/[\\/]/)
			.filter(Boolean)
			.pop() ?? ""
	);
}
