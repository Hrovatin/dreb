import { describe, expect, it } from "vitest";
import {
	activitySummary,
	applyEvent,
	createTranscriptState,
	type ResponseGroup,
	type TranscriptState,
} from "../src/shared/projection.js";

/** Feed a list of events through a fresh state. */
function run(events: unknown[]): TranscriptState {
	const state = createTranscriptState();
	for (const event of events) applyEvent(state, event);
	return state;
}

function onlyResponse(state: TranscriptState): ResponseGroup {
	const group = state.items.find((i): i is ResponseGroup => i.kind === "response");
	if (!group) throw new Error("no response group");
	return group;
}

describe("projection", () => {
	it("separates answer text from thinking/tool activity", () => {
		const state = run([
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "user", content: "hello" } },
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_start" } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "pondering" } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_end", content: "pondering done" } },
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } },
			{ type: "tool_execution_update", toolCallId: "t1", partialResult: "reading…" },
			{ type: "tool_execution_end", toolCallId: "t1", result: "file body", isError: false },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Here is " } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "the answer." } },
			{ type: "agent_end" },
		]);

		expect(state.items[0]).toEqual({ kind: "user", text: "hello" });
		const group = onlyResponse(state);
		expect(group.answer).toBe("Here is the answer.");
		expect(group.activity).toHaveLength(2);
		expect(group.activity[0]).toEqual({ kind: "thinking", text: "pondering done" });
		expect(group.activity[1]).toMatchObject({
			kind: "tool",
			toolCallId: "t1",
			toolName: "read",
			status: "done",
			resultText: "file body",
		});
	});

	it("marks the run streaming, then collapses activity at agent_end", () => {
		const state = createTranscriptState();
		applyEvent(state, { type: "agent_start" });
		applyEvent(state, { type: "message_update", assistantMessageEvent: { type: "thinking_start" } });
		let group = onlyResponse(state);
		expect(state.streaming).toBe(true);
		expect(group.streaming).toBe(true);
		expect(group.collapsed).toBe(false);

		applyEvent(state, { type: "agent_end" });
		group = onlyResponse(state);
		expect(state.streaming).toBe(false);
		expect(group.streaming).toBe(false);
		expect(group.collapsed).toBe(true);
	});

	it("accumulates streamed text deltas but adopts text_end when no deltas seen", () => {
		const streamed = run([
			{ type: "agent_start" },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ab" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "cd" } },
		]);
		expect(onlyResponse(streamed).answer).toBe("abcd");

		const nonStreaming = run([
			{ type: "agent_start" },
			{ type: "message_update", assistantMessageEvent: { type: "text_end", content: "whole answer" } },
		]);
		expect(onlyResponse(nonStreaming).answer).toBe("whole answer");
	});

	it("tracks and clears blocking extension-UI requests", () => {
		const state = createTranscriptState();
		applyEvent(state, {
			type: "extension_ui_request",
			id: "u1",
			method: "ask",
			title: "Pick",
			question: "Which?",
			options: ["a", "b"],
			allowFreeText: false,
			multiSelect: true,
		});
		expect(state.uiRequests).toHaveLength(1);
		expect(state.uiRequests[0]).toMatchObject({
			id: "u1",
			method: "ask",
			question: "Which?",
			options: ["a", "b"],
			allowFreeText: false,
			multiSelect: true,
		});

		applyEvent(state, { type: "extension_ui_response_handled", id: "u1" });
		expect(state.uiRequests).toHaveLength(0);
	});

	it("clears pending UI requests when a new run starts", () => {
		const state = createTranscriptState();
		applyEvent(state, { type: "extension_ui_request", id: "u1", method: "confirm", title: "OK?", message: "sure" });
		expect(state.uiRequests).toHaveLength(1);
		applyEvent(state, { type: "agent_start" });
		expect(state.uiRequests).toHaveLength(0);
	});

	it("surfaces a provider error onto the response", () => {
		const state = run([
			{ type: "agent_start" },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } },
			{ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "rate limited" } },
			{ type: "agent_end" },
		]);
		expect(onlyResponse(state).error).toBe("rate limited");
	});

	it("records a synthetic host_error and stops streaming", () => {
		const state = run([
			{ type: "agent_start" },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } },
			{ type: "host_error", message: "dreb process exited (code 1, signal null)" },
		]);
		expect(state.hostError).toContain("exited");
		expect(state.streaming).toBe(false);
		expect(onlyResponse(state).collapsed).toBe(true);
	});

	it("summarizes activity for the collapsed header", () => {
		const group: ResponseGroup = {
			kind: "response",
			id: 1,
			activity: [
				{ kind: "thinking", text: "x" },
				{ kind: "tool", toolCallId: "t1", toolName: "read", args: {}, status: "done", resultText: "" },
				{ kind: "tool", toolCallId: "t2", toolName: "bash", args: {}, status: "done", resultText: "" },
			],
			answer: "",
			streaming: false,
			collapsed: true,
		};
		expect(activitySummary(group)).toBe("1 thought · 2 tool calls");
		expect(activitySummary({ ...group, activity: [] })).toBe("no activity");
	});
});
