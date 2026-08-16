/**
 * Pure helpers for the composer's inline `@`-mention file picker (Phase 4c).
 *
 * Typing `@` opens a small typeahead dropdown that filters the workspace as the
 * user keeps typing (folders, files, then code symbols); typing `@@` escalates
 * to the full native file picker. These functions parse the "active mention" out
 * of the composer text at the caret, rank host-supplied results, and escape a
 * query into a glob — kept free of `vscode` and any `node:` builtins so the same
 * code runs in the webview bundle, the host search, and unit tests (mirroring
 * `shared/format.ts` and `shared/tagged-context.ts`).
 */

import type { TaggedContextDto } from "./protocol.js";

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

/** Ordering tier by result kind: folders first, then files, then symbols —
 * so the dropdown reads folders → files → classes/functions top to bottom. */
function kindRank(dto: TaggedContextDto): number {
	if (dto.kind === "file") return dto.isDirectory ? 0 : 1;
	if (dto.kind === "symbol") return 2;
	return 1; // selections never appear in mention results; treat as a file tier.
}

/** The lowercased (name, path) a query is matched against for one result. For a
 * symbol the "name" is the symbol identifier; for a file/folder it is the last
 * path segment. */
function matchText(dto: TaggedContextDto): { name: string; path: string } {
	if (dto.kind === "symbol") return { name: dto.name.toLowerCase(), path: dto.path.toLowerCase() };
	if (dto.kind === "file") return { name: filename(dto.path), path: dto.path.toLowerCase() };
	return { name: "", path: "" };
}

/** The path used for tiebreaking (shorter/alpha) — the file/folder path or the
 * symbol's defining file path. */
function pathOf(dto: TaggedContextDto): string {
	return dto.kind === "selection" ? "" : dto.path;
}

/**
 * Rank inline `@`-mention results and cap the list. Results are grouped by kind
 * (folders, then files, then symbols) and, within each group, ordered by
 * relevance to `query`: name prefix, then name substring, then path substring;
 * non-matches are dropped. Ties break by shorter path, then alphabetically. An
 * empty query keeps the host's per-kind order and just applies the kind grouping
 * and `cap`.
 */
export function rankMentionResults(
	results: readonly TaggedContextDto[],
	query: string,
	cap: number,
): TaggedContextDto[] {
	const q = query.trim().toLowerCase();
	const scored = results.map((dto, index) => {
		const { name, path } = matchText(dto);
		let match: number;
		if (q.length === 0) match = 0;
		else if (name.startsWith(q)) match = 0;
		else if (name.includes(q)) match = 1;
		else if (path.includes(q)) match = 2;
		else match = 3;
		return { dto, index, kind: kindRank(dto), match };
	});
	return scored
		.filter((entry) => entry.match < 3)
		.sort((a, b) => {
			if (a.kind !== b.kind) return a.kind - b.kind;
			// Empty query: preserve the host's order within each kind group.
			if (q.length === 0) return a.index - b.index;
			if (a.match !== b.match) return a.match - b.match;
			const ap = pathOf(a.dto);
			const bp = pathOf(b.dto);
			if (ap.length !== bp.length) return ap.length - bp.length;
			if (ap !== bp) return ap < bp ? -1 : 1;
			return a.index - b.index;
		})
		.slice(0, cap)
		.map((entry) => entry.dto);
}

/**
 * Escape glob metacharacters so a typed query is matched literally within a
 * `findFiles` include pattern (a stray `{`, `[`, `*`, `?`, `@` would otherwise
 * corrupt the glob). Path separators in the query collapse to a single `*`
 * wildcard so `src/app` still filters. Pure (no `vscode`), so the host search
 * and its unit tests share one implementation.
 */
export function escapeGlob(query: string): string {
	const special = new Set(["*", "?", "{", "}", "[", "]", "(", ")", "!", "+", "@"]);
	let out = "";
	for (const ch of query) {
		if (ch === "/" || ch === "\\") out += "*";
		else if (special.has(ch)) out += `\\${ch}`;
		else out += ch;
	}
	return out;
}

/** Maximum number of inline mention suggestions shown in the dropdown. */
export const MENTION_RESULT_CAP = 10;
