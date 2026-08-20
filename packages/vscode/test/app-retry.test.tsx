// @vitest-environment jsdom
/**
 * Retry control on an errored response (issue 61).
 *
 * `retryableResponseId` (which turn qualifies) is unit-tested in
 * `projection.test.ts`; this file renders the real `ResponseView` in jsdom to
 * verify the *glue*: an errored group given an `onRetry` handler renders a Retry
 * button that calls the handler on click, and a group without `onRetry` (a clean
 * turn, or a stale errored turn the parent chose not to make retryable) renders
 * no button. A class/handler rename or a wrong `Show` guard would fail here.
 */

import { render } from "solid-js/web/dist/web.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResponseGroup } from "../src/shared/projection.js";

vi.mock("../src/webview/vscode-api.js", () => ({
	onHostMessage: () => () => {},
	postToHost: () => {},
}));

import { ResponseView, RetryBanner } from "../src/webview/app.js";

const erroredGroup = (): ResponseGroup => ({
	kind: "response",
	id: 1,
	activity: [],
	answer: "",
	streaming: false,
	collapsed: true,
	error: "Provider unavailable (503)",
});

let dispose: (() => void) | undefined;

afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.innerHTML = "";
});

function mount(group: ResponseGroup, onRetry?: () => void): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	dispose = render(() => <ResponseView group={group} onRetry={onRetry} />, host);
	return host;
}

describe("ResponseView retry control", () => {
	it("renders the error text and a Retry button when onRetry is provided", () => {
		const host = mount(erroredGroup(), () => {});
		expect(host.querySelector(".dreb-banner.error")?.textContent).toContain("Provider unavailable (503)");
		expect(host.querySelector("button.dreb-retry-btn")).not.toBeNull();
	});

	it("calls onRetry when the Retry button is clicked", () => {
		const onRetry = vi.fn();
		const host = mount(erroredGroup(), onRetry);
		const button = host.querySelector("button.dreb-retry-btn") as HTMLButtonElement;
		button.click();
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("shows the error banner but no Retry button when onRetry is absent", () => {
		const host = mount(erroredGroup());
		expect(host.querySelector(".dreb-banner.error")).not.toBeNull();
		expect(host.querySelector("button.dreb-retry-btn")).toBeNull();
	});

	it("renders neither error banner nor Retry button for a clean turn", () => {
		const clean: ResponseGroup = { ...erroredGroup(), error: undefined, answer: "all done" };
		const host = mount(clean, () => {});
		expect(host.querySelector(".dreb-banner.error")).toBeNull();
		expect(host.querySelector("button.dreb-retry-btn")).toBeNull();
	});

	it("renders the Interrupted marker when the group is aborted", () => {
		const aborted: ResponseGroup = {
			...erroredGroup(),
			error: undefined,
			answer: "partial reply",
			aborted: true,
		};
		const host = mount(aborted);
		const marker = host.querySelector(".dreb-aborted");
		expect(marker).not.toBeNull();
		expect(marker?.textContent).toContain("Interrupted");
	});

	it("renders no Interrupted marker for a non-aborted turn", () => {
		const clean: ResponseGroup = { ...erroredGroup(), error: undefined, answer: "all done" };
		const host = mount(clean);
		expect(host.querySelector(".dreb-aborted")).toBeNull();
	});
});

/**
 * `RetryBanner` is the shared primitive rendered by the crash-recovery transcript
 * item (`item.kind === "recovery"`) and the response error group. These tests pin
 * the recovery notice's glue directly: the message text renders, and the Retry
 * button appears (and fires) only when `onRetry` is supplied — which the app wires
 * to `item.canRetry`. A wrong `Show` guard, class rename, or missing handler would
 * fail here, so a broken/missing recovery notice can't ship silently.
 */
describe("RetryBanner (crash-recovery notice)", () => {
	function mountBanner(text: string, onRetry?: () => void): HTMLElement {
		const host = document.createElement("div");
		document.body.appendChild(host);
		dispose = render(() => <RetryBanner text={text} onRetry={onRetry} />, host);
		return host;
	}

	it("renders the recovery text and a Retry button when retryable", () => {
		const host = mountBanner("Session recovered — last reply not saved. Cause: output overflow.", () => {});
		expect(host.querySelector(".dreb-banner.error")?.textContent).toContain("Session recovered");
		expect(host.querySelector(".dreb-banner.error")?.textContent).toContain("Cause: output overflow");
		expect(host.querySelector("button.dreb-retry-btn")).not.toBeNull();
	});

	it("calls onRetry when the Retry button is clicked", () => {
		const onRetry = vi.fn();
		const host = mountBanner("Session recovered.", onRetry);
		(host.querySelector("button.dreb-retry-btn") as HTMLButtonElement).click();
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("renders the text but no Retry button when not retryable", () => {
		const host = mountBanner("Session recovered after an unexpected exit. The session is idle.");
		expect(host.querySelector(".dreb-banner.error")?.textContent).toContain("session is idle");
		expect(host.querySelector("button.dreb-retry-btn")).toBeNull();
	});
});
