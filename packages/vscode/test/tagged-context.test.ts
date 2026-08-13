import { describe, expect, it } from "vitest";
import type { TaggedContextDto } from "../src/shared/protocol.js";
import {
	buildPromptWithContext,
	buildTaggedContext,
	formatTaggedContext,
	taggedContextLabel,
} from "../src/shared/tagged-context.js";

describe("buildTaggedContext", () => {
	it("relativizes an in-workspace path with forward slashes", () => {
		const dto = buildTaggedContext({
			fsPath: "/home/me/proj/src/app.ts",
			cwd: "/home/me/proj",
			startLine: 10,
			endLine: 12,
			language: "typescript",
			text: "const x = 1;",
		});
		expect(dto).toEqual({
			path: "src/app.ts",
			startLine: 10,
			endLine: 12,
			language: "typescript",
			text: "const x = 1;",
		});
	});

	it("tolerates a trailing slash on cwd and backslash paths", () => {
		const dto = buildTaggedContext({
			fsPath: "C:\\work\\proj\\src\\a.ts",
			cwd: "C:\\work\\proj\\",
			startLine: 1,
			endLine: 1,
			language: "typescript",
			text: "x",
		});
		expect(dto.path).toBe("src/a.ts");
	});

	it("falls back to the basename for a file outside the workspace", () => {
		const dto = buildTaggedContext({
			fsPath: "/etc/hosts",
			cwd: "/home/me/proj",
			startLine: 3,
			endLine: 3,
			language: "plaintext",
			text: "127.0.0.1",
		});
		expect(dto.path).toBe("hosts");
	});

	it("labels the workspace root file itself by basename", () => {
		const dto = buildTaggedContext({
			fsPath: "/home/me/proj",
			cwd: "/home/me/proj",
			startLine: 1,
			endLine: 1,
			language: "",
			text: "",
		});
		expect(dto.path).toBe("proj");
	});
});

describe("taggedContextLabel", () => {
	const base: TaggedContextDto = { path: "src/a.ts", startLine: 5, endLine: 5, language: "typescript", text: "x" };

	it("shows basename:line for a single-line selection", () => {
		expect(taggedContextLabel(base)).toBe("a.ts:5");
	});

	it("shows basename:start-end for a multi-line selection", () => {
		expect(taggedContextLabel({ ...base, startLine: 5, endLine: 9 })).toBe("a.ts:5-9");
	});
});

describe("formatTaggedContext", () => {
	it("emits a located fenced block with the language", () => {
		const out = formatTaggedContext({
			path: "src/a.ts",
			startLine: 5,
			endLine: 7,
			language: "typescript",
			text: "const y = 2;",
		});
		expect(out).toBe("`src/a.ts` (lines 5-7):\n```typescript\nconst y = 2;\n```");
	});

	it("uses singular 'line' and an empty fence when language is blank", () => {
		const out = formatTaggedContext({ path: "a.txt", startLine: 3, endLine: 3, language: "", text: "hi" });
		expect(out).toBe("`a.txt` (line 3):\n```\nhi\n```");
	});
});

describe("buildPromptWithContext", () => {
	const a: TaggedContextDto = { path: "a.ts", startLine: 1, endLine: 1, language: "ts", text: "A" };
	const b: TaggedContextDto = { path: "b.ts", startLine: 2, endLine: 3, language: "ts", text: "B" };

	it("returns the text unchanged when there are no attachments", () => {
		expect(buildPromptWithContext("hello", [])).toBe("hello");
		expect(buildPromptWithContext("hello", undefined)).toBe("hello");
	});

	it("prepends a single attachment before the user text", () => {
		expect(buildPromptWithContext("explain this", [a])).toBe("`a.ts` (line 1):\n```ts\nA\n```\n\nexplain this");
	});

	it("joins multiple attachments then the text", () => {
		const out = buildPromptWithContext("compare", [a, b]);
		expect(out).toBe("`a.ts` (line 1):\n```ts\nA\n```\n\n`b.ts` (lines 2-3):\n```ts\nB\n```\n\ncompare");
	});

	it("returns just the blocks when the text is empty", () => {
		expect(buildPromptWithContext("   ", [a])).toBe("`a.ts` (line 1):\n```ts\nA\n```");
	});
});
