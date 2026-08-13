/**
 * Pure parsing of unified `git diff` output into hunks, plus the small helpers
 * the change-review feature needs: reconstruct a single-hunk patch (so
 * `git apply --reverse` can undo exactly one hunk) and map an editor line to the
 * hunk that contains it (so "reject the hunk at my cursor" works).
 *
 * No `vscode`, no `node`, no git — this is string work, unit-tested in isolation
 * (`test/diff-hunks.test.ts`). The git process orchestration that produces the
 * diffs and applies the reverse patches lives in `git-snapshot.ts`.
 */

/** One hunk of a unified diff. `lines` includes the `@@` header and its body. */
export interface Hunk {
	/** The raw `@@ -a,b +c,d @@ …` header line. */
	header: string;
	/** 1-based start line of this hunk in the *new* (current) file. */
	newStart: number;
	/** Number of lines this hunk spans in the *new* file. */
	newLines: number;
	/** All raw lines of the hunk, header first, in original order. */
	lines: string[];
}

/** Parsed unified diff for a single file. */
export interface ParsedFileDiff {
	/** Header lines preceding the first hunk (`diff --git`, `index`, `---`, `+++`). */
	fileHeader: string[];
	hunks: Hunk[];
	/** True when git reported a binary difference (no textual hunks available). */
	binary: boolean;
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a single-file unified diff (the output of `git diff <a> <b> -- <path>`).
 * Returns the pre-hunk header lines, each hunk, and whether git reported the
 * file as binary. A trailing newline is ignored; blank input yields no hunks.
 */
export function parseFileDiff(diff: string): ParsedFileDiff {
	const all = diff.split("\n");
	// Drop a single trailing empty element from a final newline.
	if (all.length > 0 && all[all.length - 1] === "") all.pop();

	const binary = all.some((l) => l.startsWith("Binary files ") || l === "GIT binary patch");

	const fileHeader: string[] = [];
	const hunks: Hunk[] = [];
	let current: Hunk | undefined;

	for (const line of all) {
		const match = HUNK_RE.exec(line);
		if (match) {
			current = {
				header: line,
				newStart: Number(match[1]),
				newLines: match[2] === undefined ? 1 : Number(match[2]),
				lines: [line],
			};
			hunks.push(current);
			continue;
		}
		if (current) {
			current.lines.push(line);
		} else {
			fileHeader.push(line);
		}
	}

	return { fileHeader, hunks, binary: binary && hunks.length === 0 };
}

/**
 * Reconstruct a minimal, apply-able patch containing only the hunk at `index`
 * (file header + that one hunk). Feed this to `git apply --reverse` to undo a
 * single hunk. Returns undefined when the index is out of range.
 */
export function sliceHunkPatch(parsed: ParsedFileDiff, index: number): string | undefined {
	const hunk = parsed.hunks[index];
	if (!hunk) return undefined;
	return `${[...parsed.fileHeader, ...hunk.lines].join("\n")}\n`;
}

/**
 * Index of the hunk whose *new-file* line range contains `line` (1-based), or
 * undefined when no hunk covers it. A zero-length hunk (`newLines === 0`, a pure
 * deletion) matches the line at its `newStart` so a cursor parked there can
 * still reject it.
 */
export function hunkIndexForLine(hunks: readonly Hunk[], line: number): number | undefined {
	for (let i = 0; i < hunks.length; i++) {
		const h = hunks[i];
		const span = Math.max(h.newLines, 1);
		if (line >= h.newStart && line <= h.newStart + span - 1) return i;
	}
	return undefined;
}
