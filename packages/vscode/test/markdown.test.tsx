// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildGroundedRefs, linkifyAnswer } from "../src/webview/code-links.js";
import { renderMarkdown } from "../src/webview/markdown.js";

/** Parse rendered HTML into a detached element for structural assertions. */
function dom(html: string): HTMLElement {
	const el = document.createElement("div");
	el.innerHTML = html;
	return el;
}

describe("renderMarkdown — LaTeX math", () => {
	it("renders display math ($$…$$) as typeset KaTeX, not literal text", () => {
		const html = renderMarkdown("$$A + B \\rightleftharpoons AB$$");
		const el = dom(html);
		expect(el.querySelector(".katex")).not.toBeNull();
		// `$$…$$` must render as *display* math (centered block), not inline.
		expect(el.querySelector(".katex-display")).not.toBeNull();
		// The literal delimiters must be gone.
		expect(el.textContent).not.toContain("$$");
	});

	it("renders inline math ($…$) as typeset KaTeX", () => {
		const el = dom(renderMarkdown("The constant $K_D$ matters."));
		expect(el.querySelector(".katex")).not.toBeNull();
		// Inline, not display.
		expect(el.querySelector(".katex-display")).toBeNull();
		expect(el.textContent).toContain("The constant");
	});

	it("renders \\(…\\) inline math", () => {
		const el = dom(renderMarkdown("Euler: \\(e^{i\\pi} + 1 = 0\\)."));
		expect(el.querySelector(".katex")).not.toBeNull();
		expect(el.querySelector(".katex-display")).toBeNull();
	});

	it("renders \\[…\\] display math", () => {
		const el = dom(renderMarkdown("\\[ x = \\frac{-b}{2a} \\]"));
		expect(el.querySelector(".katex-display")).not.toBeNull();
	});

	it("renders the reported K_D equation with \\frac and subscripts", () => {
		const el = dom(renderMarkdown("$$K_D = \\frac{[A][B]}{[AB]} = \\frac{k_d}{k_a}$$"));
		expect(el.querySelector(".katex")).not.toBeNull();
		// \frac produces a fraction structure in the MathML output.
		expect(el.querySelector("mfrac")).not.toBeNull();
		// The *visible* HTML render (not the x-tex annotation, which intentionally
		// keeps the source) must not show a literal `\frac` command.
		expect(el.querySelector(".katex-html")?.textContent ?? "").not.toContain("\\frac");
	});

	it("does NOT treat currency / ordinary $ text as math", () => {
		const el = dom(renderMarkdown("It costs $5 and $10 total."));
		expect(el.querySelector(".katex")).toBeNull();
		expect(el.textContent).toContain("$5");
		expect(el.textContent).toContain("$10");
	});

	it("degrades malformed LaTeX to visible source without throwing", () => {
		let html = "";
		expect(() => {
			html = renderMarkdown("$\\frac{unbalanced$");
		}).not.toThrow();
		expect(html.length).toBeGreaterThan(0);
		// throwOnError:false surfaces the source in a katex-error span rather than
		// producing a blank message.
		const el = dom(html);
		// The *visible* render must show the source (in a katex-error span), not
		// merely the inert x-tex <annotation> that always preserves the raw TeX.
		const visible = el.querySelector(".katex-error") ?? el.querySelector(".katex-html");
		expect(visible).not.toBeNull();
		expect(visible?.textContent ?? "").toContain("frac");
	});

	it("preserves KaTeX/MathML through sanitization", () => {
		const el = dom(renderMarkdown("$x^2$"));
		expect(el.querySelector(".katex")).not.toBeNull();
		// MathML semantics + the x-tex annotation must survive (not be unwrapped,
		// which would leak raw LaTeX as visible text).
		expect(el.querySelector("annotation")).not.toBeNull();
		// KaTeX relies on inline styles for layout — they must not be stripped.
		expect(el.innerHTML).toContain("style=");
	});

	it("does not allow XSS through the widened allow-list", () => {
		const el = dom(renderMarkdown('Hi <img src=x onerror="alert(1)"> $x$'));
		expect(el.innerHTML).not.toContain("onerror");
		expect(el.querySelector(".katex")).not.toBeNull();
	});

	it("blocks KaTeX \\href javascript: URLs (trust:false)", () => {
		const el = dom(renderMarkdown("$\\href{javascript:alert(1)}{x}$"));
		// trust:false makes KaTeX refuse \href — it renders as an error, never an
		// actual link. The raw source survives only inside the inert x-tex
		// <annotation>; what matters is that no clickable/navigable URL is emitted.
		expect(el.querySelector("a")).toBeNull();
		expect(el.innerHTML.toLowerCase()).not.toContain('href="javascript:');
		expect(el.innerHTML.toLowerCase()).not.toContain("href='javascript:");
	});

	it("keeps math inside inline code spans literal", () => {
		const el = dom(renderMarkdown("Use `$x^2$` verbatim."));
		expect(el.querySelector(".katex")).toBeNull();
		expect(el.querySelector("code")?.textContent).toContain("$x^2$");
	});

	it("keeps math inside fenced code blocks literal", () => {
		const el = dom(renderMarkdown("```\n$x^2$\n\\(y\\)\n```"));
		expect(el.querySelector(".katex")).toBeNull();
		expect(el.querySelector("pre code")?.textContent).toContain("$x^2$");
	});

	it("leaves an unclosed delimiter (mid-stream) as literal text", () => {
		let html = "";
		expect(() => {
			html = renderMarkdown("Half-streamed $$A + B \\rightlefth");
		}).not.toThrow();
		const el = dom(html);
		expect(el.querySelector(".katex")).toBeNull();
		expect(el.textContent).toContain("$$A + B");
	});
});

describe("linkifyAnswer × rendered math", () => {
	it("does not linkify tokens inside a rendered equation", () => {
		// A grounded symbol that also appears as a variable in the math.
		const refs = buildGroundedRefs([
			{ kind: "tool", name: "grep", args: { path: "src/x.ts" }, resultText: "src/x.ts:1: x" } as never,
		]);
		const rendered = renderMarkdown("See $x = 1$ and src/x.ts:1 below.");
		const linked = linkifyAnswer(rendered, refs);
		const el = dom(linked);
		// The equation subtree must be untouched (no injected anchors inside it).
		const katex = el.querySelector(".katex");
		expect(katex).not.toBeNull();
		expect(katex?.querySelector("a")).toBeNull();
		expect(katex?.querySelector(".dreb-code-link")).toBeNull();
		// The real path reference outside the math still linkifies.
		expect(el.querySelector(".dreb-code-link")).not.toBeNull();
	});
});
