// @vitest-environment jsdom
/**
 * Inline restore/fork controls + branch-tree view (Phase 6).
 *
 * Renders the real `CheckpointBar` and `TreePanel` in jsdom, dispatches real
 * clicks, and asserts the click→postToHost contract: the inline divider posts
 * `navigate-tree` / `fork` for the right entry (and hides "Restore Checkpoint"
 * at the latest turn), and the tree overlay posts `navigate-tree` for a picked
 * node while disabling the current leaf.
 */

import { render } from "solid-js/web/dist/web.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Checkpoint } from "../src/shared/projection.js";
import type { SessionTreeDto } from "../src/shared/protocol.js";

const hoisted = vi.hoisted(() => ({ posted: [] as unknown[] }));

vi.mock("../src/webview/vscode-api.js", () => ({
	onHostMessage: () => () => {},
	postToHost: (msg: unknown) => {
		hoisted.posted.push(msg);
	},
}));

import { CheckpointBar, TreePanel } from "../src/webview/app.js";

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
	hoisted.posted.length = 0;
	document.body.innerHTML = "";
});

function mount(node: () => unknown): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	dispose = render(node as never, host);
	return host;
}

function clickText(host: HTMLElement, text: string): void {
	const btn = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
	if (!btn) throw new Error(`no button containing "${text}"`);
	btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

describe("CheckpointBar (inline restore/fork)", () => {
	it("offers Restore + Fork on a prior turn and posts the right entry", () => {
		const cp: Checkpoint = { responseId: 1, entryId: "a1", canRestore: true };
		const host = mount(() => <CheckpointBar checkpoint={cp} />);

		expect(host.textContent).toContain("Restore Checkpoint");
		clickText(host, "Restore Checkpoint");
		clickText(host, "Fork");

		expect(hoisted.posted).toEqual([
			{ type: "navigate-tree", entryId: "a1" },
			{ type: "fork", entryId: "a1" },
		]);
	});

	it("hides Restore at the latest turn but still offers Fork", () => {
		const cp: Checkpoint = { responseId: 2, entryId: "a2", canRestore: false };
		const host = mount(() => <CheckpointBar checkpoint={cp} />);

		expect(host.textContent).not.toContain("Restore Checkpoint");
		clickText(host, "Fork");
		expect(hoisted.posted).toEqual([{ type: "fork", entryId: "a2" }]);
	});
});

describe("TreePanel (branch-tree view)", () => {
	const tree: SessionTreeDto = {
		roots: [
			{
				id: "u1",
				parentId: null,
				type: "message",
				role: "user",
				preview: "hi",
				timestamp: "t",
				children: [
					{
						id: "a1",
						parentId: "u1",
						type: "message",
						role: "assistant",
						preview: "hello",
						timestamp: "t",
						children: [],
					},
				],
			},
		],
		leafId: "a1",
	};

	it("renders message turns and navigates to a picked node", () => {
		const navigated: string[] = [];
		const host = mount(() => <TreePanel tree={tree} onNavigate={(id) => navigated.push(id)} onClose={() => {}} />);

		// Both turns render; the leaf node ("a1") is disabled.
		const nodes = [...host.querySelectorAll("button.dreb-tree-node")] as HTMLButtonElement[];
		expect(nodes).toHaveLength(2);
		const leaf = nodes.find((n) => n.textContent?.includes("hello"));
		expect(leaf?.disabled).toBe(true);
		expect(host.textContent).toContain("current");

		// Clicking the non-leaf ("hi") navigates to it.
		const parent = nodes.find((n) => n.textContent?.includes("hi"));
		parent?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(navigated).toEqual(["u1"]);
	});

	it("closes when the backdrop is clicked", () => {
		let closed = 0;
		const host = mount(() => <TreePanel tree={tree} onNavigate={() => {}} onClose={() => closed++} />);
		const overlay = host.querySelector(".dreb-tree-overlay") as HTMLElement;
		overlay.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(closed).toBe(1);
	});
});
