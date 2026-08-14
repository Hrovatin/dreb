// @vitest-environment jsdom
/**
 * Sidebar reconcile behavior — the actual F2 fix.
 *
 * `session-list.test.ts` locks the pure `buildSessionList` key contract; this
 * file renders the real `SidebarApp` in jsdom and asserts the *behavior* that
 * contract enables: because the app reconciles the incoming list by stable
 * `key` (both groups and rows carry one) into a `createStore`, a background
 * refresh reuses each row/group's component + DOM node instead of remounting
 * them. That preservation is what keeps an in-progress inline rename and an
 * expanded group from being wiped every ~150ms streaming refresh.
 *
 * The webview messaging seam (`vscode-api.js`) is mocked so the test can drive
 * `onHostMessage` directly and capture `postToHost`.
 */

import { render } from "solid-js/web/dist/web.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionGroupDto, SessionListDto, SessionSummaryDto } from "../src/shared/session-list.js";
import type { HostToSidebar } from "../src/shared/sidebar-protocol.js";

const hoisted = vi.hoisted(() => ({
	handler: undefined as ((msg: HostToSidebar) => void) | undefined,
	posted: [] as unknown[],
}));

vi.mock("../src/webview/sidebar/vscode-api.js", () => ({
	onHostMessage: (h: (msg: HostToSidebar) => void) => {
		hoisted.handler = h;
		return () => {
			hoisted.handler = undefined;
		};
	},
	postToHost: (msg: unknown) => {
		hoisted.posted.push(msg);
	},
}));

import { SidebarApp } from "../src/webview/sidebar/app.js";

function row(key: string, title: string, state: SessionSummaryDto["state"] = "idle"): SessionSummaryDto {
	return {
		key,
		path: key,
		cwd: "/proj",
		title,
		modified: "2026-01-01T00:00:00.000Z",
		messageCount: 3,
		state,
		live: false,
		pinned: false,
		archived: false,
	};
}

function group(
	kind: SessionGroupDto["kind"],
	cwd: string,
	label: string,
	sessions: SessionSummaryDto[],
): SessionGroupDto {
	return { key: `${kind}:${cwd}`, kind, cwd, label, sessions };
}

let disposeRoot: (() => void) | undefined;
let container: HTMLElement;

function mountSidebar(): void {
	container = document.createElement("div");
	document.body.appendChild(container);
	disposeRoot = render(() => <SidebarApp />, container);
	// onMount registers the host-message handler; it must be live after mount.
	expect(hoisted.handler).toBeDefined();
}

function emit(list: SessionListDto): void {
	hoisted.handler?.({ type: "list", list });
}

afterEach(() => {
	disposeRoot?.();
	disposeRoot = undefined;
	container?.remove();
	hoisted.handler = undefined;
	hoisted.posted.length = 0;
});

describe("SidebarApp reconcile identity preservation (F2)", () => {
	it("preserves an in-progress inline rename across a streaming refresh", () => {
		mountSidebar();
		emit({
			currentCwd: "/proj",
			groups: [
				group("current", "/proj", "This workspace", [row("/proj/a.jsonl", "Alpha"), row("/proj/b.jsonl", "Beta")]),
			],
		});

		const rowsBefore = container.querySelectorAll(".dreb-side-row");
		expect(rowsBefore.length).toBe(2);
		const firstRowBefore = rowsBefore[0];

		// User starts renaming the first row.
		const renameBtn = firstRowBefore.querySelector<HTMLButtonElement>('[aria-label="Rename session"]');
		expect(renameBtn).not.toBeNull();
		renameBtn?.click();

		const input = container.querySelector<HTMLInputElement>(".dreb-side-rename-input");
		expect(input).not.toBeNull();
		// User types a draft that hasn't been committed yet.
		input!.value = "Renaming in progress";
		input!.dispatchEvent(new Event("input", { bubbles: true }));

		// A background refresh arrives: same keys, but the first session is now
		// live+running with a server-updated title.
		emit({
			currentCwd: "/proj",
			groups: [
				group("current", "/proj", "This workspace", [
					{ ...row("/proj/a.jsonl", "Alpha (host renamed)", "running"), live: true },
					row("/proj/b.jsonl", "Beta"),
				]),
			],
		});

		// The very same input element is still mounted with the uncommitted draft —
		// proving the row component was reconciled, not remounted (which would have
		// reset `editing` to false and discarded the draft).
		expect(container.contains(input)).toBe(true);
		expect(input!.value).toBe("Renaming in progress");
		// DOM node identity of the row is preserved.
		expect(container.querySelectorAll(".dreb-side-row")[0]).toBe(firstRowBefore);
		// No rename was posted (still in progress, not committed).
		expect(hoisted.posted.filter((m) => (m as { type?: string }).type === "rename")).toEqual([]);
	});

	it("preserves a user-expanded group across a streaming refresh", () => {
		mountSidebar();
		emit({
			currentCwd: "/proj",
			groups: [
				group("current", "/proj", "This workspace", [row("/proj/a.jsonl", "Alpha")]),
				group("project", "/other", "other", [row("/other/x.jsonl", "Xavier")]),
			],
		});

		const detailsBefore = container.querySelectorAll<HTMLDetailsElement>(".dreb-side-group");
		expect(detailsBefore.length).toBe(2);
		const projectDetails = detailsBefore[1];
		// The project group is collapsed by default (only the current group opens).
		expect(projectDetails.open).toBe(false);
		// User expands it.
		projectDetails.open = true;

		// A background refresh with the same group keys arrives.
		emit({
			currentCwd: "/proj",
			groups: [
				group("current", "/proj", "This workspace", [{ ...row("/proj/a.jsonl", "Alpha", "running"), live: true }]),
				group("project", "/other", "other", [row("/other/x.jsonl", "Xavier")]),
			],
		});

		// Same <details> node, still expanded — the group was reconciled, not
		// remounted (a remount would reset `open` back to false for a project group).
		const detailsAfter = container.querySelectorAll<HTMLDetailsElement>(".dreb-side-group");
		expect(detailsAfter[1]).toBe(projectDetails);
		expect(detailsAfter[1].open).toBe(true);
	});
});
