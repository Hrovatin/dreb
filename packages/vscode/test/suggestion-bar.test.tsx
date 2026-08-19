// @vitest-environment jsdom
/**
 * The `suggest_next` suggestion bar (issue 71) — the GUI analogue of the TUI's
 * Tab-accept ghost text. Renders the agent's end-of-turn next-step command as a
 * clickable pill (plus an optional markdown recap) and a dismiss `×`. This file
 * renders the real `SuggestionBar` in jsdom and verifies: the command + summary
 * show, clicking the pill invokes `onAccept` with the command, and the `×`
 * invokes `onDismiss`. The no-clobber fill behavior it wires into lives in
 * `composer-prefill.test.ts` (the `fill-if-empty` mode).
 */

import { render } from "solid-js/web/dist/web.js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/webview/vscode-api.js", () => ({
	onHostMessage: () => () => {},
	postToHost: () => {},
}));

import { SuggestionBar } from "../src/webview/app.js";

let dispose: (() => void) | undefined;

afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.innerHTML = "";
});

function mount(suggestion: { command: string; summary?: string }) {
	const onAccept = vi.fn();
	const onDismiss = vi.fn();
	const host = document.createElement("div");
	document.body.appendChild(host);
	dispose = render(() => <SuggestionBar suggestion={suggestion} onAccept={onAccept} onDismiss={onDismiss} />, host);
	return { host, onAccept, onDismiss };
}

describe("SuggestionBar", () => {
	it("renders the command pill and (when present) the markdown summary", () => {
		const { host } = mount({ command: "/skill:mach6-push", summary: "Did **the thing**." });
		expect(host.querySelector(".dreb-suggestion-cmd")?.textContent).toBe("/skill:mach6-push");
		const summary = host.querySelector(".dreb-suggestion-summary");
		expect(summary).not.toBeNull();
		// Markdown is rendered, not shown as literal asterisks.
		expect(summary?.querySelector("strong")?.textContent).toBe("the thing");
	});

	it("omits the summary block when there is no summary", () => {
		const { host } = mount({ command: "/skill:mach6-push" });
		expect(host.querySelector(".dreb-suggestion-summary")).toBeNull();
		expect(host.querySelector(".dreb-suggestion-cmd")?.textContent).toBe("/skill:mach6-push");
	});

	it("invokes onAccept with the command when the pill is clicked", () => {
		const { host, onAccept, onDismiss } = mount({ command: "/skill:mach6-push" });
		(host.querySelector(".dreb-suggestion-pill") as HTMLButtonElement).click();
		expect(onAccept).toHaveBeenCalledTimes(1);
		expect(onAccept).toHaveBeenCalledWith("/skill:mach6-push");
		expect(onDismiss).not.toHaveBeenCalled();
	});

	it("invokes onDismiss when the × is clicked", () => {
		const { host, onAccept, onDismiss } = mount({ command: "/skill:mach6-push" });
		(host.querySelector(".dreb-suggestion-dismiss") as HTMLButtonElement).click();
		expect(onDismiss).toHaveBeenCalledTimes(1);
		expect(onAccept).not.toHaveBeenCalled();
	});
});
