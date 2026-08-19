/**
 * Host ↔ webview wire protocol.
 *
 * The extension host and the webview communicate exclusively through
 * `postMessage` (structured-clone JSON). This module defines the message
 * envelopes and the small DTOs that cross the boundary. It intentionally does
 * NOT import `@dreb/coding-agent` so the webview bundle stays free of any
 * node-only code — the mirror of the dashboard's `src/shared/protocol.ts`.
 */

import type { ComposerPrefillMode } from "./composer-prefill.js";
import type { Checkpoint, TranscriptState } from "./projection.js";

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

/** A code symbol (class / function / method / …) tagged into the chat via the
 * inline `@` picker (Phase 4c). Shown as a removable composer chip and folded
 * into the next prompt as a **located reference** (path + line + symbol name)
 * so the agent can jump straight to the definition — never the body text. */
export interface SymbolContextDto {
	kind: "symbol";
	/** Symbol name, e.g. "SessionController" or "handleClick". */
	name: string;
	/** Human-readable kind label, e.g. "class", "function", "method". */
	symbolKind: string;
	/** Workspace-relative path (forward slashes) of the file that defines the
	 * symbol, or the absolute path when it lives outside the workspace. */
	path: string;
	/** 1-based line of the symbol's definition. */
	line: number;
}

/** A context attachment tagged into the chat: an editor selection, a file/folder
 * reference, or a code symbol. Carried across the host↔webview boundary and
 * folded into the next prompt. */
export type TaggedContextDto = SelectionContextDto | FileContextDto | SymbolContextDto;

/** An image pasted into the composer, attached to the next message. Carried
 * across the host↔webview boundary as base64 (structured-clone JSON) and mapped
 * on the host to the agent's `ImageContent` before being sent over RPC. Unlike a
 * {@link TaggedContextDto}, an image is NOT folded into the prompt text — it
 * travels as a separate image content part so a vision-capable model can see it.
 * This mirrors `ImageContent` from `@dreb/ai` minus the `"image"` type tag, kept
 * here so `protocol.ts` stays free of any `@dreb` import. */
export interface ImageAttachmentDto {
	/** Base64-encoded image bytes (no data-URL prefix). */
	data: string;
	/** MIME type, e.g. "image/png" or "image/jpeg". */
	mimeType: string;
}

/** Where a tagged context came from, which decides how the composer surfaces it.
 * `"picker"` (the native `@@` file/folder picker) inserts an inline `@name`
 * reference at the caret in addition to the chip; `"selection"` (an editor
 * selection tagged via a command) stays a chip only. */
export type TagContextOrigin = "selection" | "picker";

/** A clickable code reference the user activated in an answer (Phase 5b). Either
 * a concrete file `path` (optionally with a 1-based `line`/`column`), a `symbol`
 * name to resolve at click time, or both. When a `symbol` is present the host
 * prefers jumping to its definition (workspace symbol provider); the `path`/`line`
 * — captured from the grounding tool hit — is the best-effort fallback location. */
export interface OpenSourceRef {
	/** Workspace-relative (or absolute) file path, forward slashes. */
	path?: string;
	/** 1-based line to reveal/select. */
	line?: number;
	/** 1-based column to place the caret. */
	column?: number;
	/** Symbol name (function/class/heading) to resolve to a definition. */
	symbol?: string;
}

/** A node in the session branch tree (Phase 6), mirroring the RPC `RpcTreeNode`.
 * Drives the branch-tree view; prefer the nested `children` over `parentId` when
 * reconstructing hierarchy. */
export interface SessionTreeNodeDto {
	/** Session entry id. */
	id: string;
	parentId: string | null;
	/** Session entry type (e.g. "message", "label"). */
	type: string;
	/** Message role when `type === "message"` (user/assistant/toolResult/…). */
	role?: string;
	/** Short single-line content preview (whitespace-collapsed). */
	preview: string;
	timestamp: string;
	/** Resolved label, if any. */
	label?: string;
	/** Child nodes, oldest first. */
	children: SessionTreeNodeDto[];
}

