/**
 * Message protocol for the sessions sidebar webview.
 *
 * The host pushes the reconciled {@link SessionListDto} down; the webview sends
 * user intents (open/new/rename/pin/archive/delete) and lifecycle signals
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
	| { type: "delete"; key: string };
