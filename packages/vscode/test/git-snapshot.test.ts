/**
 * Real-git integration tests for the change-review snapshot engine. Each test
 * runs against a throwaway temp repo (mirroring `coding-agent`'s
 * `git-update.test.ts`), exercising the actual git plumbing: temp-index tree
 * capture, tree-to-tree change detection, and `git apply --reverse` per hunk.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	baselineContent,
	captureTree,
	changedFiles,
	fileDiff,
	isGitRepo,
	revertFile,
	revertHunk,
} from "../src/host/git-snapshot.js";

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
	return result.stdout.trim();
}

function initRepo(dir: string): void {
	git(["init", "--initial-branch=main"], dir);
	git(["config", "--local", "user.email", "t@t.com"], dir);
	git(["config", "--local", "user.name", "Test"], dir);
	git(["config", "--local", "commit.gpgsign", "false"], dir);
}

/** A deterministic 20-line file body; edit specific lines to force hunks. */
function lines(n = 20): string[] {
	return Array.from({ length: n }, (_, i) => `line${i + 1}`);
}

function write(dir: string, name: string, body: string[]): void {
	writeFileSync(join(dir, name), `${body.join("\n")}\n`);
}

function read(dir: string, name: string): string[] {
	return readFileSync(join(dir, name), "utf-8").replace(/\n$/, "").split("\n");
}

