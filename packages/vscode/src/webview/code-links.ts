/**
 * Clickable code links (Phase 5b) — turn file/symbol references in an assistant
 * answer into links that open the code in the editor.
 *
 * Reliability lives in the *client*, not the model: we never trust the LLM to
 * emit valid links. Instead we (1) linkify only references that are either
 * syntactically unambiguous (a `path:line`, or a path with a directory + file
 * extension) or (2) *grounded* — i.e. the exact path/symbol appeared in this
 * response's own tool results (read/grep/search/find). A grounded symbol also
 * carries the location from its tool hit, so clicking can jump straight there
 * even before any language-server resolution. References that match nothing real
 * simply stay plain text — the failure mode is "no link", never a broken link.
 *
 * `buildGroundedRefs` is pure string parsing (node-testable); `linkifyAnswer`
 * needs a DOM (`document`) to walk text nodes safely without corrupting the
 * markdown-rendered `<a>`/`<code>` structure — covered by a jsdom test.
 */

import type { ActivityItem } from "../shared/projection.js";

/** A best-known source location for a grounded reference. */
export interface GroundedLocation {
	/** Path exactly as it appeared in the tool result (tool-cwd-relative). */
	path: string;
	/** 1-based line, when the tool hit carried one. */
	line?: number;
}

/** The set of real paths and symbol→location pairs observed in a response's own
 * tool activity, used to gate + locate linkification of that response's answer. */
export interface GroundedRefs {
	/** Normalized (forward-slash) paths seen in tool results. */
	paths: Set<string>;
	/** Symbol name → best-known location, from search/grep hits. */
	symbols: Map<string, GroundedLocation>;
}

/** A `path:line:` match line from the grep tool (`formatBlock`). */
const GREP_HIT = /^(.+?):(\d+):/;
/** A `N. filePath:Lstart[-Lend] (kind name)` line from semantic search
 * (`formatResults`). */
const SEARCH_HIT = /^\s*\d+\.\s+(.+?):L(\d+)(?:-\d+)?\s+\((?:\w+)(?:\s+([^)]+))?\)\s*$/;
/** A bare identifier (safe to treat as a symbol / grep pattern). */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function normalizePath(path: string): string {
	return path.trim().replace(/\\/g, "/");
}

/** Pull a non-empty string field (e.g. `path`/`pattern`) out of a tool's `args`,
 * tolerating the `unknown` type. */
