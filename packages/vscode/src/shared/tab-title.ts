/**
 * Pure formatter for a chat editor tab's title.
 *
 * Every dreb chat opens as its own editor tab. Titling them all `dreb` makes
 * multiple open sessions indistinguishable in the tab strip and impossible to
 * map back to their row in the Sessions sidebar. {@link formatTabTitle} names
 * each tab after its session (`D: <shortened title>`), keeping a compact
 * run-state marker so a backgrounded / unfocused session's running or
 * needs-input status stays visible in the tab strip — the markers mirror the
 * sidebar's `StatusIndicator`.
 *
 * Like `session-list.ts`, this module is free of `vscode` and of any `node:`
 * builtins so it can be imported by the host and unit tested in plain node.
 */

import type { SessionRunState } from "./session-list.js";

/** Prefix that marks a tab as a dreb chat and keeps its name short in the strip. */
const TAB_PREFIX = "D: ";

/** Shown when a session has no name and no messages yet (matches the sidebar's
 * brand-new-live-session fallback). */
const UNTITLED = "New session";

/** Default cap on the name portion; VS Code elides further, but a hard cap keeps
 * even a wide tab strip readable and predictable. */
const DEFAULT_MAX_LEN = 20;

/** Truncate to `maxLen` with a trailing ellipsis. `text` is expected to be
 * already whitespace-collapsed and trimmed by the caller ({@link formatTabTitle}). */
function shorten(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
}

/** Compact run-state marker appended after the name (empty for idle). */
function stateMarker(state: SessionRunState): string {
	switch (state) {
		case "running":
			return " ●";
		case "needs-input":
			return " ⚠";
		default:
			return "";
	}
}

/**
 * Build a chat tab title from a session's display title and run-state:
 * `D: <shortened title>` plus a compact `●` (running) / `⚠` (needs input)
 * marker. An empty/undefined title falls back to `D: New session`.
 */
export function formatTabTitle(
	title: string | undefined,
	state: SessionRunState,
	maxLen: number = DEFAULT_MAX_LEN,
): string {
	const base = (title ?? "").replace(/\s+/g, " ").trim();
	const name = base.length === 0 ? UNTITLED : shorten(base, maxLen);
	return `${TAB_PREFIX}${name}${stateMarker(state)}`;
}
