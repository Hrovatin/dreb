/**
 * Host ↔ webview wire protocol.
 *
 * The extension host and the webview communicate exclusively through
 * `postMessage` (structured-clone JSON). This module defines the message
 * envelopes and the small DTOs that cross the boundary. It intentionally does
 * NOT import `@dreb/coding-agent` so the webview bundle stays free of any
 * node-only code — the mirror of the dashboard's `src/shared/protocol.ts`.
 */

import type { TranscriptState } from "./projection.js";

/** A slash command offered in the composer dropdown. */
export interface SlashCommandDto {
	name: string;
	description?: string;
	/** Origin: an agent command routed to `prompt`, or a host-handled builtin. */
	source: "agent" | "builtin";
}

/** The active model, as shown in the status header. */
export interface ModelStatus {
	provider: string;
	id: string;
	name?: string;
}

/** Cost summary (mirrors the TUI footer): per-session spend plus optional daily. */
export interface CostStatus {
	/** Current session cost in USD. */
	session: number;
	/** Daily spend in USD across sessions, when known. */
	daily?: number;
	/** True when running against a subscription rather than metered API. */
	usingSubscription: boolean;
}

/** Context-window usage — the same numbers the TUI footer renders. */
export interface ContextUsageStatus {
	/** Estimated context tokens, or null when unknown (e.g. right after compaction). */
	tokens: number | null;
	contextWindow: number;
	/** Usage as a percentage of the context window, or null when unknown. */
	percent: number | null;
}

/** Connection/identity + runtime status the webview shows in its header. */
export interface HostStatus {
	connected: boolean;
	cwd: string;
	/** Active model (TUI parity); undefined before the first status refresh. */
	model?: ModelStatus;
	/** Active thinking level (off…xhigh). */
	thinkingLevel?: string;
	/** Cost summary (session + optional daily). */
	cost?: CostStatus;
	/** Context-window usage. */
	contextUsage?: ContextUsageStatus;
	error?: string;
}

/** A response to a blocking extension-UI request, mirroring RpcExtensionUIResponse. */
export type UiResponse =
	| { id: string; value: string }
	| { id: string; confirmed: boolean }
	| { id: string; selected: string[]; customText?: string }
	| { id: string; cancelled: true };

/** One file pending change-review, shown in the webview indicator + SCM group. */
export interface ReviewFileDto {
	/** Repo-relative path. */
	path: string;
	status: "modified" | "added" | "deleted" | "binary";
	/** Number of textual hunks (0 for binary/whole-file changes). */
	hunkCount: number;
}

/** Change-review state mirrored to the webview. `enabled` is false outside a git
 * repo (review degrades to a notice); `files` is empty when nothing is pending. */
export interface ReviewStateDto {
	enabled: boolean;
	files: ReviewFileDto[];
}

/** An editor selection tagged into the chat (Phase 4). Shown as a removable
 * composer chip and folded into the next prompt as located context — inlined as
 * a fenced code block when small, or a path + line-span reference when large. */
export interface SelectionContextDto {
	kind: "selection";
	/** Workspace-relative source path (forward slashes), or basename when the
	 * file is outside the workspace. */
	path: string;
	/** 1-based inclusive start line of the selection. */
	startLine: number;
	/** 1-based inclusive end line of the selection. */
	endLine: number;
	/** Document language id, for the fenced block (may be empty). */
	language: string;
	/** The selected text, captured at tag time. */
	text: string;
}

/** A file or folder tagged into the chat (Phase 4b) via the `@` picker. Shown as
 * a removable composer chip and folded into the next prompt as a **path
 * reference only** (never the contents) so the agent can explore it as needed. */
export interface FileContextDto {
	kind: "file";
	/** Workspace-relative path (forward slashes), or basename when outside the
	 * workspace. */
	path: string;
	/** True when the tagged path is a directory. */
	isDirectory?: boolean;
}

/** A context attachment tagged into the chat: an editor selection or a
 * file/folder reference. Carried across the host↔webview boundary and folded
 * into the next prompt. */
export type TaggedContextDto = SelectionContextDto | FileContextDto;

/** Messages sent from the host to the webview. */
export type HostToWebview =
	| { type: "snapshot"; state: TranscriptState; commands: SlashCommandDto[]; status: HostStatus }
	| { type: "event"; event: unknown }
	| { type: "commands"; commands: SlashCommandDto[] }
	| { type: "status"; status: HostStatus }
	/** Change-review set changed (per-turn detection, accept/revert). */
	| { type: "review"; review: ReviewStateDto }
	/** An editor selection was tagged into the chat — add it as a composer chip. */
	| { type: "tag-context"; context: TaggedContextDto };

/** Messages sent from the webview to the host. */
export type WebviewToHost =
	| { type: "ready" }
	| { type: "submit"; text: string; attachments?: TaggedContextDto[] }
	| { type: "abort" }
	| { type: "refresh-commands" }
	| { type: "ui-response"; response: UiResponse }
	/** Open the native model picker (header click). */
	| { type: "pick-model" }
	/** Open the native thinking-level picker (header click). */
	| { type: "pick-thinking" }
	/** Open the native file/folder picker to tag context (composer `@`). */
	| { type: "pick-file" }
	/** Open the baseline→current diff for a reviewed file (indicator click). */
	| { type: "review-open-diff"; path: string };
