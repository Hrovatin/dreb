import { describe, expect, it } from "vitest";
import {
	type ActivityItem,
	activityItemsSummary,
	alignCheckpoints,
	applyEvent,
	createTranscriptState,
	foldMessagesIntoState,
	type ResponseGroup,
	retryableResponseId,
	runActivity,
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
		expect(runActivity(group)).toHaveLength(2);
		expect(runActivity(group)[0]).toEqual({ kind: "thinking", text: "pondering done" });
		expect(runActivity(group)[1]).toMatchObject({
			kind: "tool",
			toolCallId: "t1",
			toolName: "read",
			status: "done",
			resultText: "file body",
		});
	});

	it("separates narration text blocks split by a tool call, but not within one block", () => {
		const state = run([
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Let me look. " } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "First the config." } },
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } },
			{ type: "tool_execution_end", toolCallId: "t1", result: "body", isError: false },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Now the answer." } },
			{ type: "agent_end" },
		]);
		// Deltas within one block stay joined; a new block after the tool gets a blank line.
		expect(onlyResponse(state).answer).toBe("Let me look. First the config.\n\nNow the answer.");
	});

	it("interleaves activity boxes and answer blocks in true streaming order (segments)", () => {
		const state = run([
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant" } },
			// Box 1: think + tool
			{ type: "message_update", assistantMessageEvent: { type: "thinking_start" } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "planning" } },
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } },
			{ type: "tool_execution_end", toolCallId: "t1", result: "body", isError: false },
			// Answer 1
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "First result." } },
			// Box 2: tool + think (arrives AFTER answer 1 — must open a new box, not join box 1)
			{ type: "tool_execution_start", toolCallId: "t2", toolName: "grep", args: { pattern: "x" } },
			{ type: "tool_execution_end", toolCallId: "t2", result: "hit", isError: false },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_start" } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "more" } },
			// Answer 2
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Second result." } },
			{ type: "agent_end" },
		]);

		const group = onlyResponse(state);
		expect(group.segments.map((s) => s.kind)).toEqual(["activity", "answer", "activity", "answer"]);
		const [box1, ans1, box2, ans2] = group.segments;
		expect(box1.kind === "activity" && box1.items.map((i) => i.kind)).toEqual(["thinking", "tool"]);
		expect(ans1).toEqual({ kind: "answer", text: "First result." });
		expect(box2.kind === "activity" && box2.items.map((i) => i.kind)).toEqual(["tool", "thinking"]);
		expect(ans2).toEqual({ kind: "answer", text: "Second result." });
		// The aggregate views still hold the whole run.
		expect(runActivity(group)).toHaveLength(4);
		expect(group.answer).toBe("First result.\n\nSecond result.");
	});

	it("delivers a post-snapshot tool result to the rendered segment item (regression: mid-stream reload)", () => {
		// A run streaming a still-running tool inside an activity box.
		const state = run([
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } },
		]);

		// Simulate the host→webview snapshot boundary: VS Code's postMessage
		// JSON-serializes the transcript, dropping any shared object references.
		// Before the single-source-of-truth fix, the flat `activity` aggregate and
		// the rendered `segments[].items` became two distinct copies here, so a
		// later tool_execution_end mutated only the aggregate (walked by findTool)
		// while the box kept rendering a stuck "running" spinner. Reproduce that
		// boundary and assert the item the box actually renders reflects completion.
		const rehydrated: TranscriptState = JSON.parse(JSON.stringify(state));
		applyEvent(rehydrated, { type: "tool_execution_end", toolCallId: "t1", result: "file body", isError: false });

		const box = onlyResponse(rehydrated).segments.find((s) => s.kind === "activity");
		const tool = box?.kind === "activity" ? box.items.find((i) => i.kind === "tool") : undefined;
		expect(tool).toMatchObject({ status: "done", resultText: "file body" });
		// The derived aggregate reflects it too (single source of truth).
		expect(runActivity(onlyResponse(rehydrated))[0]).toMatchObject({ status: "done", resultText: "file body" });
	});

	it("delivers post-snapshot thinking deltas to the rendered segment item (regression: mid-stream reload)", () => {
		const state = run([
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_start" } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "first" } },
		]);
		const rehydrated: TranscriptState = JSON.parse(JSON.stringify(state));
		applyEvent(rehydrated, {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: " second" },
		});

		const box = onlyResponse(rehydrated).segments.find((s) => s.kind === "activity");
		const thought = box?.kind === "activity" ? box.items[0] : undefined;
		expect(thought).toEqual({ kind: "thinking", text: "first second" });
	});

	it("coalesces consecutive thinking/tools into one box, and collapses finished boxes", () => {
		const state = run([
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_start" } },
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} },
			{ type: "tool_execution_end", toolCallId: "t1", result: "b", isError: false },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer" } },
		]);

		const streaming = onlyResponse(state);
		expect(streaming.segments).toHaveLength(2);
		const box = streaming.segments[0];
		expect(box.kind === "activity" && box.items).toHaveLength(2);
		// The box is finished (an answer opened after it) → collapsed even while the run streams.
		expect(box.kind === "activity" && box.collapsed).toBe(true);

		// A trailing box (no answer after it) collapses only when the run ends.
		applyEvent(state, { type: "tool_execution_start", toolCallId: "t2", toolName: "grep", args: {} });
		const trailing = onlyResponse(state).segments[2];
		expect(trailing.kind === "activity" && trailing.collapsed).toBe(false);
		applyEvent(state, { type: "agent_end" });
		const closed = onlyResponse(state).segments[2];
		expect(closed.kind === "activity" && closed.collapsed).toBe(true);
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

	it("adopts every block of a multi-block non-streaming reply, and never double-appends streamed blocks", () => {
		// A non-streaming provider emits only text_end per block; all blocks must land,
		// not just the first.
		const multiBlock = run([
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_end", content: "first block" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_end", content: "second block" } },
			{ type: "agent_end" },
		]);
		expect(onlyResponse(multiBlock).answer).toBe("first blocksecond block");

		// A streaming provider sends deltas AND text_end with the same content — the
		// text_end adoption must not duplicate it.
		const streamed = run([
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streamed" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_end", content: "streamed" } },
			{ type: "agent_end" },
		]);
		expect(onlyResponse(streamed).answer).toBe("streamed");
	});

	it("marks a run aborted on an assistant message_end with stopReason aborted", () => {
		const state = run([
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial ans" } },
			{ type: "message_end", message: { role: "assistant", stopReason: "aborted" } },
			{ type: "agent_end" },
		]);
		const group = onlyResponse(state);
		expect(group.aborted).toBe(true);
		expect(group.error).toBeUndefined();
	});

	it("maps an ask request's questions[] into a structured multi-question wizard", () => {
		const state = createTranscriptState();
		applyEvent(state, {
			type: "extension_ui_request",
			id: "u1",
			method: "ask",
			title: "Choices",
			questions: [
				{ question: "Which?", title: "Pick one", options: ["a", "b"], allowFreeText: false, multiSelect: true },
				{ question: "Free thoughts?", allowFreeText: true, multiline: true },
			],
			expiresAt: 123456,
		});
		expect(state.uiRequests).toHaveLength(1);
		expect(state.uiRequests[0]).toMatchObject({
			id: "u1",
			method: "ask",
			title: "Choices",
			expiresAt: 123456,
			questions: [
				{ question: "Which?", title: "Pick one", options: ["a", "b"], allowFreeText: false, multiSelect: true },
				{ question: "Free thoughts?", allowFreeText: true, multiline: true },
			],
		});

		applyEvent(state, { type: "extension_ui_response_handled", id: "u1" });
		expect(state.uiRequests).toHaveLength(0);
	});

	it("falls back to a single question for a legacy flat ask event shape", () => {
		const state = createTranscriptState();
		applyEvent(state, {
			type: "extension_ui_request",
			id: "u2",
			method: "ask",
			title: "Legacy",
			question: "Old shape?",
			options: ["x", "y"],
			allowFreeText: false,
		});
		expect(state.uiRequests[0]).toMatchObject({
			id: "u2",
			method: "ask",
			questions: [{ question: "Old shape?", options: ["x", "y"], allowFreeText: false }],
		});
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

	it("appends a synthetic host_system line as a persistent transcript item", () => {
		const state = run([
			{ type: "message_start", message: { role: "user", content: "hi" } },
			{ type: "host_system", text: "Session stats\n  cost: $0.0000" },
		]);
		expect(state.items.map((i) => i.kind)).toEqual(["user", "system"]);
		const system = state.items[1];
		expect(system.kind === "system" && system.text).toContain("Session stats");
	});

	it("appends a host_recovery item with the cause folded into the text", () => {
		const state = run([
			{ type: "message_start", message: { role: "user", content: "?" } },
			{
				type: "host_recovery",
				message: "Session recovered after an unexpected exit. The last reply was not saved — the session is idle.",
				cause: "output overflow — the reply was too large for the connection buffer",
				canRetry: true,
			},
		]);
		expect(state.items.map((i) => i.kind)).toEqual(["user", "recovery"]);
		const recovery = state.items[1];
		expect(recovery.kind).toBe("recovery");
		if (recovery.kind === "recovery") {
			expect(recovery.text).toContain("Session recovered");
			expect(recovery.text).toContain("Cause: output overflow");
			expect(recovery.canRetry).toBe(true);
		}
	});

	it("renders a host_recovery item without a cause and defaults canRetry to false", () => {
		const state = run([{ type: "host_recovery", message: "Session recovered — the session is idle." }]);
		const recovery = state.items[0];
		expect(recovery.kind).toBe("recovery");
		if (recovery.kind === "recovery") {
			expect(recovery.text).toBe("Session recovered — the session is idle.");
			expect(recovery.text).not.toContain("Cause:");
			expect(recovery.canRetry).toBe(false);
		}
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

		const tools = runActivity(onlyResponse(state)).filter((a) => a.kind === "tool");
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

	it("summarizes a box's activity items for the collapsed header", () => {
		const items: ActivityItem[] = [
			{ kind: "thinking", text: "x" },
			{ kind: "tool", toolCallId: "t1", toolName: "read", args: {}, status: "done", resultText: "" },
			{ kind: "tool", toolCallId: "t2", toolName: "bash", args: {}, status: "done", resultText: "" },
		];
		expect(activityItemsSummary(items)).toBe("1 thought · 2 tool calls");
		expect(activityItemsSummary([])).toBe("no activity");
	});

	describe("background agents", () => {
		it("tracks a running background agent id on background_agent_start", () => {
			const state = run([{ type: "background_agent_start", agentId: "abc123", agentType: "Explore" }]);
			expect(state.backgroundAgentIds).toEqual(["abc123"]);
		});

		it("dedupes a repeated start for the same agent id", () => {
			const state = run([
				{ type: "background_agent_start", agentId: "abc123" },
				{ type: "background_agent_start", agentId: "abc123" },
			]);
			expect(state.backgroundAgentIds).toEqual(["abc123"]);
		});

		it("removes the id on background_agent_end", () => {
			const state = run([
				{ type: "background_agent_start", agentId: "a" },
				{ type: "background_agent_start", agentId: "b" },
				{ type: "background_agent_end", agentId: "a" },
			]);
			expect(state.backgroundAgentIds).toEqual(["b"]);
		});

		it("ignores background_agent_end for an unknown id", () => {
			const state = run([
				{ type: "background_agent_start", agentId: "a" },
				{ type: "background_agent_end", agentId: "zzz" },
			]);
			expect(state.backgroundAgentIds).toEqual(["a"]);
		});

		it("initializes an empty set on a fresh transcript", () => {
			expect(createTranscriptState().backgroundAgentIds).toEqual([]);
		});
	});
});

describe("foldMessagesIntoState (Phase 6 full-content rebuild)", () => {
	it("marks a rebuilt group aborted when the persisted assistant message was interrupted", () => {
		const state = createTranscriptState();
		foldMessagesIntoState(state, [
			{ role: "user", content: "question" },
			// A recovered reply is persisted with stopReason "aborted" — the rebuilt
			// transcript must carry the marker so the UI can show it was interrupted.
			{ role: "assistant", content: [{ type: "text", text: "recovered reply" }], stopReason: "aborted" },
		]);
		const group = onlyResponse(state);
		expect(group.answer).toBe("recovered reply");
		expect(group.aborted).toBe(true);
		expect(group.error).toBeUndefined();
	});

	it("rebuilds plain user/assistant turns in place with full answers (stable reference)", () => {
		const state = createTranscriptState();
		state.items.push({ kind: "user", text: "stale" });
		const ref = state; // same object must survive

		foldMessagesIntoState(state, [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: [{ type: "text", text: "hello there" }], stopReason: "stop" },
			{ role: "user", content: "again" },
			{ role: "assistant", content: [{ type: "text", text: "world" }], stopReason: "stop" },
		]);

		expect(state).toBe(ref);
		expect(
			state.items.map((i) => (i.kind === "user" ? `u:${i.text}` : i.kind === "response" ? `a:${i.answer}` : i.text)),
		).toEqual(["u:hi", "a:hello there", "u:again", "a:world"]);
		const groups = state.items.filter((i): i is ResponseGroup => i.kind === "response");
		expect(groups.map((g) => g.id)).toEqual([1, 2]);
		expect(groups.every((g) => !g.streaming && g.collapsed)).toBe(true);
		expect(state.nextResponseId).toBe(3);
	});

	it("folds a tool-using run into ONE group with a thinking/tool activity box + full answer", () => {
		const state = createTranscriptState();
		foldMessagesIntoState(state, [
			{ role: "user", content: "do it" },
			// Intermediate tool-call assistant turn (no final text) — must NOT become
			// a separate "(no content)" block.
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "let me check" },
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } },
				],
				stopReason: "toolUse",
			},
			{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "file body" }] },
			// Final answer assistant turn in the SAME run.
			{ role: "assistant", content: [{ type: "text", text: "here is the answer" }], stopReason: "stop" },
		]);

		const groups = state.items.filter((i): i is ResponseGroup => i.kind === "response");
		expect(groups).toHaveLength(1);
		const g = groups[0];
		expect(g.answer).toBe("here is the answer");
		expect(activityItemsSummary(runActivity(g))).toBe("1 thought · 1 tool call");
		const tool = runActivity(g).find((a) => a.kind === "tool");
		expect(tool).toMatchObject({ toolCallId: "t1", toolName: "read", status: "done", resultText: "file body" });
	});

	it("coalesces a rebuilt burst of back-to-back tool calls (separate messages) into ONE box", () => {
		// Two tool calls arriving as SEPARATE assistant+toolResult message pairs with
		// no intervening answer text must fold into a single activity box — identical
		// to how the live stream coalesces consecutive tools (AC 2 / AC 3). Guards the
		// rebuild path's across-message coalescing, which shares pushActivity with live.
		const state = createTranscriptState();
		foldMessagesIntoState(state, [
			{ role: "user", content: "do both" },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } }],
				stopReason: "toolUse",
			},
			{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "body a" }] },
			// A SECOND tool call in its own assistant turn, with NO answer text between.
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "t2", name: "grep", arguments: { pattern: "x" } }],
				stopReason: "toolUse",
			},
			{ role: "toolResult", toolCallId: "t2", toolName: "grep", content: [{ type: "text", text: "body b" }] },
			{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
		]);

		const g = state.items.find((i): i is ResponseGroup => i.kind === "response");
		if (!g) throw new Error("no response group");
		// Exactly ONE activity box (not two stacked boxes), holding both tools in order.
		const activityBoxes = g.segments.filter((s) => s.kind === "activity");
		expect(activityBoxes).toHaveLength(1);
		const box = activityBoxes[0];
		expect(box.kind === "activity" && box.items.map((i) => i.kind)).toEqual(["tool", "tool"]);
		expect(box.kind === "activity" && box.items.map((i) => (i.kind === "tool" ? i.toolCallId : null))).toEqual([
			"t1",
			"t2",
		]);
		// Whole run: one box, then the final answer.
		expect(g.segments.map((s) => s.kind)).toEqual(["activity", "answer"]);
		expect(g.answer).toBe("done");
	});

	it("rebuilds interleaved answer/activity into ordered segments matching the live stream", () => {
		const state = createTranscriptState();
		foldMessagesIntoState(state, [
			{ role: "user", content: "go" },
			// One run: text, then a tool call, then more text — content parts in order.
			{
				role: "assistant",
				content: [
					{ type: "text", text: "First." },
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } },
				],
				stopReason: "toolUse",
			},
			{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "body" }] },
			{ role: "assistant", content: [{ type: "text", text: "Second." }], stopReason: "stop" },
		]);

		const g = state.items.find((i): i is ResponseGroup => i.kind === "response");
		if (!g) throw new Error("no response group");
		expect(g.segments.map((s) => s.kind)).toEqual(["answer", "activity", "answer"]);
		expect(g.segments[0]).toEqual({ kind: "answer", text: "First." });
		expect(g.segments[2]).toEqual({ kind: "answer", text: "Second." });
		// Every rebuilt (historical) box is collapsed.
		const box = g.segments[1];
		expect(box.kind === "activity" && box.collapsed).toBe(true);
	});

	it("marks a tool as error when its result is an error, and leaves an unmatched tool running", () => {
		const state = createTranscriptState();
		foldMessagesIntoState(state, [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "ok", name: "read", arguments: {} },
					{ type: "toolCall", id: "pending", name: "grep", arguments: {} },
				],
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: "ok",
				toolName: "read",
				isError: true,
				content: [{ type: "text", text: "boom" }],
			},
			{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
		]);
		const g = state.items.find((i): i is ResponseGroup => i.kind === "response");
		const ok = g && runActivity(g).find((a) => a.kind === "tool" && a.toolCallId === "ok");
		const pending = g && runActivity(g).find((a) => a.kind === "tool" && a.toolCallId === "pending");
		expect(ok).toMatchObject({ status: "error", resultText: "boom" });
		expect(pending).toMatchObject({ status: "running", resultText: "" });
	});

	it("stamps the group error for a provider-error turn and leaves aborted turns without fake content", () => {
		const state = createTranscriptState();
		foldMessagesIntoState(state, [
			{ role: "user", content: "one" },
			{ role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" },
			{ role: "user", content: "two" },
			{ role: "assistant", content: [], stopReason: "aborted" },
		]);
		const groups = state.items.filter((i): i is ResponseGroup => i.kind === "response");
		expect(groups).toHaveLength(2);
		expect(groups[0].error).toBe("rate limited");
		expect(groups[0].answer).toBe("");
		// Aborted/empty turn: an empty group, not a "(aborted)" placeholder.
		expect(groups[1].error).toBeUndefined();
		expect(groups[1].answer).toBe("");
		expect(runActivity(groups[1])).toEqual([]);
	});

	it("resets transient state (streaming, uiRequests, errors)", () => {
		const state = createTranscriptState();
		state.streaming = true;
		state.hostError = "dead";
		state.uiRequests.push({ id: "x", method: "confirm", title: "?" });
		foldMessagesIntoState(state, []);
		expect(state.streaming).toBe(false);
		expect(state.hostError).toBeUndefined();
		expect(state.uiRequests).toEqual([]);
		expect(state.items).toEqual([]);
	});
});

