// @vitest-environment jsdom
/**
 * Clickable code links (Phase 5b) — grounding + linkification.
 *
 * `buildGroundedRefs` is pure parsing of the known tool-output formats;
 * `linkifyAnswer` walks the sanitized answer DOM and wraps only references that
 * are syntactically unambiguous or grounded, without corrupting existing
 * markdown. jsdom provides the `document` the DOM walk needs.
 */

import { describe, expect, it } from "vitest";
import type { ActivityItem, ToolActivity } from "../src/shared/projection.js";
import { buildGroundedRefs, linkifyAnswer } from "../src/webview/code-links.js";

function tool(partial: Partial<ToolActivity> & Pick<ToolActivity, "toolName">): ToolActivity {
	return {
		kind: "tool",
		toolCallId: "t1",
		args: {},
		status: "done",
		resultText: "",
		...partial,
	};
}

describe("buildGroundedRefs", () => {
	it("grounds paths from read args, grep hits, search hits, and find output", () => {
		const activity: ActivityItem[] = [
			tool({ toolName: "read", args: { path: "src/read-me.ts" } }),
			tool({ toolName: "grep", args: { pattern: "foo" }, resultText: "src/grep-hit.ts:42: const foo = 1" }),
			tool({ toolName: "search", resultText: "1. src/search-hit.ts:L10-20 (function widget)" }),
			tool({ toolName: "find", resultText: "src/found-a.ts\nsrc/found-b.ts" }),
		];
		const refs = buildGroundedRefs(activity);
		expect(refs.paths.has("src/read-me.ts")).toBe(true);
		expect(refs.paths.has("src/grep-hit.ts")).toBe(true);
		expect(refs.paths.has("src/search-hit.ts")).toBe(true);
		expect(refs.paths.has("src/found-a.ts")).toBe(true);
		expect(refs.paths.has("src/found-b.ts")).toBe(true);
	});

	it("grounds a symbol with its location from a search hit", () => {
		const refs = buildGroundedRefs([
			tool({ toolName: "search", resultText: "1. src/widget.ts:L10-20 (function widget)" }),
		]);
		expect(refs.symbols.get("widget")).toEqual({ path: "src/widget.ts", line: 10 });
	});

	it("grounds a grep symbol from a bare-identifier pattern at its first hit", () => {
		const refs = buildGroundedRefs([
			tool({ toolName: "grep", args: { pattern: "Widget" }, resultText: "src/widget.ts:7: class Widget {}" }),
		]);
		expect(refs.symbols.get("Widget")).toEqual({ path: "src/widget.ts", line: 7 });
	});

	it("ignores thinking activity and non-hit noise", () => {
		const refs = buildGroundedRefs([
			{ kind: "thinking", text: "considering src/secret.ts:1" },
			tool({ toolName: "bash", resultText: "no colon-line hits here" }),
		]);
		expect(refs.paths.size).toBe(0);
		expect(refs.symbols.size).toBe(0);
	});
});

describe("linkifyAnswer", () => {
	const empty = { paths: new Set<string>(), symbols: new Map() };

	function links(html: string): HTMLAnchorElement[] {
		const div = document.createElement("div");
		div.innerHTML = html;
		return [...div.querySelectorAll("a.dreb-code-link")] as HTMLAnchorElement[];
	}

	it("linkifies a path:line reference with path + line data", () => {
		const out = linkifyAnswer("<p>See src/a.ts:42 now</p>", empty);
		const [a] = links(out);
		expect(a).toBeTruthy();
		expect(a.dataset.path).toBe("src/a.ts");
		expect(a.dataset.line).toBe("42");
		expect(a.textContent).toBe("src/a.ts:42");
	});

	it("linkifies a bare path that contains a directory separator", () => {
		const out = linkifyAnswer("<p>edit src/a.ts here</p>", empty);
		const [a] = links(out);
		expect(a?.dataset.path).toBe("src/a.ts");
		expect(a?.dataset.line).toBeUndefined();
	});

	it("does NOT linkify a bare filename with no slash and no grounding", () => {
		expect(links(linkifyAnswer("<p>the file a.ts is here</p>", empty))).toHaveLength(0);
	});

	it("linkifies a bare grounded filename (no slash) because it is real", () => {
		const refs = { paths: new Set(["a.ts"]), symbols: new Map() };
		const [a] = links(linkifyAnswer("<p>the file a.ts is here</p>", refs));
		expect(a?.dataset.path).toBe("a.ts");
	});

	it("linkifies a grounded symbol with its symbol + grounded location", () => {
		const refs = { paths: new Set<string>(), symbols: new Map([["Widget", { path: "src/widget.ts", line: 7 }]]) };
		const [a] = links(linkifyAnswer("<p>the <code>Widget</code> class</p>", refs));
		expect(a?.dataset.symbol).toBe("Widget");
		expect(a?.dataset.path).toBe("src/widget.ts");
		expect(a?.dataset.line).toBe("7");
	});

	it("does NOT linkify an ungrounded word", () => {
		const refs = { paths: new Set<string>(), symbols: new Map([["Widget", { path: "src/widget.ts" }]]) };
		expect(links(linkifyAnswer("<p>a Gadget and a thing</p>", refs))).toHaveLength(0);
	});

	it("never nests a link inside an existing markdown anchor", () => {
		const out = linkifyAnswer('<p>see <a href="http://x">src/a.ts:9</a></p>', empty);
		// The only anchor is the original external link; no code-link was added inside it.
		expect(links(out)).toHaveLength(0);
		expect(out).toContain('href="http://x"');
	});

	it("preserves surrounding markup and escapes text", () => {
		const out = linkifyAnswer("<p><strong>bold</strong> src/a.ts:1 &amp; more</p>", empty);
		expect(out).toContain("<strong>bold</strong>");
		expect(out).toContain("&amp;");
		expect(links(out)).toHaveLength(1);
	});

	it("prefers the file link over an overlapping grounded symbol in the same text", () => {
		// `widget` is a grounded symbol AND a substring of the grounded file token
		// `src/widget.ts:42`. The file hit must win the overlap: one link, carrying
		// the line number, with no stray/duplicate text or nested anchor.
		const refs = {
			paths: new Set(["src/widget.ts"]),
			symbols: new Map([["widget", { path: "src/widget.ts", line: 7 }]]),
		};
		const out = linkifyAnswer("<p>See src/widget.ts:42 here</p>", refs);
		const all = links(out);
		expect(all).toHaveLength(1);
		expect(all[0].dataset.path).toBe("src/widget.ts");
		expect(all[0].dataset.line).toBe("42");
		expect(all[0].dataset.symbol).toBeUndefined();
		expect(all[0].textContent).toBe("src/widget.ts:42");
		// No text was dropped or duplicated around the single link.
		const div = document.createElement("div");
		div.innerHTML = out;
		expect(div.textContent).toBe("See src/widget.ts:42 here");
	});
});
