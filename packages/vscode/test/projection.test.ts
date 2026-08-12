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

function allResponses(state: TranscriptState): ResponseGroup[] {
	return state.items.filter((i): i is ResponseGroup => i.kind === "response");
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

	it("groups sequential agent runs into distinct responses", () => {
		const state = run([
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "first" } },
			{ type: "agent_end" },
			{ type: "message_start", message: { role: "user", content: "again" } },
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "second" } },
			{ type: "agent_end" },
		]);

		const responses = allResponses(state);
		expect(responses).toHaveLength(2);
		expect(responses.map((r) => r.answer)).toEqual(["first", "second"]);
		expect(responses[0].id).not.toBe(responses[1].id);
		expect(responses.every((r) => r.collapsed && !r.streaming)).toBe(true);
		// The interleaved user turn sits between the two responses.
		expect(state.items.map((i) => i.kind)).toEqual(["response", "user", "response"]);
	});

	it("keeps interleaved concurrent tool calls on their own entries", () => {
		const state = run([
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a" } },
			{ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { cmd: "ls" } },
			{ type: "tool_execution_update", toolCallId: "t2", partialResult: "listing…" },
			{ type: "tool_execution_update", toolCallId: "t1", partialResult: "reading…" },
			{ type: "tool_execution_end", toolCallId: "t2", result: "t2 output", isError: false },
			{ type: "tool_execution_end", toolCallId: "t1", result: "t1 output", isError: true },
			{ type: "agent_end" },
		]);

		const tools = onlyResponse(state).activity.filter((a) => a.kind === "tool");
		expect(tools).toHaveLength(2);
		expect(tools[0]).toMatchObject({ toolCallId: "t1", toolName: "read", status: "error", resultText: "t1 output" });
		expect(tools[1]).toMatchObject({ toolCallId: "t2", toolName: "bash", status: "done", resultText: "t2 output" });
	});

	it("sets and clears the compaction status without clobbering an unrelated status", () => {
		const state = createTranscriptState();
		applyEvent(state, { type: "auto_compaction_start" });
		expect(state.statusText).toBe("compacting context…");
		applyEvent(state, { type: "auto_compaction_end" });
		expect(state.statusText).toBeUndefined();

		// If a different status is set after compaction started, the compaction-end
		// guard must NOT clear it.
		applyEvent(state, { type: "auto_compaction_start" });
		applyEvent(state, { type: "auto_retry_start", attempt: 1, maxAttempts: 3 });
		expect(state.statusText).toBe("retrying (1/3)…");
		applyEvent(state, { type: "auto_compaction_end" });
		expect(state.statusText).toBe("retrying (1/3)…");
	});

	it("sets a numbered retry status and clears it on retry end", () => {
		const state = createTranscriptState();
		applyEvent(state, { type: "auto_retry_start", attempt: 2, maxAttempts: 5 });
		expect(state.statusText).toBe("retrying (2/5)…");
		applyEvent(state, { type: "auto_retry_end" });
		expect(state.statusText).toBeUndefined();
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
