/**
 * Sessions sidebar view-model — the vscode-free, unit-testable core behind the
 * `dreb.sessions` webview view. It reconciles on-disk sessions (via the
 * {@link SessionInventory}) with the host's live controllers into a
 * {@link SessionListDto} and routes the sidebar's messages to host actions
 * (open / new / rename / pin / archive / delete).
 *
 * All vscode-specific work (the webview, prompts, the session pool) is injected
 * through {@link SessionsViewDeps}, mirroring how `session-registry.ts` keeps its
 * concurrency core testable and `extension.ts` supplies the vscode glue.
 */

import { buildSessionList, type LiveSessionInput, type SessionListDto } from "../shared/session-list.js";
import type { HostToSidebar, SidebarToHost } from "../shared/sidebar-protocol.js";
import type { SessionFlagsStore } from "./session-flags.js";
import type { SessionInventory } from "./session-inventory.js";
import type { SessionOrderStore } from "./session-order.js";

/** Ports the view-model needs; all vscode/pool specifics live behind these. */
export interface SessionsViewDeps {
	inventory: SessionInventory;
	flags: SessionFlagsStore;
	/** Persisted manual drag order for sessions (keyed by path). */
	order: SessionOrderStore;
	/** The workspace cwd whose sessions sort first. */
	currentCwd: () => string;
	/** Snapshot of the currently-live sessions in the host's pool. */
	liveSessions: () => LiveSessionInput[];
	/** Row `key` of the session whose chat tab is currently focused (for the
	 * active-row highlight), or `undefined` when no dreb chat tab is focused. */
	activeKey?: () => string | undefined;
	/** Resolve a row key to its session `.jsonl` path (for pin/archive/delete),
	 * or undefined for a brand-new not-yet-persisted session. */
	pathForKey: (key: string) => string | undefined;
	/** Push a message to the sidebar webview (no-op when it isn't connected). */
	post: (msg: HostToSidebar) => void;
	/** Open (or resume) a session by row key. */
	openSession: (key: string) => void | Promise<void>;
	/** Start a fresh session in the current workspace. */
	newSession: () => void | Promise<void>;
	/** Rename a session by row key. */
	renameSession: (key: string, name: string) => void | Promise<void>;
	/** Delete a session by row key (host owns the confirmation prompt). */
	deleteSession: (key: string) => void | Promise<void>;
	/** Abort a session's current turn and end it (release its RPC child). */
	stopSession: (key: string) => void | Promise<void>;
	logger?: (line: string) => void;
}

export class SessionsViewModel {
	/** Coalesces overlapping refreshes: at most one build runs at a time, with a
	 * single trailing re-run if more were requested while it was in flight. */
	private refreshing = false;
	private pending = false;

	constructor(private readonly deps: SessionsViewDeps) {}

	/** Handle one message from the sidebar webview. */
	async handle(msg: SidebarToHost): Promise<void> {
		switch (msg.type) {
			case "ready":
			case "refresh":
				await this.refresh();
				return;
			case "open":
				// Opening reveals/spawns a panel and the host refreshes the list as a
				// side effect of the pool change, so no explicit refresh here.
				await this.deps.openSession(msg.key);
				return;
			case "new":
				await this.deps.newSession();
				return;
			case "rename":
				await this.deps.renameSession(msg.key, msg.name);
				await this.refresh();
				return;
			case "pin": {
				const path = this.deps.pathForKey(msg.key);
				if (path) {
					await this.deps.flags.setPinned(path, msg.pinned);
					await this.refresh();
				}
				return;
			}
			case "archive": {
				const path = this.deps.pathForKey(msg.key);
				if (path) {
					await this.deps.flags.setArchived(path, msg.archived);
					await this.refresh();
				}
				return;
			}
			case "delete":
				await this.deps.deleteSession(msg.key);
				await this.refresh();
				return;
			case "reorder": {
				// Resolve the dragged row keys to session paths, dropping any
				// not-yet-persisted (`new:`) rows that have no path to key an order by.
				const paths = msg.orderedKeys
					.map((key) => this.deps.pathForKey(key))
					.filter((p): p is string => p !== undefined);
				if (paths.length > 0) {
					await this.deps.order.setGroupOrder(paths);
					await this.refresh();
				}
				return;
			}
			case "stop":
				// Stopping tears the controller down; the host refreshes the list as a
				// side effect of the pool change. Refresh anyway so a slept/aborted row
				// updates even if the pool change didn't already schedule one.
				await this.deps.stopSession(msg.key);
				await this.refresh();
				return;
		}
	}

	/** Rebuild the grouped list from disk + live sessions and post it. */
	async refresh(): Promise<void> {
		if (this.refreshing) {
			this.pending = true;
			return;
		}
		this.refreshing = true;
		try {
			const list = await this.build();
			this.deps.post({ type: "list", list });
		} catch (err) {
			this.deps.logger?.(`sessions refresh failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.refreshing = false;
			if (this.pending) {
				this.pending = false;
				void this.refresh();
			}
		}
	}

	private async build(): Promise<SessionListDto> {
		const disk = await this.deps.inventory.listAll();
		const live = this.deps.liveSessions();
		return buildSessionList({
			currentCwd: this.deps.currentCwd(),
			disk,
			live,
			flags: (path) => this.deps.flags.get(path),
			activeKey: this.deps.activeKey?.(),
			order: (path) => this.deps.order.get(path),
		});
	}
}
