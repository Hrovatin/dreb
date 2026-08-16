import { describe, expect, it } from "vitest";
import {
	activeMention,
	isFullPickerTrigger,
	MENTION_RESULT_CAP,
	rankFileResults,
	replaceMention,
} from "../src/shared/mention.js";
import type { FileContextDto } from "../src/shared/protocol.js";

const file = (path: string): FileContextDto => ({ kind: "file", path });

describe("activeMention", () => {
	it("matches a lone `@` at the start of the text", () => {
		expect(activeMention("@", 1)).toEqual({ start: 0, end: 1, query: "" });
	});

	it("captures the query typed after `@`", () => {
		expect(activeMention("see @app", 8)).toEqual({ start: 4, end: 8, query: "app" });
	});

	it("matches `@` after a newline", () => {
		const text = "line one\n@src";
		expect(activeMention(text, text.length)).toEqual({ start: 9, end: 13, query: "src" });
	});

	it("does not fire for `@` embedded mid-word (e.g. an email)", () => {
		expect(activeMention("mail me@host now", 7)).toBeNull();
	});

	it("closes the token once the query contains a space", () => {
		expect(activeMention("@app ts", 7)).toBeNull();
	});

	it("rejects a query starting with a second `@` (that is the full-picker trigger)", () => {
		expect(activeMention("@@", 2)).toBeNull();
	});

	it("parses only up to the caret, ignoring text after it", () => {
		expect(activeMention("@app more", 4)).toEqual({ start: 0, end: 4, query: "app" });
	});
});

describe("isFullPickerTrigger", () => {
	it("is true for `@@` at the start of the text", () => {
		expect(isFullPickerTrigger("@@", 2)).toBe(true);
	});

	it("is true for `@@` after whitespace", () => {
		expect(isFullPickerTrigger("hi @@", 5)).toBe(true);
	});

	it("is false for a single `@`", () => {
		expect(isFullPickerTrigger("@", 1)).toBe(false);
	});

	it("is false for `@@` embedded mid-word", () => {
		expect(isFullPickerTrigger("a@@", 3)).toBe(false);
	});
});

describe("replaceMention", () => {
	it("strips the `@query` token when replacement is empty", () => {
		const result = replaceMention("see @app", { start: 4, end: 8 }, "");
		expect(result).toEqual({ text: "see ", caret: 4 });
	});

	it("preserves text after the caret", () => {
		const result = replaceMention("@app rest", { start: 0, end: 4 }, "");
		expect(result).toEqual({ text: " rest", caret: 0 });
	});
});

describe("rankFileResults", () => {
	it("ranks filename prefix matches ahead of substring/path matches", () => {
		const results = [file("src/components/wrap.ts"), file("src/app.ts"), file("lib/mapper.ts")];
		const ranked = rankFileResults(results, "app", 10);
		expect(ranked.map((r) => r.path)).toEqual(["src/app.ts", "lib/mapper.ts"]);
	});

	it("includes path substring matches after filename matches", () => {
		const results = [file("src/utils/x.ts"), file("app/y.ts")];
		const ranked = rankFileResults(results, "app", 10);
		expect(ranked.map((r) => r.path)).toEqual(["app/y.ts"]);
	});

	it("drops non-matching entries", () => {
		const results = [file("src/a.ts"), file("src/b.ts")];
		expect(rankFileResults(results, "zzz", 10)).toEqual([]);
	});

	it("keeps input order and just caps for an empty query", () => {
		const results = [file("b.ts"), file("a.ts"), file("c.ts")];
		expect(rankFileResults(results, "", 2)).toEqual([file("b.ts"), file("a.ts")]);
	});

	it("caps the result list", () => {
		const results = Array.from({ length: MENTION_RESULT_CAP + 5 }, (_, i) => file(`mod${i}.ts`));
		expect(rankFileResults(results, "mod", MENTION_RESULT_CAP).length).toBe(MENTION_RESULT_CAP);
	});

	it("breaks ties by shorter path then alphabetically", () => {
		const results = [file("src/deep/app.ts"), file("app.ts"), file("lib/app.ts")];
		const ranked = rankFileResults(results, "app", 10);
		expect(ranked.map((r) => r.path)).toEqual(["app.ts", "lib/app.ts", "src/deep/app.ts"]);
	});
});
