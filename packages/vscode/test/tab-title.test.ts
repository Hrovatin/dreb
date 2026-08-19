import { describe, expect, it } from "vitest";
import { formatTabTitle } from "../src/shared/tab-title.js";

describe("formatTabTitle", () => {
	it("prefixes the session name with `D: `", () => {
		expect(formatTabTitle("Fix auth", "idle")).toBe("D: Fix auth");
	});

	it("falls back to `New session` for an empty/undefined title", () => {
		expect(formatTabTitle(undefined, "idle")).toBe("D: New session");
		expect(formatTabTitle("", "idle")).toBe("D: New session");
		expect(formatTabTitle("   ", "idle")).toBe("D: New session");
	});

	it("appends a compact marker for each non-idle run state", () => {
		expect(formatTabTitle("Task", "running")).toBe("D: Task ●");
		expect(formatTabTitle("Task", "needs-input")).toBe("D: Task ⚠");
		expect(formatTabTitle("Task", "idle")).toBe("D: Task");
	});

	it("collapses internal whitespace/newlines from a multi-line first message", () => {
		expect(formatTabTitle("hello\n  world\ttab", "idle")).toBe("D: hello world tab");
	});

	it("truncates a long name to maxLen with an ellipsis", () => {
		// maxLen 5 → keep 4 chars + ellipsis.
		expect(formatTabTitle("abcdefghij", "idle", 5)).toBe("D: abcd…");
	});

	it("does not truncate a name at exactly maxLen", () => {
		expect(formatTabTitle("abcde", "idle", 5)).toBe("D: abcde");
	});

	it("trims trailing space before the ellipsis when the cut lands after a space", () => {
		// maxLen 4 → slice(0, 3) = "ab " → trimmed to "ab" before the ellipsis.
		expect(formatTabTitle("ab cdefgh", "idle", 4)).toBe("D: ab…");
	});

	it("keeps the run-state marker even when the name is truncated", () => {
		expect(formatTabTitle("abcdefghij", "running", 5)).toBe("D: abcd… ●");
	});
});
