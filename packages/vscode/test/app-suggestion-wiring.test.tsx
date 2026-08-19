// @vitest-environment jsdom
/**
 * App-level wiring for the `suggest_next` suggestion bar (issue 71). The unit
 * tests elsewhere cover the pieces in isolation — the reducer
 * (`projection.test.ts`), the no-clobber merge (`composer-prefill.test.ts`), the
 * `SuggestionBar` component callbacks (`suggestion-bar.test.tsx`), and the
 * host-side clear + dispatch (`session-controller.test.ts` /
 * `webview-bridge.test.ts`). This file mounts the real `App()` and verifies the
 * glue between them, which no other test exercises:
 *
 *   - accepting the pill *fills* the composer (via the `fill-if-empty` prefill),
 *     rather than a mode that would clobber a draft (round-1 finding 2);
 *   - dismissing clears the bar locally *and* posts `dismiss-suggestion` to the
 *     host so a dismissed suggestion cannot reappear on reload (round-2
 *     finding 1/2);
 *   - submitting drops the suggestion immediately (round-1 finding 2).
 */

import { render } from "solid-js/web/dist/web.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranscriptState, type TranscriptState } from "../src/shared/projection.js";
import type { HostToWebview, WebviewToHost } from "../src/shared/protocol.js";

// Controllable vscode-api mock: capture the host→webview handler the App
// registers on mount so the test can push messages, and spy on postToHost.
let hostHandler: ((msg: HostToWebview) => void) | undefined;
const postSpy = vi.fn<(m: WebviewToHost) => void>();

vi.mock("../src/webview/vscode-api.js", () => ({
	onHostMessage: (h: (msg: HostToWebview) => void) => {
		hostHandler = h;
		return () => {
			hostHandler = undefined;
		};
	},
	postToHost: (m: WebviewToHost) => postSpy(m),
}));

import { App } from "../src/webview/app.js";

// jsdom lacks ResizeObserver, which the sticky-scroll controller reads off the
// global; provide a no-op so App's onMount doesn't touch an undefined global.
class NoopResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let dispose: (() => void) | undefined;

beforeEach(() => {
	(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
	postSpy.mockClear();
	hostHandler = undefined;
});

afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.innerHTML = "";
});

/** Mount the real App and push a snapshot carrying the given suggestion. */
function mountWithSuggestion(suggestion?: { command: string; summary?: string }) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	dispose = render(() => <App />, host);
	// onMount has registered the host-message handler by now.
	const state: TranscriptState = { ...createTranscriptState(), suggestion };
	hostHandler?.({
		type: "snapshot",
		state,
		commands: [],
		status: { connected: true, cwd: "/proj" },
	});
	return host;
}

const pill = (host: HTMLElement) => host.querySelector(".dreb-suggestion-pill") as HTMLButtonElement | null;
const dismiss = (host: HTMLElement) => host.querySelector(".dreb-suggestion-dismiss") as HTMLButtonElement | null;
const bar = (host: HTMLElement) => host.querySelector(".dreb-suggestion-bar");
const composer = (host: HTMLElement) => host.querySelector(".dreb-input") as HTMLTextAreaElement;
const sendButton = (host: HTMLElement) =>
	Array.from(host.querySelectorAll("button.dreb-send")).find(
		(b) => !b.classList.contains("stop"),
	) as HTMLButtonElement;

/** Simulate the user typing a draft into the composer (drives the onInput handler). */
function typeDraft(host: HTMLElement, value: string) {
	const ta = composer(host);
	ta.value = value;
	ta.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("App — suggest_next wiring", () => {
	it("renders the bar from a snapshot and accepting fills the empty composer (no clobber mode)", () => {
		const host = mountWithSuggestion({ command: "/skill:mach6-push" });
		expect(bar(host)).not.toBeNull();
		expect(composer(host).value).toBe("");

		pill(host)?.click();

		// Accept must *fill* the composer (fill-if-empty), not submit.
		expect(composer(host).value).toBe("/skill:mach6-push");
		expect(postSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "submit" }));
	});

	it("accepting into a non-empty composer preserves the user's draft (fill-if-empty, never clobber)", () => {
		const host = mountWithSuggestion({ command: "/skill:mach6-push" });
		// User has already typed a draft before accepting the suggestion.
		typeDraft(host, "half-written message");
		expect(composer(host).value).toBe("half-written message");

		pill(host)?.click();

		// The whole point of fill-if-empty: accepting must NOT overwrite the draft.
		// With a non-empty composer this diverges from a `replace` mode, so a future
		// regression that switched to `replace` would fail here.
		expect(composer(host).value).toBe("half-written message");
		expect(postSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "submit" }));
	});

	it("dismissing clears the bar locally and tells the host to drop it (no reappear on reload)", () => {
		const host = mountWithSuggestion({ command: "/skill:mach6-push" });
		expect(bar(host)).not.toBeNull();

		dismiss(host)?.click();

		// Local clear: the bar is gone immediately.
		expect(bar(host)).toBeNull();
		// Host clear: the authoritative copy is dropped so a reload snapshot omits
		// it. Without this the dismissed suggestion would come back.
		expect(postSpy).toHaveBeenCalledWith({ type: "dismiss-suggestion" });
	});

	it("submitting drops the suggestion immediately", () => {
		const host = mountWithSuggestion({ command: "/skill:mach6-push" });
		// Accept to fill the composer so there is a message to send.
		pill(host)?.click();
		expect(composer(host).value).toBe("/skill:mach6-push");

		sendButton(host).click();

		expect(bar(host)).toBeNull();
		expect(postSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "submit", text: "/skill:mach6-push" }));
	});

	it("does not render the bar when the snapshot has no suggestion", () => {
		const host = mountWithSuggestion(undefined);
		expect(bar(host)).toBeNull();
	});
});
