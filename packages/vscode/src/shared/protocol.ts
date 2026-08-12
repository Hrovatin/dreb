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

/** Messages sent from the host to the webview. */
export type HostToWebview =
	| { type: "snapshot"; state: TranscriptState; commands: SlashCommandDto[]; status: HostStatus }
	| { type: "event"; event: unknown }
	| { type: "commands"; commands: SlashCommandDto[] }
	| { type: "status"; status: HostStatus };

/** Messages sent from the webview to the host. */
export type WebviewToHost =
	| { type: "ready" }
	| { type: "submit"; text: string }
	| { type: "abort" }
	| { type: "refresh-commands" }
	| { type: "ui-response"; response: UiResponse }
	/** Open the native model picker (header click). */
	| { type: "pick-model" }
	/** Open the native thinking-level picker (header click). */
	| { type: "pick-thinking" };
