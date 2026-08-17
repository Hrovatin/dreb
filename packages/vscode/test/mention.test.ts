import { describe, expect, it } from "vitest";
import {
	activeMention,
	escapeGlob,
	isFullPickerTrigger,
	MENTION_RESULT_CAP,
	mentionReference,
	rankMentionResults,
	replaceMention,
} from "../src/shared/mention.js";
import type { FileContextDto, SymbolContextDto, TaggedContextDto } from "../src/shared/protocol.js";

const file = (path: string): FileContextDto => ({ kind: "file", path });
const folder = (path: string): FileContextDto => ({ kind: "file", path, isDirectory: true });
const symbol = (name: string, path: string, line = 1, symbolKind = "class"): SymbolContextDto => ({
	kind: "symbol",
	name,
	symbolKind,
	path,
	line,
});

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

	it("splices out a token with text on both sides", () => {
		const result = replaceMention("see @app here", { start: 4, end: 8 }, "");
		expect(result).toEqual({ text: "see  here", caret: 4 });
	});

	it("returns the caret after a non-empty replacement", () => {
		const result = replaceMention("see @app here", { start: 4, end: 8 }, "@app.ts");
		expect(result).toEqual({ text: "see @app.ts here", caret: 11 });
	});
});

describe("mentionReference", () => {
	it("prefixes the label with `@` and adds a trailing space", () => {
		expect(mentionReference("app.ts")).toBe("@app.ts ");
	});

	it("keeps a folder label's trailing slash", () => {
		expect(mentionReference("host/")).toBe("@host/ ");
	});

	it("composes with replaceMention to insert a reference at the token position", () => {
		// Selecting `src/app.ts` while `see @app` is typed swaps the `@app` token
		// for the inline `@app.ts ` reference, caret after the trailing space.
		const result = replaceMention("see @app", { start: 4, end: 8 }, mentionReference("app.ts"));
		expect(result).toEqual({ text: "see @app.ts ", caret: 12 });
	});
});

describe("rankMentionResults", () => {
	it("ranks filename prefix matches ahead of substring/path matches", () => {
		const results = [file("src/components/wrap.ts"), file("src/app.ts"), file("lib/mapper.ts")];
		const ranked = rankMentionResults(results, "app", 10);
		expect(ranked.map((r) => (r as FileContextDto).path)).toEqual(["src/app.ts", "lib/mapper.ts"]);
	});

	it("includes path substring matches after filename matches", () => {
		const results = [file("src/utils/x.ts"), file("app/y.ts")];
		const ranked = rankMentionResults(results, "app", 10);
		expect(ranked.map((r) => (r as FileContextDto).path)).toEqual(["app/y.ts"]);
	});

	it("drops non-matching entries", () => {
		const results = [file("src/a.ts"), file("src/b.ts")];
		expect(rankMentionResults(results, "zzz", 10)).toEqual([]);
	});

	it("groups by kind order — folders, then files, then symbols", () => {
		const results: TaggedContextDto[] = [
			symbol("AppRunner", "src/app.ts", 3, "class"),
			file("src/app.ts"),
			folder("src/app"),
		];
		const ranked = rankMentionResults(results, "app", 10);
		expect(ranked.map((r) => r.kind)).toEqual(["file", "file", "symbol"]);
		// The folder is a file-kind DTO flagged isDirectory; it must lead.
		expect(ranked[0]).toMatchObject({ kind: "file", isDirectory: true, path: "src/app" });
		expect(ranked[1]).toMatchObject({ kind: "file", path: "src/app.ts" });
		expect(ranked[2]).toMatchObject({ kind: "symbol", name: "AppRunner" });
	});

	it("matches a symbol on its name, not its path", () => {
		const results: TaggedContextDto[] = [symbol("handleClick", "src/ui/button.ts", 12, "function")];
		expect(rankMentionResults(results, "handle", 10)).toHaveLength(1);
		expect(rankMentionResults(results, "button", 10)).toHaveLength(1); // path substring
		expect(rankMentionResults(results, "zzz", 10)).toHaveLength(0);
	});

	it("keeps per-kind host order and just caps for an empty query", () => {
		const results: TaggedContextDto[] = [file("b.ts"), folder("z"), file("a.ts")];
		// Folder floats to the top (kind order); files keep host order (b before a).
		expect(rankMentionResults(results, "", 10)).toEqual([folder("z"), file("b.ts"), file("a.ts")]);
	});

	it("caps the result list", () => {
		const results = Array.from({ length: MENTION_RESULT_CAP + 5 }, (_, i) => file(`mod${i}.ts`));
		expect(rankMentionResults(results, "mod", MENTION_RESULT_CAP).length).toBe(MENTION_RESULT_CAP);
	});

	it("breaks ties by shorter path then alphabetically", () => {
		const results = [file("src/deep/app.ts"), file("app.ts"), file("lib/app.ts")];
		const ranked = rankMentionResults(results, "app", 10);
		expect(ranked.map((r) => (r as FileContextDto).path)).toEqual(["app.ts", "lib/app.ts", "src/deep/app.ts"]);
	});
});

describe("escapeGlob", () => {
	it("leaves plain alphanumerics untouched", () => {
		expect(escapeGlob("app")).toBe("app");
		expect(escapeGlob("App123")).toBe("App123");
	});

	it("escapes each glob metacharacter", () => {
		expect(escapeGlob("*")).toBe("\\*");
		expect(escapeGlob("?")).toBe("\\?");
		expect(escapeGlob("{")).toBe("\\{");
		expect(escapeGlob("}")).toBe("\\}");
		expect(escapeGlob("[")).toBe("\\[");
		expect(escapeGlob("]")).toBe("\\]");
		expect(escapeGlob("(")).toBe("\\(");
		expect(escapeGlob(")")).toBe("\\)");
		expect(escapeGlob("!")).toBe("\\!");
		expect(escapeGlob("+")).toBe("\\+");
		expect(escapeGlob("@")).toBe("\\@");
	});

	it("collapses forward and back slashes to a single wildcard", () => {
		expect(escapeGlob("src/app")).toBe("src*app");
		expect(escapeGlob("src\\app")).toBe("src*app");
		expect(escapeGlob("a/b/c")).toBe("a*b*c");
	});

	it("escapes a mixed query so the resulting include stays a literal match", () => {
		expect(escapeGlob("src/@types{x}")).toBe("src*\\@types\\{x\\}");
	});

	it("returns an empty string for an empty query", () => {
		expect(escapeGlob("")).toBe("");
	});
});
