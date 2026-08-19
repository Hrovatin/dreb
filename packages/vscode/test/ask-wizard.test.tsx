// @vitest-environment jsdom
/**
 * The `ask` (Q&A) prompt renders the RPC multi-question wizard. The regression it
 * guards against (issue 68): the RPC `ask` request carries `questions[]`, but the
 * extension used to read a flat single-question shape, so the question text and
 * options never rendered. These tests render the real `UiRequestView` in jsdom and
 * assert that every question's prompt + options show and that Send builds one
 * `answers[]` entry per question (skipped when left blank), matching RpcAskAnswer.
 */

import { render } from "solid-js/web/dist/web.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiRequest } from "../src/shared/projection.js";
import type { UiResponse } from "../src/shared/protocol.js";

vi.mock("../src/webview/vscode-api.js", () => ({
	onHostMessage: () => () => {},
	postToHost: () => {},
}));

import { UiRequestView } from "../src/webview/app.js";

let dispose: (() => void) | undefined;
const responses: UiResponse[] = [];

afterEach(() => {
	dispose?.();
	dispose = undefined;
	responses.length = 0;
	document.body.innerHTML = "";
});

function mount(request: UiRequest): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	dispose = render(() => <UiRequestView request={request} onRespond={(r) => responses.push(r)} />, host);
	return host;
}

function askRequest(partial: Partial<UiRequest>): UiRequest {
	return { id: "u1", method: "ask", title: "Question", questions: [], ...partial };
}

describe("AskWizard rendering", () => {
	it("renders the question prompt (as Markdown) and its options", () => {
		const host = mount(
			askRequest({
				questions: [{ question: "Pick **one** please", options: ["alpha", "beta"], allowFreeText: false }],
			}),
		);
		const body = host.querySelector(".dreb-ask-question-body") as HTMLElement;
		expect(body.textContent).toContain("Pick one please");
		// Markdown rendered to HTML, not shown as raw asterisks.
		expect(body.querySelector("strong")?.textContent).toBe("one");
		expect(host.textContent).toContain("alpha");
		expect(host.textContent).toContain("beta");
		// allowFreeText:false hides the free-text field.
		expect(host.querySelector('input[type="text"], textarea')).toBeNull();
		// Single-select uses radios.
		expect(host.querySelectorAll('input[type="radio"]').length).toBe(2);
	});

	it("renders a per-question title and multi-select checkboxes", () => {
		const host = mount(
			askRequest({
				questions: [{ question: "Pick some", title: "Features", options: ["a", "b"], multiSelect: true }],
			}),
		);
		expect(host.querySelector(".dreb-ask-question-title")?.textContent).toBe("Features");
		expect(host.querySelectorAll('input[type="checkbox"]').length).toBe(2);
	});

	it("Send builds one answer per question, marking unanswered ones skipped", () => {
		const host = mount(
			askRequest({
				questions: [
					{ question: "Q1", options: ["a", "b"], allowFreeText: false },
					{ question: "Q2", allowFreeText: true },
				],
			}),
		);
		// Answer only the first question (select option "b"); leave Q2 blank.
		const radios = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
		const optionB = Array.from(radios).find(
			(r) =>
				(r.closest("label")?.textContent ?? "").includes("b") &&
				!(r.closest("label")?.textContent ?? "").includes("a"),
		);
		(optionB ?? radios[1]).click();

		const send = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Send");
		send?.click();

		expect(responses).toEqual([
			{
				id: "u1",
				answers: [
					{ selected: ["b"], customText: undefined },
					{ selected: [], skipped: true },
				],
			},
		]);
	});

	it("Send captures free-text answers", () => {
		const host = mount(askRequest({ questions: [{ question: "Anything?", allowFreeText: true }] }));
		const input = host.querySelector<HTMLInputElement>('input[type="text"]');
		expect(input).toBeTruthy();
		if (input) {
			input.value = "my answer";
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}
		const send = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Send");
		send?.click();

		expect(responses).toEqual([{ id: "u1", answers: [{ selected: [], customText: "my answer" }] }]);
	});

	it("Cancel cancels the whole request", () => {
		const host = mount(askRequest({ questions: [{ question: "Q", options: ["a"] }] }));
		const cancel = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Cancel");
		cancel?.click();
		expect(responses).toEqual([{ id: "u1", cancelled: true }]);
	});
});