/** The session branch tree plus the current leaf (Phase 6). */
export interface SessionTreeDto {
	roots: SessionTreeNodeDto[];
	leafId: string | null;
}

/** One message the user queued while the agent was working — waiting to be
 * delivered to the model. `steer` messages inject into the running turn;
 * `follow-up` messages are delivered after it finishes. Shown as a composer
 * chip until delivered (see the `pending` host→webview message). */
export interface QueuedMessageDto {
	kind: "steer" | "follow-up";
	text: string;
}

/** Messages sent from the host to the webview. */
export type HostToWebview =
	| { type: "snapshot"; state: TranscriptState; commands: SlashCommandDto[]; status: HostStatus }
	| { type: "event"; event: unknown }
	| { type: "commands"; commands: SlashCommandDto[] }
	| { type: "status"; status: HostStatus }
	/** Change-review set changed (per-turn detection, accept/revert). */
	| { type: "review"; review: ReviewStateDto }
	/** A context tag was added to the chat — add it as a composer chip. When
	 * `origin` is `"picker"` (the native `@@` file/folder picker) the composer
	 * also inserts an inline `@name` reference; `"selection"` (an editor
	 * selection) stays a chip only. */
	| { type: "tag-context"; context: TaggedContextDto; origin: TagContextOrigin }
	/** Inline restore/fork controls, aligned to response groups (Phase 6). */
	| { type: "checkpoints"; checkpoints: Checkpoint[] }
	/** The session branch tree, in response to a `show-tree` request (Phase 6). */
	| { type: "tree"; tree: SessionTreeDto }
	/** Results for an inline `@`-mention workspace search, matched to the
	 * request's `requestId` so the webview can drop stale (out-of-order)
	 * responses. Mixes folders, files, and code symbols (in that order). */
	| { type: "mention-results"; requestId: number; results: TaggedContextDto[] }
	/** The queue of pending steer/follow-up messages changed — render them as
	 * chips above the composer (empty clears the chips). */
	| { type: "pending"; messages: QueuedMessageDto[] }
	/** Pre-fill the composer. `mode` controls how it combines with any text the
	 * user has already typed: `"replace"` (default — a user-message fork's re-ask
	 * text) overwrites, while `"prepend"` (queued messages restored on abort)
	 * inserts before the existing text so an in-progress draft is never lost. */
	| { type: "composer-prefill"; text: string; mode?: ComposerPrefillMode };

/** Messages sent from the webview to the host. */
export type WebviewToHost =
	| { type: "ready" }
	| { type: "submit"; text: string; attachments?: TaggedContextDto[]; images?: ImageAttachmentDto[] }
	| { type: "abort" }
	| { type: "refresh-commands" }
	| { type: "ui-response"; response: UiResponse }
	/** Open the native model picker (header click). */
	| { type: "pick-model" }
	/** Open the native thinking-level picker (header click). */
	| { type: "pick-thinking" }
	/** Open the native file/folder picker to tag context (composer `@@`). */
	| { type: "pick-file" }
	/** Inline `@`-mention workspace search: the host replies with a
	 * `mention-results` message carrying the same `requestId` (composer typeahead
	 * dropdown of folders, files, and code symbols). */
	| { type: "search-workspace"; query: string; requestId: number }
	/** Open the baseline→current diff for a reviewed file (indicator click). */
	| { type: "review-open-diff"; path: string }
	/** Accept all pending edits, clearing them from the change-review
	 * accumulation area (review-bar "Accept all"). Routes to the same
	 * `reviewAcceptAll()` path as the SCM title-menu action. */
	| { type: "review-accept-all" }
	/** Open a code reference clicked in an answer (Phase 5b) — a file location
	 * and/or a symbol to resolve to its definition. */
	| { type: "open-source"; ref: OpenSourceRef }
	/** Fork a new branch from a session entry (Phase 6 inline control / tree). */
	| { type: "fork"; entryId: string }
	/** Restore (navigate) to a session entry — rewind or branch-jump (Phase 6). */
	| { type: "navigate-tree"; entryId: string }
	/** Request the session branch tree for the branch-tree view (Phase 6). */
	| { type: "show-tree" };
