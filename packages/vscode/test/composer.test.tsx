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

describe("Composer resize handle", () => {
	// Drive the top drag handle with real pointer events. jsdom has no layout, so
	// the input's `offsetHeight` is 0 and `window.innerHeight` is its 768 default;
	// the assertions therefore key off the drag delta, exercising the wiring
	// (handle → `clampComposerHeight` → inline `style.height`) rather than layout.
	function handleOf(host: HTMLElement): HTMLElement {
		return host.querySelector(".dreb-resize-handle") as HTMLElement;
	}
	function pointerDown(el: HTMLElement, clientY: number): void {
		el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientY }));
	}
	function pointerMove(clientY: number): void {
		window.dispatchEvent(new MouseEvent("pointermove", { clientY }));
	}
	function pointerUp(): void {
		window.dispatchEvent(new MouseEvent("pointerup", {}));
	}

	it("renders a discoverable, accessible top drag handle", () => {
		const { host } = mount();
		const handle = handleOf(host);
		expect(handle).toBeTruthy();
		// An <hr> carries the implicit ARIA "separator" role (satisfies a11y lint).
		expect(handle.tagName).toBe("HR");
		expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
		expect(handle.tabIndex).toBe(0);
	});

	it("grows the input when the handle is dragged up", () => {
		const { host, textarea } = mount();
		expect(textarea.style.height).toBe("");
		pointerDown(handleOf(host), 500);
		pointerMove(300); // dragged up 200px
		pointerUp();
		expect(textarea.style.height).toBe("200px");
	});

	it("shrinks toward the compact minimum when dragged down past it", () => {
		const { host, textarea } = mount();
		pointerDown(handleOf(host), 500);
		pointerMove(900); // dragged down 400px → below the 44px floor
		pointerUp();
		expect(textarea.style.height).toBe("44px");
	});

	it("clamps growth to ~80% of the window height", () => {
		const { host, textarea } = mount();
		// window.innerHeight defaults to 768 in jsdom → ceiling round(768 * 0.8) = 614.
		pointerDown(handleOf(host), 500);
		pointerMove(-600); // an extreme upward drag
		pointerUp();
		expect(textarea.style.height).toBe("614px");
	});

	it("does not resize after the drag ends (listeners are torn down)", () => {
		const { host, textarea } = mount();
		pointerDown(handleOf(host), 500);
		pointerMove(300);
		pointerUp();
		expect(textarea.style.height).toBe("200px");
		pointerMove(100); // stray move after release must be ignored
		expect(textarea.style.height).toBe("200px");
	});

	it("resets to the natural height on double-click", () => {
		const { host, textarea } = mount();
		pointerDown(handleOf(host), 500);
		pointerMove(300);
		pointerUp();
		expect(textarea.style.height).toBe("200px");
		handleOf(host).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
		expect(textarea.style.height).toBe("");
	});

	function keyDown(el: HTMLElement, key: string): void {
		el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
	}

	it("grows and shrinks by a step with the arrow keys", () => {
		const { host, textarea } = mount();
		// Establish a known height first (jsdom reports offsetHeight 0), then nudge.
		pointerDown(handleOf(host), 500);
		pointerMove(300); // → 200px
		pointerUp();
		keyDown(handleOf(host), "ArrowUp");
		expect(textarea.style.height).toBe("224px");
		keyDown(handleOf(host), "ArrowDown");
		expect(textarea.style.height).toBe("200px");
	});

	it("maximizes with End and resets with Home", () => {
		const { host, textarea } = mount();
		keyDown(handleOf(host), "End");
		expect(textarea.style.height).toBe("614px"); // round(768 * 0.8)
		keyDown(handleOf(host), "Home");
		expect(textarea.style.height).toBe("");
	});

	it("keeps aria-value* in sync as the input is resized (finding 6)", () => {
		const { host } = mount();
		const handle = handleOf(host);
		// Static bounds: floor is MIN_COMPOSER_HEIGHT; ceiling is round(768 * 0.8).
		expect(handle.getAttribute("aria-valuemin")).toBe("44");
		expect(handle.getAttribute("aria-valuemax")).toBe("614");
		// A drag updates the reactive binding — a static/untracked read would fail here.
		pointerDown(handle, 500);
		pointerMove(300); // → 200px
		pointerUp();
		expect(handle.getAttribute("aria-valuenow")).toBe("200");
		// End grows to the ceiling; valuenow must reach valuemax.
		keyDown(handle, "End");
		expect(handle.getAttribute("aria-valuenow")).toBe("614");
		expect(handle.getAttribute("aria-valuenow")).toBe(handle.getAttribute("aria-valuemax"));
	});

	it("starts a drag from the input's measured height, not jsdom's 0 (finding 8)", () => {
		const { host, textarea } = mount();
		// In a real browser the 2-row textarea has a natural height (~52px); jsdom
		// reports offsetHeight 0, which would silently mask the `inputEl.offsetHeight`
		// branch of `currentComposerHeight` and let a "drag always starts from 0"
		// regression pass. Stub a realistic height so the drag is measured from it.
		Object.defineProperty(textarea, "offsetHeight", { configurable: true, value: 52 });
		pointerDown(handleOf(host), 500);
		pointerMove(300); // dragged up 200px from the measured 52px
		pointerUp();
		expect(textarea.style.height).toBe("252px"); // 52 + 200, not 200
	});
});
