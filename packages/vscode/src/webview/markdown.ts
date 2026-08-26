import DOMPurify from "dompurify";
import katex from "katex";
import { Marked } from "marked";
import markedKatex from "marked-katex-extension";

/**
 * Render assistant Markdown to sanitized HTML for the answer pane, with LaTeX
 * math typeset by KaTeX. Model output is untrusted, so every rendered string
 * still passes through DOMPurify before it reaches the DOM.
 *
 * Math delimiters:
 *   - `$$…$$` / `$…$`   — marked-katex-extension, in **standard** mode
 *     (`nonStandard:false`), so ordinary `$` in prose/currency (e.g. "$5 and
 *     $10") is NOT parsed as math.
 *   - `\[…\]` / `\(…\)` — the supplementary tokenizers below (LLMs commonly emit
 *     these). They run at marked's inline level *before* the escape/codespan
 *     tokenizers, so the delimiters are captured intact and math inside
 *     `code` spans / fenced blocks stays literal.
 *
 * KaTeX runs with `throwOnError:false` (bad/unsupported LaTeX renders in an
 * error color showing its source rather than throwing and blanking the whole
 * message), `strict:"ignore"` (tolerate stray Unicode in model output), and
 * `trust:false` (no `\href`→`javascript:` or raw-HTML injection).
 */

const KATEX_OPTIONS = { throwOnError: false, strict: "ignore" as const, trust: false };

/** Render one `\(…\)` / `\[…\]` chunk to KaTeX HTML. */
function renderTex(tex: string, displayMode: boolean): string {
	return katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode });
}

/**
 * Supplementary marked extension for LaTeX-style `\(…\)` (inline) and `\[…\]`
 * (display) delimiters, which marked-katex-extension does not cover. Both are
 * registered at the inline level so they win over the core escape/codespan
 * tokenizers and can span newlines within a paragraph.
 */
const bracketMath = {
	extensions: [
		{
			name: "inlineBracketMath",
			level: "inline" as const,
			start(src: string) {
				const i = src.indexOf("\\(");
				return i < 0 ? undefined : i;
			},
			tokenizer(src: string) {
				const m = /^\\\(([\s\S]+?)\\\)/.exec(src);
				if (!m) return undefined;
				return { type: "inlineBracketMath", raw: m[0], text: m[1] };
			},
			renderer(token: { text: string }) {
				return renderTex(token.text, false);
			},
		},
		{
			name: "displayBracketMath",
			level: "inline" as const,
			start(src: string) {
				const i = src.indexOf("\\[");
				return i < 0 ? undefined : i;
			},
			tokenizer(src: string) {
				const m = /^\\\[([\s\S]+?)\\\]/.exec(src);
				if (!m) return undefined;
				return { type: "displayBracketMath", raw: m[0], text: m[1].trim() };
			},
			renderer(token: { text: string }) {
				return renderTex(token.text, true);
			},
		},
	],
};

// A dedicated instance (not the global `marked`) so configuration is applied
// exactly once and never mutates global state shared with other importers.
const marked = new Marked(
	{ async: false, gfm: true, breaks: true },
	markedKatex({ ...KATEX_OPTIONS, nonStandard: false }),
	bracketMath,
);

// KaTeX emits nested <span> (with inline `style` for layout) plus MathML
// (<math><semantics>…<annotation encoding="application/x-tex">). Preserve those
// tags/attributes so sanitization doesn't gut the equation — in particular,
// unwrapping <annotation> would leak the raw LaTeX source as visible text.
// KaTeX with `trust:false` never emits event handlers or `javascript:` URLs, so
// widening the allow-list here stays XSS-safe.
const SANITIZE_OPTIONS = {
	ADD_TAGS: [
		"math",
		"semantics",
		"annotation",
		"mrow",
		"mi",
		"mo",
		"mn",
		"ms",
		"mtext",
		"mspace",
		"msup",
		"msub",
		"msubsup",
		"mfrac",
		"msqrt",
		"mroot",
		"munder",
		"mover",
		"munderover",
		"mtable",
		"mtr",
		"mtd",
		"mpadded",
		"mphantom",
		"mstyle",
		"menclose",
		"merror",
	],
	ADD_ATTR: ["encoding", "display", "displaystyle", "scriptlevel", "mathvariant", "aria-hidden", "style"],
};

export function renderMarkdown(text: string): string {
	const html = marked.parse(text) as string;
	return DOMPurify.sanitize(html, SANITIZE_OPTIONS);
}