describe("alignCheckpoints (Phase 6)", () => {
	function withResponses(count: number): TranscriptState {
		const state = createTranscriptState();
		for (let i = 0; i < count; i++) {
			state.items.push({
				kind: "response",
				segments: [],
				id: i + 1,
				answer: `a${i}`,
				streaming: false,
				collapsed: true,
			});
		}
		return state;
	}

	it("keys checkpoints by response id; latest turn has canRestore false", () => {
		const state = withResponses(2);
		expect(alignCheckpoints(state, ["e1", "e2"], new Set(["e1", "e2"]))).toEqual([
			{ responseId: 1, entryId: "e1", canRestore: true, canFork: true },
			{ responseId: 2, entryId: "e2", canRestore: false, canFork: true },
		]);
	});

	it("skips only actively-streaming groups (the in-flight turn has no persisted entry yet)", () => {
		const state = createTranscriptState();
		state.items.push({
			kind: "response",
			segments: [],
			id: 1,
			answer: "ok",
			streaming: false,
			collapsed: true,
		});
		state.items.push({
			kind: "response",
			segments: [],
			id: 2,
			answer: "",
			streaming: true,
			collapsed: false,
		});
		expect(alignCheckpoints(state, ["e1"], new Set(["e1"]))).toEqual([
			{ responseId: 1, entryId: "e1", canRestore: false, canFork: true },
		]);
	});

	it("KEEPS errored groups aligned to their entry — a provider-error turn is persisted (finding 1)", () => {
		// [A ok, B error, C ok]: the errored turn B is still a persisted session
		// entry (present in assistantEntryIds), so it must keep its slot. Dropping
		// it would pair A with B's id (off-by-one) — the bug this guards.
		// Fork is offered only where the backend allows it: the errored turn B is
		// NOT in the forkable set, so its canFork is false.
		const state = createTranscriptState();
		state.items.push({
			kind: "response",
			segments: [],
			id: 1,
			answer: "a",
			streaming: false,
			collapsed: true,
		});
		state.items.push({
			kind: "response",
			segments: [],
			id: 2,
			answer: "",
			streaming: false,
			collapsed: true,
			error: "rate limited",
		});
		state.items.push({
			kind: "response",
			segments: [],
			id: 3,
			answer: "c",
			streaming: false,
			collapsed: true,
		});
		expect(alignCheckpoints(state, ["a", "b", "c"], new Set(["a", "c"]))).toEqual([
			{ responseId: 1, entryId: "a", canRestore: true, canFork: true },
			{ responseId: 2, entryId: "b", canRestore: true, canFork: false },
			{ responseId: 3, entryId: "c", canRestore: false, canFork: true },
		]);
	});

	it("gates canFork on the forkable set — non-forkable turns (errored/aborted/tool) hide Fork (finding A)", () => {
		const state = withResponses(2);
		// Only the first turn is forkable; the latest (e.g. a tool-using turn) is not.
		expect(alignCheckpoints(state, ["e1", "e2"], new Set(["e1"]))).toEqual([
			{ responseId: 1, entryId: "e1", canRestore: true, canFork: true },
			{ responseId: 2, entryId: "e2", canRestore: false, canFork: false },
		]);
	});

	it("degrades gracefully on a length mismatch, anchoring from the most recent turn", () => {
		// 3 response groups but only 2 entry ids → the oldest group gets no control,
		// and alignment anchors the newest turns.
		const state = withResponses(3);
		expect(alignCheckpoints(state, ["e2", "e3"], new Set(["e2", "e3"]))).toEqual([
			{ responseId: 2, entryId: "e2", canRestore: true, canFork: true },
			{ responseId: 3, entryId: "e3", canRestore: false, canFork: true },
		]);
	});

	it("returns nothing when there are no entries", () => {
		expect(alignCheckpoints(withResponses(2), [], new Set())).toEqual([]);
	});
});

