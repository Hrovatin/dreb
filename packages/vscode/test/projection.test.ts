import { describe, expect, it } from "vitest";
import {
	activitySummary,
	alignCheckpoints,
	applyEvent,
	createTranscriptState,
	foldMessagesIntoState,
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
		expect(activitySummary(g)).toBe("1 thought · 1 tool call");
		const tool = g.activity.find((a) => a.kind === "tool");
		expect(tool).toMatchObject({ toolCallId: "t1", toolName: "read", status: "done", resultText: "file body" });
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
		const ok = g?.activity.find((a) => a.kind === "tool" && a.toolCallId === "ok");
		const pending = g?.activity.find((a) => a.kind === "tool" && a.toolCallId === "pending");
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
		expect(groups[1].activity).toEqual([]);
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
				id: i + 1,
				activity: [],
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
		state.items.push({ kind: "response", id: 1, activity: [], answer: "ok", streaming: false, collapsed: true });
		state.items.push({ kind: "response", id: 2, activity: [], answer: "", streaming: true, collapsed: false });
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
		state.items.push({ kind: "response", id: 1, activity: [], answer: "a", streaming: false, collapsed: true });
		state.items.push({
			kind: "response",
			id: 2,
			activity: [],
			answer: "",
			streaming: false,
			collapsed: true,
			error: "rate limited",
		});
		state.items.push({ kind: "response", id: 3, activity: [], answer: "c", streaming: false, collapsed: true });
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
