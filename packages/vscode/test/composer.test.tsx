// @vitest-environment jsdom
/**
 * Composer inline `@`-mention orchestration (Phase 4c).
 *
 * The pure helpers (`activeMention`, `isFullPickerTrigger`, `replaceMention`,
 * `rankMentionResults`) are unit-tested in `mention.test.ts`; this file renders
 * the real `Composer` in jsdom and drives the textarea to verify the *glue* the
 * helpers hang off: `@@` escalates to the native picker (and never searches),
 * `@`-typing schedules a debounced workspace search, selecting a dropdown result
 * strips the `@query` token and tags the chosen folder/file/symbol, and Escape
 * dismisses the dropdown. A dataset-key rename, a dropped debounce, or a wrong
 * token span would fail here while the isolated helper tests stayed green.
 */

import { render } from "solid-js/web/dist/web.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileContextDto, SymbolContextDto, TaggedContextDto } from "../src/shared/protocol.js";

vi.mock("../src/webview/vscode-api.js", () => ({
	onHostMessage: () => () => {},
	postToHost: () => {},
}));

import { Composer } from "../src/webview/app.js";

const folder = (path: string): FileContextDto => ({ kind: "file", path, isDirectory: true });
const file = (path: string): FileContextDto => ({ kind: "file", path });
const symbol = (name: string, path: string, line = 1, symbolKind = "function"): SymbolContextDto => ({
	kind: "symbol",
	name,
	symbolKind,
	path,
	line,
});

interface Spies {
	onPickFile: ReturnType<typeof vi.fn>;
	onSearchWorkspace: ReturnType<typeof vi.fn>;
	onTagContext: ReturnType<typeof vi.fn>;
	onSubmit: ReturnType<typeof vi.fn>;
}

let dispose: (() => void) | undefined;

afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.innerHTML = "";
	vi.useRealTimers();
});

function mount(mentionResults: TaggedContextDto[] = []): {
	host: HTMLElement;
	textarea: HTMLTextAreaElement;
	spies: Spies;
} {
	const spies: Spies = {
		onPickFile: vi.fn(),
		onSearchWorkspace: vi.fn(),
		onTagContext: vi.fn(),
		onSubmit: vi.fn(),
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	dispose = render(
		() => (
			<Composer
				streaming={false}
				commands={[]}
				attachments={[]}
				mentionResults={mentionResults}
				onRemoveAttachment={() => {}}
				onSubmit={spies.onSubmit}
				onAbort={() => {}}
				onPickFile={spies.onPickFile}
				onSearchWorkspace={spies.onSearchWorkspace}
				onTagContext={spies.onTagContext}
			/>
		),
		host,
	);
	const textarea = host.querySelector("textarea.dreb-input") as HTMLTextAreaElement;
	return { host, textarea, spies };
}

/** Simulate typing by setting the textarea value + caret and dispatching a
 * bubbling `input` event (Solid delegates `input`, so this drives `onInput`). */
function type(textarea: HTMLTextAreaElement, value: string, caret = value.length): void {
	textarea.value = value;
	textarea.selectionStart = caret;
	textarea.selectionEnd = caret;
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Composer @@ escalation", () => {
	it("opens the native picker, strips the `@@`, and does not search", () => {
		const { textarea, spies } = mount();
		// Type the two `@` incrementally, as a real user would.
		type(textarea, "@", 1);
		type(textarea, "@@", 2);

		expect(spies.onPickFile).toHaveBeenCalledTimes(1);
		expect(spies.onSearchWorkspace).not.toHaveBeenCalled();
		// The two `@` are stripped so the picker doesn't leave stray text behind.
		expect(textarea.value).toBe("");
	});

	it("escalates `@@` after leading text and preserves that text", () => {
		const { textarea, spies } = mount();
		type(textarea, "see @@", 6);

		expect(spies.onPickFile).toHaveBeenCalledTimes(1);
		expect(textarea.value).toBe("see ");
	});
});

describe("Composer @ typeahead", () => {
	beforeEach(() => vi.useFakeTimers());

	it("schedules a single debounced workspace search for the typed query", () => {
		const { textarea, spies } = mount();
		type(textarea, "@app", 4);

		// Nothing fires until the debounce elapses.
		expect(spies.onSearchWorkspace).not.toHaveBeenCalled();
		vi.advanceTimersByTime(120);
		expect(spies.onSearchWorkspace).toHaveBeenCalledTimes(1);
		expect(spies.onSearchWorkspace).toHaveBeenCalledWith("app");
	});

	it("debounces rapid keystrokes into one trailing search", () => {
		const { textarea, spies } = mount();
		type(textarea, "@a", 2);
		vi.advanceTimersByTime(50);
		type(textarea, "@ap", 3);
		vi.advanceTimersByTime(50);
		type(textarea, "@app", 4);
		vi.advanceTimersByTime(120);

		expect(spies.onSearchWorkspace).toHaveBeenCalledTimes(1);
		expect(spies.onSearchWorkspace).toHaveBeenCalledWith("app");
	});

	it("does not search plain prose without an active `@` token", () => {
		const { textarea, spies } = mount();
		type(textarea, "hello world", 11);
		vi.advanceTimersByTime(120);
		expect(spies.onSearchWorkspace).not.toHaveBeenCalled();
	});
});

describe("Composer mention dropdown", () => {
	it("renders folders, files, and symbols with @-prefixed labels and descriptions", () => {
		const results: TaggedContextDto[] = [folder("src/app"), file("src/app.ts"), symbol("run", "src/app.ts", 8)];
		const { host, textarea } = mount(results);
		type(textarea, "@app", 4);

		const items = [...host.querySelectorAll(".dreb-menu-item")];
		const names = items.map((el) => el.querySelector(".dreb-menu-name")?.textContent);
		const descs = items.map((el) => el.querySelector(".dreb-menu-desc")?.textContent);
		expect(names).toEqual(["@app/", "@app.ts", "@run"]);
		expect(descs).toEqual(["src/app/", "src/app.ts", "function · src/app.ts:8"]);
	});

	it("stays closed when there are no results even with an active `@` token", () => {
		const { host, textarea } = mount([]);
		type(textarea, "@app", 4);
		expect(host.querySelector(".dreb-menu-item")).toBeNull();
	});

	it("tags the chosen result, strips the `@query` token, and closes the dropdown", () => {
		const results: TaggedContextDto[] = [file("src/app.ts")];
		const { host, textarea, spies } = mount(results);
		type(textarea, "see @app", 8);

		const item = host.querySelector(".dreb-menu-item") as HTMLButtonElement;
		expect(item).toBeTruthy();
		item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

		expect(spies.onTagContext).toHaveBeenCalledTimes(1);
		expect(spies.onTagContext).toHaveBeenCalledWith({ kind: "file", path: "src/app.ts" });
		// The `@app` token is stripped, leaving the surrounding prose.
		expect(textarea.value).toBe("see ");
		// With no active token the dropdown closes.
		expect(host.querySelector(".dreb-menu-item")).toBeNull();
	});

	it("dismisses the dropdown on Escape without submitting or losing text", () => {
		const results: TaggedContextDto[] = [file("src/app.ts")];
		const { host, textarea, spies } = mount(results);
		type(textarea, "@app", 4);
		expect(host.querySelector(".dreb-menu-item")).toBeTruthy();

		textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

		expect(host.querySelector(".dreb-menu-item")).toBeNull();
		expect(spies.onSubmit).not.toHaveBeenCalled();
		expect(textarea.value).toBe("@app");
	});
});