function argsField(args: unknown, field: string): string | undefined {
	if (args && typeof args === "object" && field in args) {
		const v = (args as Record<string, unknown>)[field];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

/**
 * Derive the grounded reference set for one response from its tool activity.
 * Parses the known tool output formats (grep `path:line:`, search
 * `filePath:Lstart (kind name)`, find bare paths) plus tool-call `args.path`.
 */
export function buildGroundedRefs(activity: readonly ActivityItem[]): GroundedRefs {
	const paths = new Set<string>();
	const symbols = new Map<string, GroundedLocation>();

	for (const item of activity) {
		if (item.kind !== "tool") continue;
		const callPath = argsField(item.args, "path");
		if (callPath) paths.add(normalizePath(callPath));

		const lines = item.resultText ? item.resultText.split("\n") : [];
		let firstGrepHit: GroundedLocation | undefined;
		for (const raw of lines) {
			const line = raw.trimEnd();
			if (line.length === 0) continue;

			const search = SEARCH_HIT.exec(line);
			if (search) {
				const path = normalizePath(search[1]);
				const startLine = Number(search[2]) || undefined;
				paths.add(path);
				const name = search[3]?.trim().split(/\s+/).pop();
				if (name && IDENTIFIER.test(name) && !symbols.has(name)) {
					symbols.set(name, { path, line: startLine });
				}
				continue;
			}

			const grep = GREP_HIT.exec(line);
			if (grep) {
				const path = normalizePath(grep[1]);
				paths.add(path);
				if (!firstGrepHit) firstGrepHit = { path, line: Number(grep[2]) };
				continue;
			}

			// find output: a bare path (has a slash or a file extension, no spaces).
			if (item.toolName === "find" && /^[^\s:]+$/.test(line) && (line.includes("/") || /\.[A-Za-z]/.test(line))) {
				paths.add(normalizePath(line));
			}
		}

		// A grep whose pattern is a bare identifier grounds that symbol at its
		// first hit (a usage site — the host still prefers the LSP definition).
		const pattern = argsField(item.args, "pattern");
		if (item.toolName === "grep" && pattern && IDENTIFIER.test(pattern) && firstGrepHit && !symbols.has(pattern)) {
			symbols.set(pattern, firstGrepHit);
		}
	}

	return { paths, symbols };
}

/** A file reference: a path with a file extension, optional `:line[:col]`. */
const FILE_REF = /(?<![\w./-])((?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][\w-]*)(?::(\d+))?(?::(\d+))?/g;

interface Hit {
	start: number;
	end: number;
	el: HTMLAnchorElement;
}

function makeLink(): HTMLAnchorElement {
	const a = document.createElement("a");
	a.className = "dreb-code-link";
	a.href = "#";
	return a;
}

/** Collect file-reference hits in `text`. A match is linkified when it carries a
 * line, contains a directory separator, or its path is grounded — a bare
 * `foo.ts` with none of these is left alone (too ambiguous). */
function fileHits(text: string, refs: GroundedRefs): Hit[] {
	const hits: Hit[] = [];
	FILE_REF.lastIndex = 0;
	let m: RegExpExecArray | null = FILE_REF.exec(text);
	while (m !== null) {
		const [raw, path, lineStr, colStr] = m;
		const normalized = normalizePath(path);
		const grounded = refs.paths.has(normalized);
		if (lineStr !== undefined || path.includes("/") || grounded) {
			const a = makeLink();
			a.textContent = raw;
			a.dataset.path = path;
			if (lineStr) a.dataset.line = lineStr;
			if (colStr) a.dataset.column = colStr;
			hits.push({ start: m.index, end: m.index + raw.length, el: a });
		}
		m = FILE_REF.exec(text);
	}
	return hits;
}

/** Collect grounded-symbol hits in `text` (whole-word, from the bounded grounded
 * set only — so ordinary prose is never over-linkified). */
function symbolHits(text: string, refs: GroundedRefs): Hit[] {
	if (refs.symbols.size === 0) return [];
	const names = [...refs.symbols.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
	const re = new RegExp(`\\b(${names.join("|")})\\b`, "g");
	const hits: Hit[] = [];
	let m: RegExpExecArray | null = re.exec(text);
	while (m !== null) {
		const name = m[1];
		const loc = refs.symbols.get(name);
		const a = makeLink();
		a.textContent = name;
		a.dataset.symbol = name;
		if (loc?.path) a.dataset.path = loc.path;
		if (loc?.line) a.dataset.line = String(loc.line);
		hits.push({ start: m.index, end: m.index + name.length, el: a });
		m = re.exec(text);
	}
	return hits;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace one text node with linkified content, preferring file matches over
 * symbol matches when they overlap. Returns the new nodes, or null if none. */
function linkifyTextNode(node: Text, refs: GroundedRefs): Node[] | null {
	const text = node.data;
	const all = [...fileHits(text, refs), ...symbolHits(text, refs)].sort((a, b) => a.start - b.start);
	if (all.length === 0) return null;

	const out: Node[] = [];
	let cursor = 0;
	for (const hit of all) {
		if (hit.start < cursor) continue; // overlaps a prior (earlier/file) hit — skip
		if (hit.start > cursor) out.push(document.createTextNode(text.slice(cursor, hit.start)));
		out.push(hit.el);
		cursor = hit.end;
	}
	if (cursor < text.length) out.push(document.createTextNode(text.slice(cursor)));
	return out;
}

function walk(parent: Node, refs: GroundedRefs): void {
	const children = Array.from(parent.childNodes);
	for (const child of children) {
		if (child.nodeType === 3 /* text */) {
			const replaced = linkifyTextNode(child as Text, refs);
			if (replaced) (child as ChildNode).replaceWith(...replaced);
		} else if (child.nodeType === 1 /* element */) {
			const el = child as Element;
			// Never nest links inside an existing anchor.
			if (el.tagName === "A") continue;
			walk(el, refs);
		}
	}
}

/**
 * Linkify file/symbol references in already-sanitized answer HTML. Operates on
 * text nodes via a DOM walk so existing markdown links/code spans are preserved
 * and all inserted text is auto-escaped by the DOM. Idempotent-safe: skips
 * inside existing anchors.
 */
export function linkifyAnswer(html: string, refs: GroundedRefs): string {
	const root = document.createElement("div");
	root.innerHTML = html;
	walk(root, refs);
	return root.innerHTML;
}