describe("suggest_next → state.suggestion", () => {
	/** A `suggest_next` tool result as it crosses RPC: the command + recap live
	 * in `details` (plain JSON), alongside the "Suggestion registered" content. */
	const suggestResult = (suggestion: string, summary?: string) => ({
		content: [{ type: "text", text: `Suggestion registered: ${suggestion}` }],
		details: { suggestion, summary },
	});

	it("sets the command from the suggest_next event", () => {
		const state = run([{ type: "suggest_next", command: "/skill:mach6-push" }]);
		expect(state.suggestion).toEqual({ command: "/skill:mach6-push", summary: undefined });
	});

	it("trims the command and ignores an empty one", () => {
		expect(run([{ type: "suggest_next", command: "  /x  " }]).suggestion).toEqual({
			command: "/x",
			summary: undefined,
		});
		expect(run([{ type: "suggest_next", command: "   " }]).suggestion).toBeUndefined();
	});

	it("folds the summary in from the tool result, after the command event", () => {
		const state = run([
			{ type: "suggest_next", command: "/skill:mach6-push" },
			{
				type: "tool_execution_end",
				toolCallId: "s1",
				toolName: "suggest_next",
				result: suggestResult("/skill:mach6-push", "Did the thing."),
				isError: false,
			},
		]);
		expect(state.suggestion).toEqual({ command: "/skill:mach6-push", summary: "Did the thing." });
	});

	it("captures both command and summary from the tool result alone (event never arrives)", () => {
		const state = run([
			{
				type: "tool_execution_end",
				toolCallId: "s1",
				toolName: "suggest_next",
				result: suggestResult("/skill:mach6-push", "Recap."),
				isError: false,
			},
		]);
		expect(state.suggestion).toEqual({ command: "/skill:mach6-push", summary: "Recap." });
	});

	it("merges regardless of event/tool ordering (tool result first)", () => {
		const state = run([
			{
				type: "tool_execution_end",
				toolCallId: "s1",
				toolName: "suggest_next",
				result: suggestResult("/from-details", "Recap."),
				isError: false,
			},
			{ type: "suggest_next", command: "/from-event" },
		]);
		// The event is authoritative for the command; the summary is retained.
		expect(state.suggestion).toEqual({ command: "/from-event", summary: "Recap." });
	});

	it("does not capture the summary when the suggest_next tool errored", () => {
		const state = run([
			{ type: "suggest_next", command: "/x" },
			{
				type: "tool_execution_end",
				toolCallId: "s1",
				toolName: "suggest_next",
				result: suggestResult("/x", "Recap."),
				isError: true,
			},
		]);
		expect(state.suggestion).toEqual({ command: "/x", summary: undefined });
	});

	it("handles a malformed / absent details without throwing and keeps the command", () => {
		expect(() =>
			run([
				{ type: "suggest_next", command: "/x" },
				{
					type: "tool_execution_end",
					toolCallId: "s1",
					toolName: "suggest_next",
					result: "oops-string",
					isError: false,
				},
			]),
		).not.toThrow();
		const state = run([
			{ type: "suggest_next", command: "/x" },
			{ type: "tool_execution_end", toolCallId: "s1", toolName: "suggest_next", result: {}, isError: false },
		]);
		expect(state.suggestion).toEqual({ command: "/x", summary: undefined });
	});

	it("ignores a blank summary string", () => {
		const state = run([
			{
				type: "tool_execution_end",
				toolCallId: "s1",
				toolName: "suggest_next",
				result: suggestResult("/x", "   "),
				isError: false,
			},
		]);
		expect(state.suggestion).toEqual({ command: "/x", summary: undefined });
	});

	it("clears the suggestion when the next turn starts (agent_start)", () => {
		const state = run([{ type: "suggest_next", command: "/x" }, { type: "agent_start" }]);
		expect(state.suggestion).toBeUndefined();
	});

	it("clears the suggestion when the user opens a new exchange (message_start user)", () => {
		const state = run([
			{ type: "suggest_next", command: "/x" },
			{ type: "message_start", message: { role: "user", content: "next thing" } },
		]);
		expect(state.suggestion).toBeUndefined();
	});

	it("survives a JSON snapshot round-trip (host → webview)", () => {
		const state = run([
			{ type: "suggest_next", command: "/skill:mach6-push" },
			{
				type: "tool_execution_end",
				toolCallId: "s1",
				toolName: "suggest_next",
				result: suggestResult("/skill:mach6-push", "Recap."),
				isError: false,
			},
		]);
		const roundTripped = JSON.parse(JSON.stringify(state)) as TranscriptState;
		expect(roundTripped.suggestion).toEqual({ command: "/skill:mach6-push", summary: "Recap." });
	});
});

