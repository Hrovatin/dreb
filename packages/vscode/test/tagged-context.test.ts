import { describe, expect, it } from "vitest";
import type { FileContextDto, SelectionContextDto } from "../src/shared/protocol.js";
import {
	buildFileContext,
	buildPromptWithContext,
	buildTaggedContext,
	formatTaggedContext,
	MAX_INLINE_SELECTION_CHARS,
	MAX_INLINE_SELECTION_LINES,
	taggedContextLabel,
	taggedContextTitle,
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
			kind: "selection",
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

describe("buildFileContext", () => {
	it("relativizes a file path and omits isDirectory for files", () => {
		const dto = buildFileContext({ fsPath: "/home/me/proj/src/app.ts", cwd: "/home/me/proj" });
		expect(dto).toEqual({ kind: "file", path: "src/app.ts" });
	});

	it("marks directories and tolerates a trailing slash on the folder path", () => {
		const dto = buildFileContext({ fsPath: "/home/me/proj/src/", cwd: "/home/me/proj", isDirectory: true });
		expect(dto).toEqual({ kind: "file", path: "src", isDirectory: true });
	});

	it("falls back to the basename outside the workspace", () => {
		const dto = buildFileContext({ fsPath: "/etc/hosts", cwd: "/home/me/proj" });
		expect(dto.path).toBe("hosts");
	});
});

describe("taggedContextLabel", () => {
	const base: SelectionContextDto = {
		kind: "selection",
		path: "src/a.ts",
		startLine: 5,
		endLine: 5,
		language: "typescript",
		text: "x",
	};

	it("shows basename:line for a single-line selection", () => {
		expect(taggedContextLabel(base)).toBe("a.ts:5");
	});

	it("shows basename:start-end for a multi-line selection", () => {
		expect(taggedContextLabel({ ...base, startLine: 5, endLine: 9 })).toBe("a.ts:5-9");
	});

	it("shows the basename for a file tag", () => {
		expect(taggedContextLabel({ kind: "file", path: "src/app.ts" })).toBe("app.ts");
	});

	it("shows a trailing slash for a folder tag", () => {
		expect(taggedContextLabel({ kind: "file", path: "src/host", isDirectory: true })).toBe("host/");
	});
});

describe("taggedContextTitle", () => {
	it("shows the full path + span for a selection", () => {
		expect(
			taggedContextTitle({
				kind: "selection",
				path: "src/a.ts",
				startLine: 5,
				endLine: 9,
				language: "ts",
				text: "x",
			}),
		).toBe("src/a.ts (lines 5-9)");
	});

	it("shows the path for a file and a (directory) note for a folder", () => {
		expect(taggedContextTitle({ kind: "file", path: "src/app.ts" })).toBe("src/app.ts");
		expect(taggedContextTitle({ kind: "file", path: "src/host", isDirectory: true })).toBe("src/host/ (directory)");
	});
});

describe("formatTaggedContext", () => {
	it("emits a located fenced block with the language for a small selection", () => {
		const out = formatTaggedContext({
			kind: "selection",
			path: "src/a.ts",
			startLine: 5,
			endLine: 7,
			language: "typescript",
			text: "const y = 2;",
		});
		expect(out).toBe("`src/a.ts` (lines 5-7):\n```typescript\nconst y = 2;\n```");
	});

	it("uses singular 'line' and an empty fence when language is blank", () => {
		const out = formatTaggedContext({
			kind: "selection",
			path: "a.txt",
			startLine: 3,
			endLine: 3,
			language: "",
			text: "hi",
		});
		expect(out).toBe("`a.txt` (line 3):\n```\nhi\n```");
	});

	it("degrades to a path + line-span reference when the selection exceeds the line limit", () => {
		const startLine = 1;
		const endLine = startLine + MAX_INLINE_SELECTION_LINES; // one line over the limit
		const text = Array.from({ length: endLine - startLine + 1 }, () => "x").join("\n");
		const out = formatTaggedContext({
			kind: "selection",
			path: "src/big.ts",
			startLine,
			endLine,
			language: "ts",
			text,
		});
		expect(out).toBe(`\`src/big.ts\` (lines ${startLine}-${endLine})`);
		expect(out).not.toContain("```");
	});

	it("degrades to a reference when the selection exceeds the char cap even within the line limit", () => {
		const text = "x".repeat(MAX_INLINE_SELECTION_CHARS + 1);
		const out = formatTaggedContext({
			kind: "selection",
			path: "min.js",
			startLine: 1,
			endLine: 1,
			language: "js",
			text,
		});
		expect(out).toBe("`min.js` (line 1)");
		expect(out).not.toContain("```");
	});

	it("emits a bare path reference for a file tag (never contents)", () => {
		expect(formatTaggedContext({ kind: "file", path: "src/app.ts" })).toBe("`src/app.ts`");
	});

	it("emits a directory reference for a folder tag", () => {
		expect(formatTaggedContext({ kind: "file", path: "src/host", isDirectory: true })).toBe(
			"`src/host/` (directory)",
		);
	});
});

describe("buildPromptWithContext", () => {
	const sel: SelectionContextDto = {
		kind: "selection",
		path: "a.ts",
		startLine: 1,
		endLine: 1,
		language: "ts",
		text: "A",
	};
	const file: FileContextDto = { kind: "file", path: "src/app.ts" };
	const dir: FileContextDto = { kind: "file", path: "src", isDirectory: true };

	it("returns the text unchanged when there are no attachments", () => {
		expect(buildPromptWithContext("hello", [])).toBe("hello");
		expect(buildPromptWithContext("hello", undefined)).toBe("hello");
	});

	it("prepends a single selection before the user text", () => {
		expect(buildPromptWithContext("explain this", [sel])).toBe("`a.ts` (line 1):\n```ts\nA\n```\n\nexplain this");
	});

	it("folds mixed selection + file + folder tags then the text", () => {
		const out = buildPromptWithContext("compare", [sel, file, dir]);
		expect(out).toBe("`a.ts` (line 1):\n```ts\nA\n```\n\n`src/app.ts`\n\n`src/` (directory)\n\ncompare");
	});

	it("returns just the blocks when the text is empty", () => {
		expect(buildPromptWithContext("   ", [file])).toBe("`src/app.ts`");
	});
});
