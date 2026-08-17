import { describe, expect, it } from "vitest";
import { mergeComposerPrefill } from "../src/shared/composer-prefill.js";

describe("mergeComposerPrefill", () => {
	it("replace overwrites the current draft", () => {
		expect(mergeComposerPrefill("replace", "re-ask this", "half-typed thought")).toBe("re-ask this");
	});

	it("replace applies verbatim to an empty composer", () => {
		expect(mergeComposerPrefill("replace", "re-ask this", "")).toBe("re-ask this");
	});

	it("prepend inserts the restored text before an in-progress draft (nothing lost)", () => {
		expect(mergeComposerPrefill("prepend", "queued one\n\nqueued two", "my new thought")).toBe(
			"queued one\n\nqueued two\n\nmy new thought",
		);
	});

	it("prepend collapses to just the incoming text when the composer is empty", () => {
		expect(mergeComposerPrefill("prepend", "queued one", "")).toBe("queued one");
	});

	it("prepend treats a whitespace-only draft as empty (no spurious blank block)", () => {
		expect(mergeComposerPrefill("prepend", "queued one", "   \n  ")).toBe("queued one");
	});

	it("prepend preserves the draft's own internal/trailing whitespace when it has real content", () => {
		expect(mergeComposerPrefill("prepend", "queued", "  keep me  ")).toBe("queued\n\n  keep me  ");
	});
});
