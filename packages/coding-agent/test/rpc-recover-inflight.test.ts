import { afterEach, describe, expect, it } from "vitest";
import { recoverInflightReplyForRpc } from "../src/modes/rpc/rpc-mode.js";
import { createTestSession } from "./utilities.js";

const contexts: Array<{ cleanup: () => void }> = [];

afterEach(() => {
	while (contexts.length > 0) contexts.pop()!.cleanup();
});

function newSession() {
	const ctx = createTestSession();
	contexts.push(ctx);
	return ctx;
}

function persistedAssistants(sessionManager: {
	buildSessionContext(): { messages: Array<{ role: string }> };
}): Array<{ role: string; content: unknown; stopReason?: string }> {
	return sessionManager.buildSessionContext().messages.filter((m) => m.role === "assistant") as Array<{
		role: string;
		content: unknown;
		stopReason?: string;
	}>;
}

describe("recoverInflightReplyForRpc / AgentSession.recoverInflightReply", () => {
	it("persists a recovered reply as an interrupted assistant message", () => {
		const { session, sessionManager } = newSession();
		const before = sessionManager.getLeafId();

		const recovered = recoverInflightReplyForRpc(session, "half a reply");

		expect(recovered).toBe(true);
		const assistants = persistedAssistants(sessionManager);
		expect(assistants).toHaveLength(1);
		expect(assistants[0].stopReason).toBe("aborted");
		expect(assistants[0].content).toEqual([{ type: "text", text: "half a reply" }]);
		// Advances the leaf so the next user turn threads from the recovered reply.
		expect(sessionManager.getLeafId()).not.toBe(before);
	});

	it("re-syncs the in-memory agent context so get_messages reflects it", () => {
		const { session } = newSession();

		recoverInflightReplyForRpc(session, "recovered text");

		// session.messages is what the RPC get_messages / host rebuild reads; it
		// must include the recovered reply immediately (not only after a reload).
		const assistant = session.messages.find((m) => m.role === "assistant") as { content: unknown } | undefined;
		expect(assistant?.content).toEqual([{ type: "text", text: "recovered text" }]);
	});

	it("is a no-op for empty or whitespace-only text (no ghost reply)", () => {
		const { session, sessionManager } = newSession();
		const before = sessionManager.getLeafId();

		expect(recoverInflightReplyForRpc(session, "")).toBe(false);
		expect(recoverInflightReplyForRpc(session, "   \n\t ")).toBe(false);

		expect(persistedAssistants(sessionManager)).toHaveLength(0);
		expect(sessionManager.getLeafId()).toBe(before);
	});

	it("does not append while a turn is streaming", () => {
		const { session, sessionManager } = newSession();
		Object.defineProperty(session, "isStreaming", { get: () => true, configurable: true });

		expect(recoverInflightReplyForRpc(session, "should not persist")).toBe(false);
		expect(persistedAssistants(sessionManager)).toHaveLength(0);
	});

	it("preserves the exact streamed text including internal whitespace", () => {
		const { session, sessionManager } = newSession();
		const text = "line one\n\nline two with trailing spaces   ";

		expect(recoverInflightReplyForRpc(session, text)).toBe(true);
		expect(persistedAssistants(sessionManager)[0].content).toEqual([{ type: "text", text }]);
	});

	it("records the session's model and a best-effort usage estimate on the recovered message", () => {
		const { session, sessionManager } = newSession();
		const text = "a recovered reply of some length";

		expect(recoverInflightReplyForRpc(session, text)).toBe(true);

		const msg = persistedAssistants(sessionManager)[0] as unknown as {
			provider?: string;
			model?: string;
			usage?: { input: number; output: number; totalTokens: number; cost: { total: number } };
		};
		// The session's configured model, not "unknown" — so downstream same-model
		// logic (e.g. compaction checks) treats the recovered reply correctly.
		expect(msg.provider).toBe(session.model?.provider);
		expect(msg.model).toBe(session.model?.id);
		// Usage is estimated from text length (ceil(length / 4)) so the pre-send
		// compaction check doesn't treat the recovered reply as free; input is zero
		// and cost is not fabricated. Pin the exact formula so a divisor/rounding
		// regression is caught, not just any positive number.
		const expectedOutput = Math.ceil(text.length / 4);
		expect(msg.usage?.output).toBe(expectedOutput);
		expect(msg.usage?.totalTokens).toBe(expectedOutput);
		expect(msg.usage?.input).toBe(0);
		expect(msg.usage?.cost.total).toBe(0);

		// The estimate must NOT leak into session token totals (it has zero cost, so
		// counting it would inflate tokens against an unchanged cost). getSessionStats
		// excludes aborted turns entirely.
		const stats = session.getSessionStats();
		expect(stats.tokens.output).toBe(0);
		expect(stats.tokens.total).toBe(0);
		expect(stats.cost).toBe(0);
	});
});