describe("retryableResponseId", () => {
	/** Events that produce one completed, provider-errored assistant turn preceded
	 * by its user message (the shape a failed/unanswered turn leaves behind). */
	const erroredTurn = (message = "boom") => [
		{ type: "message_start", message: { role: "user", content: "do the thing" } },
		{ type: "agent_start" },
		{ type: "message_start", message: { role: "assistant" } },
		{ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: message } },
		{ type: "agent_end" },
	];

	it("returns the id of a completed, errored last turn", () => {
		const state = run(erroredTurn());
		const group = onlyResponse(state);
		expect(group.error).toBe("boom");
		expect(retryableResponseId(state)).toBe(group.id);
	});

	it("returns undefined for a fresh, empty transcript", () => {
		expect(retryableResponseId(createTranscriptState())).toBeUndefined();
	});

	it("returns undefined when the last turn is clean (no error)", () => {
		const state = run([
			{ type: "message_start", message: { role: "user", content: "hi" } },
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "all good" } },
			{ type: "agent_end" },
		]);
		expect(retryableResponseId(state)).toBeUndefined();
	});

	it("returns undefined while the errored turn is still streaming", () => {
		// Same errored turn but without the terminal agent_end: the run may still
		// resolve, so no retry control is offered yet.
		const state = run(erroredTurn().slice(0, -1));
		expect(state.streaming).toBe(true);
		expect(retryableResponseId(state)).toBeUndefined();
	});

	it("returns undefined when an errored turn is not the most recent item", () => {
		// An errored turn followed by a later user message: retry only ever targets
		// the latest turn, never a stale error buried above newer activity.
		const state = run([...erroredTurn(), { type: "message_start", message: { role: "user", content: "moving on" } }]);
		expect(retryableResponseId(state)).toBeUndefined();
	});

	it("returns undefined when a host error stamped the last turn (dead RPC child)", () => {
		// A mid-turn RPC crash whose recovery gave up: host_error sets state.hostError
		// AND closeActiveResponse stamps the active group's `error`, so the last item
		// would otherwise qualify. Retrying a dead child only hits the disconnected
		// guard, so no Retry control is offered — the reopen banner owns this path.
		const state = run([
			{ type: "message_start", message: { role: "user", content: "do the thing" } },
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "host_error", message: "dreb process exited (code 1, signal null)" },
		]);
		const group = onlyResponse(state);
		expect(state.hostError).toBeTruthy();
		expect(group.error).toBeTruthy();
		expect(group.streaming).toBe(false);
		expect(retryableResponseId(state)).toBeUndefined();
	});
});
