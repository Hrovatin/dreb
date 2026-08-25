// @vitest-environment jsdom
/**
 * End-to-end click wiring for clickable code links (Phase 5b, finding 2).
 *
 * `code-links.ts` writes the `data-path/line/column/symbol` attributes; the
 * chat's `ResponseView` wires `onClick={onCodeLinkClick}` on the rendered
 * answer, and `onCodeLinkClick` reads exactly those keys and posts `open-source`
 * to the host. Unit tests cover each side in isolation; this test renders the
 * real `ResponseView` in jsdom, dispatches a real click on a *produced* link,
 * and asserts the whole producer→delegation→postToHost contract holds together
 * (a dataset-key rename, a dropped `preventDefault`, or broken `closest()`
 * delegation would fail here while the isolated tests stayed green).
 */

import { render } from "solid-js/web/dist/web.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResponseGroup, ResponseSegment, ToolActivity } from "../src/shared/projection.js";

const hoisted = vi.hoisted(() => ({ posted: [] as unknown[] }));

vi.mock("../src/webview/vscode-api.js", () => ({
	onHostMessage: () => () => {},
	postToHost: (msg: unknown) => {
		hoisted.posted.push(msg);
	},
}));

import { ResponseView } from "../src/webview/app.js";

function group(partial: Partial<ResponseGroup>): ResponseGroup {
	const activity = partial.activity ?? [];
	const answer = partial.answer ?? "";
	// Derive the ordered segments the renderer consumes from the aggregate
	// activity/answer fields, so existing test cases keep their simple shape.
	const segments: ResponseSegment[] = partial.segments ?? [
		...(activity.length > 0 ? [{ kind: "activity" as const, items: activity, collapsed: true }] : []),
		...(answer.length > 0 ? [{ kind: "answer" as const, text: answer }] : []),
	];
	return {
		kind: "response",
		id: 1,
		streaming: false,
		collapsed: true,
		...partial,
		activity,
		answer,
		segments,
	};
}

function searchTool(resultText: string): ToolActivity {
	return { kind: "tool", toolCallId: "t1", toolName: "search", args: {}, status: "done", resultText };
}

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
	hoisted.posted.length = 0;
	document.body.innerHTML = "";
});

function mount(g: ResponseGroup): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	dispose = render(() => <ResponseView group={g} />, host);
	return host;
}

describe("ResponseView code-link click wiring", () => {
	it("posts open-source with path+line when a path:line link is clicked", () => {
		const host = mount(group({ answer: "See src/a.ts:42 for details." }));
		const link = host.querySelector("a.dreb-code-link") as HTMLAnchorElement;
		expect(link).toBeTruthy();

		link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

		expect(hoisted.posted).toEqual([{ type: "open-source", ref: { path: "src/a.ts", line: 42 } }]);
	});

	it("posts symbol + grounded location when a grounded symbol link is clicked", () => {
		const g = group({
			answer: "The Widget class handles it.",
			activity: [searchTool("1. src/widget.ts:L7-20 (class Widget)")],
		});
		const host = mount(g);
		// The answer's grounded-symbol link (not any link the activity box may render).
		const answer = host.querySelector(".dreb-answer") as HTMLElement;
		const link = answer.querySelector("a.dreb-code-link") as HTMLAnchorElement;
		expect(link?.dataset.symbol).toBe("Widget");

		link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

		expect(hoisted.posted).toEqual([
			{ type: "open-source", ref: { symbol: "Widget", path: "src/widget.ts", line: 7 } },
		]);
	});

	it("calls preventDefault so the href='#' anchor does not scroll-jump", () => {
		const host = mount(group({ answer: "open src/a.ts:1 now" }));
		const link = host.querySelector("a.dreb-code-link") as HTMLAnchorElement;
		const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
		link.dispatchEvent(evt);
		expect(evt.defaultPrevented).toBe(true);
	});

	it("posts nothing when plain (non-link) answer text is clicked", () => {
		const host = mount(group({ answer: "just some prose with no references" }));
		const answer = host.querySelector(".dreb-answer") as HTMLElement;
		expect(answer.querySelector("a.dreb-code-link")).toBeNull();

		answer.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

		expect(hoisted.posted).toEqual([]);
	});

	it("renders interleaved activity boxes and answer blocks in segment order", () => {
		const host = mount(
			group({
				segments: [
					{ kind: "activity", items: [{ kind: "thinking", text: "plan" }], collapsed: true },
					{ kind: "answer", text: "First result." },
					{ kind: "activity", items: [searchTool("1. src/x.ts:L1 (fn go)")], collapsed: true },
					{ kind: "answer", text: "Second result." },
				],
			}),
		);
		// Two distinct activity boxes render (not one merged box hoisted to the top).
		expect(host.querySelectorAll(".dreb-activity")).toHaveLength(2);
		// The two answer blocks render in order, between/after the boxes.
		const answers = [...host.querySelectorAll(".dreb-answer")].map((el) => el.textContent?.trim());
		expect(answers).toEqual(["First result.", "Second result."]);
		// Document order is box → answer → box → answer.
		const kinds = [...host.querySelectorAll(".dreb-activity, .dreb-answer")].map((el) =>
			el.classList.contains("dreb-activity") ? "box" : "answer",
		);
		expect(kinds).toEqual(["box", "answer", "box", "answer"]);
	});
});
