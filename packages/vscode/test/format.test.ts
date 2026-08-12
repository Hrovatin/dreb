import { describe, expect, it } from "vitest";
import {
	formatContextUsage,
	formatCost,
	formatModel,
	formatPercent,
	formatSessionStats,
	formatThinking,
} from "../src/shared/format.js";

describe("format", () => {
	describe("formatModel", () => {
		it("prefers name, falls back to id, then a dash", () => {
			expect(formatModel({ provider: "anthropic", id: "claude", name: "Claude" })).toBe("Claude");
			expect(formatModel({ provider: "anthropic", id: "claude" })).toBe("claude");
			expect(formatModel({ provider: "x", id: "y", name: "" })).toBe("y");
			expect(formatModel(undefined)).toBe("—");
		});
	});

	describe("formatThinking", () => {
		it("shows the level or a dash", () => {
			expect(formatThinking("high")).toBe("high");
			expect(formatThinking(undefined)).toBe("—");
			expect(formatThinking("")).toBe("—");
		});
	});

	describe("formatCost", () => {
		it("returns undefined when there is nothing to show", () => {
			expect(formatCost(undefined)).toBeUndefined();
			expect(formatCost({ session: 0, usingSubscription: false })).toBeUndefined();
		});

		it("formats session cost with 3 decimals", () => {
			expect(formatCost({ session: 0.1234, usingSubscription: false })).toBe("$0.123");
		});

		it("marks subscription and appends a larger daily total", () => {
			expect(formatCost({ session: 0, usingSubscription: true })).toBe("$0.000 (sub)");
			expect(formatCost({ session: 0.12, daily: 1.5, usingSubscription: false })).toBe("$0.120, today $1.50");
		});

		it("omits daily when it is not larger than the session cost", () => {
			expect(formatCost({ session: 2, daily: 1, usingSubscription: false })).toBe("$2.000");
		});
	});

	describe("formatPercent", () => {
		it("rounds, or shows ? when unknown", () => {
			expect(formatPercent(42.6)).toBe("43%");
			expect(formatPercent(null)).toBe("?");
		});
	});

	describe("formatContextUsage", () => {
		it("renders a ctx chip or undefined", () => {
			expect(formatContextUsage(undefined)).toBeUndefined();
			expect(formatContextUsage({ tokens: 100, contextWindow: 1000, percent: 10 })).toBe("ctx 10%");
			expect(formatContextUsage({ tokens: null, contextWindow: 1000, percent: null })).toBe("ctx ?");
		});
	});

	describe("formatSessionStats", () => {
		it("summarizes messages, tokens, cost, and context", () => {
			const text = formatSessionStats({
				sessionId: "abc",
				userMessages: 3,
				assistantMessages: 4,
				toolCalls: 5,
				totalMessages: 7,
				tokens: { input: 100, output: 200, total: 300 },
				cost: 0.5,
				contextUsage: { tokens: 300, contextWindow: 1000, percent: 30 },
			});
			expect(text).toContain("id: abc");
			expect(text).toContain("messages: 7 (user 3, assistant 4)");
			expect(text).toContain("tool calls: 5");
			expect(text).toContain("tokens: 300 (in 100, out 200)");
			expect(text).toContain("cost: $0.5000");
			expect(text).toContain("context: 30%");
		});

		it("tolerates a minimal stats object", () => {
			const text = formatSessionStats({});
			expect(text).toContain("Session stats");
			expect(text).toContain("messages: 0 (user 0, assistant 0)");
		});
	});
});
