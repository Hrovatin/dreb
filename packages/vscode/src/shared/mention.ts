/**
 * Pure helpers for the composer's inline `@`-mention file picker (Phase 4c).
 *
 * Typing `@` opens a small typeahead dropdown that filters workspace files as
 * the user keeps typing; typing `@@` escalates to the full native file picker.
 * These functions parse the "active mention" out of the composer text at the
 * caret and rank host-supplied file results — kept free of `vscode` and any
 * `node:` builtins so the same code runs in the webview bundle and unit tests
 * (mirroring `shared/format.ts` and `shared/tagged-context.ts`).
 */

import type { FileContextDto } from "./protocol.js";

/** The active `@`-mention token immediately before the caret. */
export interface MentionToken {
	/** Index of the leading `@` in the text. */
	start: number;
	/** Caret index (exclusive end of the token). */
	end: number;
	/** The query typed after the `@` (may be empty). */
	query: string;
}

/**
 * Find the `@`-mention token the caret is currently editing, or `null`.
 *
 * A token is active when, scanning back from the caret, an `@` is found that is
 * at the start of the text or preceded by whitespace, with no whitespace (or a
 * second `@`) between it and the caret. This deliberately does NOT fire for `@`
 * embedded mid-word (e.g. an email address) or once the query contains a space.
 *
 * `@@` is handled by {@link isFullPickerTrigger}, not here — a query starting
 * with `@` is rejected so the two triggers never both fire.
 */
export function activeMention(text: string, caret: number): MentionToken | null {
	const before = text.slice(0, caret);
	// (^|whitespace) @ (no-whitespace, no-@ run) — anchored at the caret.
	const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
	if (!match) return null;
	const query = match[1] ?? "";
	const start = caret - query.length - 1; // position of the `@`
	return { start, end: caret, query };
}

/**
 * Whether the text just before the caret is a `@@` full-picker trigger — two
 * consecutive `@` at the start of a token (start of text or after whitespace).
 */
export function isFullPickerTrigger(text: string, caret: number): boolean {
	return /(?:^|\s)@@$/.test(text.slice(0, caret));
}

/**
 * Replace the active mention token's `@query` span with `replacement`, returning
 * the new text and the caret position after the replacement. Used to strip the
 * `@` token when a file is selected (replacement `""`) or when `@@` escalates.
 */
export function replaceMention(
	text: string,
	token: { start: number; end: number },
	replacement: string,
): { text: string; caret: number } {
	const next = text.slice(0, token.start) + replacement + text.slice(token.end);
	return { text: next, caret: token.start + replacement.length };
}

/** Lowercase last path segment of a forward-slashed path. */
function filename(path: string): string {
	const parts = path.split("/").filter(Boolean);
	return (parts.at(-1) ?? path).toLowerCase();
}

/**
 * Rank file results for an inline `@`-mention query and cap the list.
 *
 * Ordering (best first): filename prefix match, then filename substring, then
 * path substring, then non-matches; ties break by shorter path, then alpha. An
 * empty query keeps input order (already host-ordered) and just applies `cap`.
 */
export function rankFileResults(results: readonly FileContextDto[], query: string, cap: number): FileContextDto[] {
	const q = query.trim().toLowerCase();
	if (q.length === 0) return results.slice(0, cap);
	const score = (dto: FileContextDto): number => {
		const name = filename(dto.path);
		const path = dto.path.toLowerCase();
		if (name.startsWith(q)) return 0;
		if (name.includes(q)) return 1;
		if (path.includes(q)) return 2;
		return 3;
	};
	return results
		.map((dto, index) => ({ dto, index, rank: score(dto) }))
		.filter((entry) => entry.rank < 3)
		.sort((a, b) => {
			if (a.rank !== b.rank) return a.rank - b.rank;
			if (a.dto.path.length !== b.dto.path.length) return a.dto.path.length - b.dto.path.length;
			if (a.dto.path !== b.dto.path) return a.dto.path < b.dto.path ? -1 : 1;
			return a.index - b.index;
		})
		.slice(0, cap)
		.map((entry) => entry.dto);
}

/** Maximum number of inline file suggestions shown in the dropdown. */
export const MENTION_RESULT_CAP = 10;