describe("git-snapshot", () => {
	let repo: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "dreb-snap-"));
		initRepo(repo);
		write(repo, "file.txt", lines());
		git(["add", "file.txt"], repo);
		git(["commit", "-m", "init"], repo);
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("detects a git repo and rejects a non-repo dir", () => {
		expect(isGitRepo(repo)).toBe(true);
		const plain = mkdtempSync(join(tmpdir(), "dreb-plain-"));
		try {
			expect(isGitRepo(plain)).toBe(false);
			expect(captureTree(plain)).toBeNull();
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});

	it("captureTree does not touch the user's real index", () => {
		const before = git(["status", "--porcelain"], repo);
		expect(captureTree(repo)).toMatch(/^[0-9a-f]{40}$/);
		expect(git(["status", "--porcelain"], repo)).toBe(before);
		expect(git(["diff", "--cached", "--name-only"], repo)).toBe("");
	});

	it("lists a modified file with its hunk count", () => {
		const base = captureTree(repo);
		expect(base).not.toBeNull();
		const body = lines();
		body[2] = "AGENT3";
		write(repo, "file.txt", body);
		const changed = changedFiles(repo, base as string);
		expect(changed).toEqual([{ path: "file.txt", status: "modified", hunkCount: 1 }]);
	});

	it("classifies added and deleted files", () => {
		const base = captureTree(repo) as string;
		write(repo, "created.txt", ["hello"]);
		rmSync(join(repo, "file.txt"));
		const changed = changedFiles(repo, base).sort((a, b) => a.path.localeCompare(b.path));
		expect(changed.map((c) => ({ path: c.path, status: c.status }))).toEqual([
			{ path: "created.txt", status: "added" },
			{ path: "file.txt", status: "deleted" },
		]);
	});

	it("baselineContent returns baseline text, null for a newly-created file", () => {
		const base = captureTree(repo) as string;
		write(repo, "created.txt", ["new"]);
		expect(baselineContent(repo, base, "file.txt")).toBe(`${lines().join("\n")}\n`);
		expect(baselineContent(repo, base, "created.txt")).toBeNull();
	});

	it("reverts exactly one hunk, leaving the other agent change intact", () => {
		const base = captureTree(repo) as string;
		const body = lines();
		body[2] = "AGENT3"; // hunk near line 3
		body[15] = "AGENT16"; // hunk near line 16 (well separated → two hunks)
		write(repo, "file.txt", body);

		const { diff } = fileDiff(repo, base, "file.txt");
		expect(diff).toContain("AGENT3");
		expect(diff).toContain("AGENT16");

		// Reject the first hunk only.
		expect(revertHunk(repo, base, "file.txt", 0)).toBe(true);
		const after = read(repo, "file.txt");
		expect(after[2]).toBe("line3"); // first change reverted
		expect(after[15]).toBe("AGENT16"); // second change preserved
	});

	it("does NOT clobber the user's pre-existing dirty edit when reverting an agent hunk", () => {
		// User edits line 3 and leaves it uncommitted…
		const userBody = lines();
		userBody[2] = "USER3";
		write(repo, "file.txt", userBody);

		// …baseline is captured AFTER the user's edit, so it includes USER3.
		const base = captureTree(repo) as string;

		// Agent then edits a far-away line.
		const agentBody = [...userBody];
		agentBody[15] = "AGENT16";
		write(repo, "file.txt", agentBody);

		// The diff is only the agent's change (USER3 is in the baseline).
		const { diff } = fileDiff(repo, base, "file.txt");
		expect(diff).toContain("AGENT16");
		expect(diff).not.toContain("USER3");

		// Rejecting the agent hunk restores line 16 but preserves the user's USER3.
		expect(revertHunk(repo, base, "file.txt", 0)).toBe(true);
		const after = read(repo, "file.txt");
		expect(after[2]).toBe("USER3");
		expect(after[15]).toBe("line16");
	});

	it("revertFile restores a modified file and deletes a newly-created one", () => {
		const base = captureTree(repo) as string;
		const body = lines();
		body[4] = "AGENT5";
		write(repo, "file.txt", body);
		write(repo, "created.txt", ["remove me"]);

		expect(revertFile(repo, base, "file.txt")).toBe(true);
		expect(read(repo, "file.txt")).toEqual(lines());

		expect(revertFile(repo, base, "created.txt")).toBe(true);
		expect(existsSync(join(repo, "created.txt"))).toBe(false);
	});

	it("does not garble the changed set when a file is renamed (rename detection off)", () => {
		// A second tracked file so any pair-wise desync from a 3-token rename
		// record would corrupt this entry too.
		write(repo, "other.txt", ["keep1", "keep2", "keep3"]);
		git(["add", "other.txt"], repo);
		git(["commit", "-m", "add other"], repo);

		const base = captureTree(repo) as string;
		// Rename file.txt → renamed.txt (content-identical → git would call it a
		// rename with detection on) and independently modify other.txt.
		renameSync(join(repo, "file.txt"), join(repo, "renamed.txt"));
		write(repo, "other.txt", ["keep1", "CHANGED", "keep3"]);

		const changed = changedFiles(repo, base).sort((a, b) => a.path.localeCompare(b.path));
		// With --no-renames the rename degrades to a clean delete + add, and the
		// unrelated modification is parsed correctly (no status/path swap).
		expect(changed).toEqual([
			{ path: "file.txt", status: "deleted", hunkCount: expect.any(Number) },
			{ path: "other.txt", status: "modified", hunkCount: 1 },
			{ path: "renamed.txt", status: "added", hunkCount: expect.any(Number) },
		]);
	});

	it("works when cwd is a subdirectory of the repo (paths stay repo-root-relative)", () => {
		mkdirSync(join(repo, "sub"), { recursive: true });
		write(repo, "sub/nested.txt", lines());
		git(["add", "sub/nested.txt"], repo);
		git(["commit", "-m", "add nested"], repo);

		const sub = join(repo, "sub");
		expect(isGitRepo(sub)).toBe(true);
		const base = captureTree(sub) as string;
		expect(base).not.toBeNull();

		const body = lines();
		body[2] = "AGENT3";
		write(repo, "sub/nested.txt", body);

		// Changed-file paths are repo-root-relative even though cwd is the subdir.
		const changed = changedFiles(sub, base);
		expect(changed).toEqual([{ path: "sub/nested.txt", status: "modified", hunkCount: 1 }]);

		// fileDiff, baselineContent, and revertFile all resolve against the repo
		// root — not the subdir — so they operate on the real file.
		expect(fileDiff(sub, base, "sub/nested.txt").diff).toContain("AGENT3");
		expect(baselineContent(sub, base, "sub/nested.txt")).toBe(`${lines().join("\n")}\n`);
		expect(revertFile(sub, base, "sub/nested.txt")).toBe(true);
		expect(read(repo, "sub/nested.txt")).toEqual(lines());
	});

	it("revertHunk reverts a subdir file's hunk when cwd is that subdir", () => {
		mkdirSync(join(repo, "sub"), { recursive: true });
		write(repo, "sub/nested.txt", lines());
		git(["add", "sub/nested.txt"], repo);
		git(["commit", "-m", "add nested"], repo);

		const sub = join(repo, "sub");
		const base = captureTree(sub) as string;
		const body = lines();
		body[2] = "AGENT3";
		body[15] = "AGENT16";
		write(repo, "sub/nested.txt", body);

		expect(revertHunk(sub, base, "sub/nested.txt", 0)).toBe(true);
		const after = read(repo, "sub/nested.txt");
		expect(after[2]).toBe("line3"); // first hunk reverted
		expect(after[15]).toBe("AGENT16"); // second preserved
	});

	it("revertFile refuses (returns false) and leaves the file untouched on a bad baseline ref", () => {
		// A failed baseline read must never be mistaken for "absent from baseline"
		// and trigger a destructive delete.
		const body = lines();
		body[4] = "AGENT5";
		write(repo, "file.txt", body);
		const bogusTree = "0000000000000000000000000000000000000000";

		expect(revertFile(repo, bogusTree, "file.txt")).toBe(false);
		// The working file is left exactly as it was (NOT deleted, NOT truncated).
		expect(read(repo, "file.txt")).toEqual(body);
		expect(existsSync(join(repo, "file.txt"))).toBe(true);
		// baselineContent likewise reports null (not "") on a genuine read error.
		expect(baselineContent(repo, bogusTree, "file.txt")).toBeNull();
	});

	it("revertFile does not write through a symlink to a file outside the repo", () => {
		const base = captureTree(repo) as string;
		// A file outside the repo whose content must never be touched by a revert.
		const outsideDir = mkdtempSync(join(tmpdir(), "dreb-outside-"));
		const outside = join(outsideDir, "victim.txt");
		writeFileSync(outside, "OUTSIDE-DATA");
		try {
			// The agent's turn replaced the tracked file with a symlink to that
			// outside file (surfaces as a type change → "modified" in the review set).
			rmSync(join(repo, "file.txt"));
			symlinkSync(outside, join(repo, "file.txt"));

			expect(revertFile(repo, base, "file.txt")).toBe(true);
			// The tracked path is restored as a REGULAR file with baseline content…
			expect(lstatSync(join(repo, "file.txt")).isSymbolicLink()).toBe(false);
			expect(read(repo, "file.txt")).toEqual(lines());
			// …and the outside file was NOT clobbered by writing through the link.
			expect(readFileSync(outside, "utf-8")).toBe("OUTSIDE-DATA");
		} finally {
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	it("does not truncate a hard link's shared inode outside the repo", () => {
		const base = captureTree(repo) as string;
		const outsideDir = mkdtempSync(join(tmpdir(), "dreb-outside-"));
		const outside = join(outsideDir, "victim.txt");
		writeFileSync(outside, "OUTSIDE-DATA");
		try {
			// The agent's turn replaced the tracked file with a HARD LINK to that
			// outside file. lstat reports it as a regular file (isFile() === true),
			// so an in-place `writeFileSync` would truncate the shared inode and
			// corrupt the outside file.
			rmSync(join(repo, "file.txt"));
			linkSync(outside, join(repo, "file.txt"));
			expect(lstatSync(join(repo, "file.txt")).nlink).toBe(2);

			expect(revertFile(repo, base, "file.txt")).toBe(true);
			// The tracked path is a fresh, unshared regular file with baseline content…
			expect(read(repo, "file.txt")).toEqual(lines());
			expect(lstatSync(join(repo, "file.txt")).nlink).toBe(1);
			// …and the outside file it used to share an inode with is untouched.
			expect(readFileSync(outside, "utf-8")).toBe("OUTSIDE-DATA");
		} finally {
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	it("preserves the mode bits (e.g. the exec bit) when reverting an ordinary file", () => {
		const script = join(repo, "script.sh");
		writeFileSync(script, "#!/bin/sh\necho hi\n");
		chmodSync(script, 0o755);
		git(["add", "script.sh"], repo);
		git(["commit", "-m", "add script"], repo);
		const base = captureTree(repo) as string;
		// The agent edited only the script's content; the working-tree mode is
		// unchanged (755) and the entry is an ordinary single-link regular file.
		writeFileSync(script, "#!/bin/sh\necho AGENT\n");
		expect(lstatSync(script).mode & 0o777).toBe(0o755);

		expect(revertFile(repo, base, "script.sh")).toBe(true);
		// Content is restored AND the exec bit is not silently stripped: an
		// ordinary file must be overwritten in place, not unlinked-then-recreated
		// (which would reset the mode to the umask default).
		expect(readFileSync(script, "utf-8")).toBe("#!/bin/sh\necho hi\n");
		expect(lstatSync(script).mode & 0o777).toBe(0o755);
	});

	it("revertFile removes a dangling symlink when reverting an agent-created path", () => {
		const base = captureTree(repo) as string;
		// The agent created `link.txt` (absent from baseline) as a broken symlink.
		// `existsSync` follows symlinks and would report a broken link as absent,
		// skipping cleanup; the lstat-based check must still remove it.
		symlinkSync(join(repo, "no-such-target"), join(repo, "link.txt"));
		expect(lstatSync(join(repo, "link.txt")).isSymbolicLink()).toBe(true);

		expect(revertFile(repo, base, "link.txt")).toBe(true);
		// The dangling link is gone from disk (lstat throws ENOENT).
		expect(() => lstatSync(join(repo, "link.txt"))).toThrow();
	});
});

/**
 * Issue 57 regression: the baseline snapshot must mirror the on-disk file
 * byte-for-byte, bypassing git's clean/EOL/attribute normalization. Otherwise a
 * CRLF working file under `text=auto`/`core.autocrlf`/`eol=…` is stored as LF,
 * so the served baseline mismatches the working file on EVERY line and a
 * one-line edit renders as a whole-file rewrite.
 */
describe("git-snapshot — raw-bytes baseline (EOL normalization, issue 57)", () => {
	let repo: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "dreb-eol-"));
		initRepo(repo);
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	/** Join lines with CRLF terminators (including a trailing CRLF). */
	const crlf = (ls: string[]): string => ls.map((l) => `${l}\r\n`).join("");

	function commitAll(dir: string, msg: string): void {
		git(["add", "-A"], dir);
		git(["commit", "-m", msg], dir);
	}

	it("serves a CRLF baseline byte-for-byte under `* text=auto` (not normalized to LF)", () => {
		writeFileSync(join(repo, ".gitattributes"), "* text=auto\n");
		const before = crlf(["line1", "line2", "line3", "line4"]);
		writeFileSync(join(repo, "file.txt"), before);
		commitAll(repo, "init crlf");

		const base = captureTree(repo) as string;
		expect(base).not.toBeNull();
		// The served baseline is the exact on-disk bytes — CRLF preserved — so the
		// diff editor's left side matches the working file instead of differing on
		// every line (the whole-file "recreated" symptom).
		expect(baselineContent(repo, base, "file.txt")).toBe(before);
		expect(baselineContent(repo, base, "file.txt")).toContain("\r\n");
	});

	it("shows a single-line CRLF edit as one modified hunk, not a whole-file rewrite", () => {
		writeFileSync(join(repo, ".gitattributes"), "* text=auto\n");
		const before = crlf(["line1", "line2", "line3", "line4"]);
		writeFileSync(join(repo, "file.txt"), before);
		commitAll(repo, "init");

		const base = captureTree(repo) as string;
		// Agent edits ONE line, preserving the file's CRLF endings.
		writeFileSync(join(repo, "file.txt"), crlf(["line1", "AGENT", "line3", "line4"]));

		// Classified as a modified single-hunk change (NOT added/recreated).
		expect(changedFiles(repo, base)).toEqual([{ path: "file.txt", status: "modified", hunkCount: 1 }]);
		// The baseline still matches the PRE-edit file byte-for-byte, so unchanged
		// lines (line1/line3/line4) read as unchanged in the editor.
		expect(baselineContent(repo, base, "file.txt")).toBe(before);
	});

	it("preserves CRLF under core.autocrlf=true", () => {
		git(["config", "--local", "core.autocrlf", "true"], repo);
		const before = crlf(["a", "b", "c"]);
		writeFileSync(join(repo, "file.txt"), before);
		commitAll(repo, "init");

		const base = captureTree(repo) as string;
		expect(baselineContent(repo, base, "file.txt")).toBe(before);
	});

	it("preserves CRLF under an explicit `eol=crlf` attribute", () => {
		writeFileSync(join(repo, ".gitattributes"), "*.txt text eol=crlf\n");
		const before = crlf(["a", "b", "c"]);
		writeFileSync(join(repo, "file.txt"), before);
		commitAll(repo, "init");

		const base = captureTree(repo) as string;
		expect(baselineContent(repo, base, "file.txt")).toBe(before);
	});

	it("revertFile restores exact CRLF bytes after a normalizing edit", () => {
		writeFileSync(join(repo, ".gitattributes"), "* text=auto\n");
		const before = crlf(["line1", "line2", "line3"]);
		writeFileSync(join(repo, "file.txt"), before);
		commitAll(repo, "init");

		const base = captureTree(repo) as string;
		writeFileSync(join(repo, "file.txt"), crlf(["line1", "AGENT", "line3"]));
		expect(revertFile(repo, base, "file.txt")).toBe(true);
		// The whole file, including its CRLF endings, is restored byte-for-byte.
		expect(readFileSync(join(repo, "file.txt"), "utf-8")).toBe(before);
	});

	it("revertHunk reverses one CRLF hunk while leaving another intact", () => {
		writeFileSync(join(repo, ".gitattributes"), "* text=auto\n");
		const original = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
		writeFileSync(join(repo, "file.txt"), crlf(original));
		commitAll(repo, "init");

		const base = captureTree(repo) as string;
		const body = [...original];
		body[2] = "AGENT3"; // hunk near line 3
		body[15] = "AGENT16"; // well-separated second hunk
		writeFileSync(join(repo, "file.txt"), crlf(body));

		expect(revertHunk(repo, base, "file.txt", 0)).toBe(true);
		const after = readFileSync(join(repo, "file.txt"), "utf-8").split("\r\n");
		expect(after[2]).toBe("line3"); // first hunk reverted against a CRLF baseline
		expect(after[15]).toBe("AGENT16"); // second preserved
		// CRLF endings survive the reverse-patch (no normalization crept in).
		expect(readFileSync(join(repo, "file.txt"), "utf-8")).toContain("\r\n");
	});

	it("leaves a tracked symlink uncorrupted while re-hashing a CRLF file", () => {
		// The raw re-hash re-hashes only regular files (100644/100755). A tracked
		// symlink (mode 120000) must be skipped: `hash-object --no-filters` on the
		// link path would FOLLOW the link and store the target file's bytes as the
		// symlink blob, silently corrupting the tree.
		writeFileSync(join(repo, ".gitattributes"), "* text=auto\n");
		const before = crlf(["line1", "line2", "line3"]);
		writeFileSync(join(repo, "file.txt"), before);
		symlinkSync("file.txt", join(repo, "link.txt")); // tracked symlink → file.txt
		commitAll(repo, "init");

		const base = captureTree(repo) as string;
		expect(base).not.toBeNull();
		// The regular file is re-hashed to its raw CRLF bytes…
		expect(baselineContent(repo, base, "file.txt")).toBe(before);
		// …while the symlink's baseline blob is still its target PATH string
		// ("file.txt"), not the CRLF contents of the file it points at — proving
		// the mode guard left it out of the raw re-hash.
		expect(baselineContent(repo, base, "link.txt")).toBe("file.txt");
	});
});
