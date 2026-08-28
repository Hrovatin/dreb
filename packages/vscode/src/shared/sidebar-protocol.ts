/**
 * Message protocol for the sessions sidebar webview.
 *
 * The host pushes the reconciled {@link SessionListDto} down; the webview sends
 * user intents (open/new/rename/pin/archive/delete/stop) and lifecycle signals
 * (`ready`/`refresh`) back up. Like the rest of `shared/`, this module carries
 * only plain data types and is free of `vscode` and `node:` imports.
 */

import type { SessionListDto } from "./session-list.js";

/** Host -> sidebar webview. */
export type HostToSidebar = { type: "list"; list: SessionListDto };

/** Sidebar webview -> host. */
export type SidebarToHost =
	| { type: "ready" }
	| { type: "open"; key: string }
	| { type: "new" }
	| { type: "refresh" }
	| { type: "rename"; key: string; name: string }
	| { type: "pin"; key: string; pinned: boolean }
	| { type: "archive"; key: string; archived: boolean }
	| { type: "delete"; key: string }
	/** Persist a manual drag order for one group. `orderedKeys` is the group's
	 * rows in the exact top-to-bottom order the user arranged them. */
	| { type: "reorder"; groupKey: string; orderedKeys: string[] }
	/** Abort the session's current turn and end it (release its RPC child). The
	 * only way to deliberately interrupt a working agent — closing a tab never
	 * does. */
	| { type: "stop"; key: string };
