import { describe, expect, it } from "vitest";
import { hunkIndexForLine, parseFileDiff, sliceHunkPatch } from "../src/host/diff-hunks.js";

const TWO_HUNK_DIFF = `diff --git a/file.txt b/file.txt
index 1111111..2222222 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 line1
-line2
+CHANGED2
 line3
@@ -8,3 +8,4 @@
 line8
 line9
+INSERTED
 line10
`;

const NEW_FILE_DIFF = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+alpha
+beta
`;

const BINARY_DIFF = `diff --git a/img.png b/img.png
index 1111111..2222222 100644
Binary files a/img.png and b/img.png differ
`;

describe("parseFileDiff", () => {
	it("splits a multi-hunk diff into header + hunks", () => {
		const parsed = parseFileDiff(TWO_HUNK_DIFF);
		expect(parsed.binary).toBe(false);
		expect(parsed.hunks).toHaveLength(2);
		expect(parsed.fileHeader).toEqual([
			"diff --git a/file.txt b/file.txt",
			"index 1111111..2222222 100644",
			"--- a/file.txt",
			"+++ b/file.txt",
		]);
		// New-file line range comes from the `+c,d` side of the @@ header.
		expect(parsed.hunks[0]).toMatchObject({ newStart: 1, newLines: 3 });
		expect(parsed.hunks[1]).toMatchObject({ newStart: 8, newLines: 4 });
		expect(parsed.hunks[0].lines[0]).toBe("@@ -1,3 +1,3 @@");
	});

	it("parses a single-count hunk header (@@ -a +c @@) as one line", () => {
		const parsed = parseFileDiff(`--- a/x\n+++ b/x\n@@ -5 +5 @@\n-old\n+new\n`);
		expect(parsed.hunks).toHaveLength(1);
		expect(parsed.hunks[0]).toMatchObject({ newStart: 5, newLines: 1 });
	});

	it("treats a new file as a single whole-file hunk", () => {
		const parsed = parseFileDiff(NEW_FILE_DIFF);
		expect(parsed.hunks).toHaveLength(1);
		expect(parsed.hunks[0]).toMatchObject({ newStart: 1, newLines: 2 });
	});

	it("flags binary diffs and yields no hunks", () => {
		const parsed = parseFileDiff(BINARY_DIFF);
		expect(parsed.binary).toBe(true);
		expect(parsed.hunks).toHaveLength(0);
	});

	it("returns nothing for an empty diff", () => {
		const parsed = parseFileDiff("");
		expect(parsed.hunks).toHaveLength(0);
		expect(parsed.binary).toBe(false);
	});
});

describe("sliceHunkPatch", () => {
	it("reconstructs an apply-able patch with only the chosen hunk", () => {
		const parsed = parseFileDiff(TWO_HUNK_DIFF);
		const patch = sliceHunkPatch(parsed, 1);
		expect(patch).toBeDefined();
		// Header preserved; only the second hunk's body present.
		expect(patch).toContain("diff --git a/file.txt b/file.txt");
		expect(patch).toContain("@@ -8,3 +8,4 @@");
		expect(patch).toContain("+INSERTED");
		expect(patch).not.toContain("+CHANGED2");
		expect(patch?.endsWith("\n")).toBe(true);
	});

	it("returns undefined for an out-of-range index", () => {
		const parsed = parseFileDiff(TWO_HUNK_DIFF);
		expect(sliceHunkPatch(parsed, 5)).toBeUndefined();
	});
});

describe("hunkIndexForLine", () => {
	it("finds the hunk whose new-file range contains the line", () => {
		const { hunks } = parseFileDiff(TWO_HUNK_DIFF);
		expect(hunkIndexForLine(hunks, 2)).toBe(0); // within 1..3
		expect(hunkIndexForLine(hunks, 9)).toBe(1); // within 8..11
	});

	it("returns undefined when no hunk covers the line", () => {
		const { hunks } = parseFileDiff(TWO_HUNK_DIFF);
		expect(hunkIndexForLine(hunks, 5)).toBeUndefined();
	});

	it("matches a zero-length (pure-deletion) hunk at its start line", () => {
		const { hunks } = parseFileDiff(`--- a/x\n+++ b/x\n@@ -3,1 +3,0 @@\n-gone\n`);
		expect(hunkIndexForLine(hunks, 3)).toBe(0);
	});
});
