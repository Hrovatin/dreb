/**
 * git-snapshot — host-side git operations backing the change-review feature.
 *
 * The dreb agent runs out-of-process and writes edits straight to disk, so the
 * extension cannot hold changes in an unsaved overlay the way an in-process
 * editor (e.g. Copilot) can. Instead we snapshot a **baseline tree** *before*
 * the agent's turn and diff/revert the working tree against it:
 *
 *   captureTree()  → a git tree object of the current working tree, taken via a
 *                    throwaway temp index so neither the user's index nor their
 *                    working tree is touched. Because it snapshots the working
 *                    tree *as-is* (including the user's own uncommitted edits),
 *                    later diffs isolate only what the agent changed.
 *   changedFiles() → baseline-tree → current-tree name-status.
 *   fileDiff()     → unified diff for one path (real `a/… b/…` headers so the
 *                    reverse patch applies to the working file).
 *   revertHunk()   → `git apply --reverse` of exactly one hunk (the
 *                    non-interactive equivalent of `git restore -p`).
 *   revertFile()   → restore a path to its baseline content (or delete it).
 *
 * No `vscode` import — pure node + git, exercised against real temp repos in
 * `test/git-snapshot.test.ts`. Mirrors the `spawnSync("git", …, { env: gitEnv })`
 * pattern used by `@dreb/coding-agent`'s `git-repo-state.ts`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseFileDiff, sliceHunkPatch } from "./diff-hunks.js";
import type { ChangedFile } from "./review-model.js";

/** Strip inherited GIT_* env so a hook-set GIT_DIR/GIT_INDEX_FILE can't redirect
 * us to the wrong repo (mirrors `@dreb/coding-agent`'s `gitEnv`). */
function gitEnv(): NodeJS.ProcessEnv {
	const { GIT_DIR: _d, GIT_INDEX_FILE: _i, GIT_WORK_TREE: _w, ...env } = process.env;
	return env;
}

/** Walk upward for a `.git` dir/file; returns the repo root or null. */
export function findGitRoot(cwd: string): string | null {
	let current = resolve(cwd);
	while (true) {
		const gitPath = join(current, ".git");
		if (existsSync(gitPath)) {
			try {
				const st = statSync(gitPath);
				if (st.isDirectory() || st.isFile()) return current;
			} catch {
				// keep walking
			}
		}
		const parent = resolve(current, "..");
		if (parent === current) return null;
		current = parent;
	}
}

/** Whether `cwd` is inside a git working tree. */
export function isGitRepo(cwd: string): boolean {
	return findGitRoot(cwd) !== null;
}

interface GitResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

function runGit(cwd: string, args: string[], opts?: { indexFile?: string; input?: string }): GitResult {
	const env = gitEnv();
	if (opts?.indexFile) env.GIT_INDEX_FILE = opts.indexFile;
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		timeout: 15000,
		input: opts?.input,
		env,
	});
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Read a path's bytes from a tree, or null when the path is absent from it. */
function readBlob(cwd: string, tree: string, path: string): Buffer | null {
	const result = spawnSync("git", ["cat-file", "blob", `${tree}:${path}`], {
		cwd,
		timeout: 15000,
		env: gitEnv(),
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0) return null;
	return result.stdout as Buffer;
}

/**
 * Snapshot the current working tree into a git tree object via a throwaway index
 * (so the user's real index/working tree are untouched). Returns the tree SHA,
 * or null if the snapshot could not be taken (e.g. not a git repo).
 */
export function captureTree(cwd: string): string | null {
	if (!isGitRepo(cwd)) return null;
	const dir = mkdtempSync(join(tmpdir(), "dreb-review-"));
	const indexFile = join(dir, "index");
	try {
		const add = runGit(cwd, ["add", "-A"], { indexFile });
		if (add.status !== 0) return null;
		const write = runGit(cwd, ["write-tree"], { indexFile });
		if (write.status !== 0) return null;
		const tree = write.stdout.trim();
		return tree.length > 0 ? tree : null;
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
}

function mapStatus(code: string): ChangedFile["status"] {
	if (code.startsWith("A")) return "added";
	if (code.startsWith("D")) return "deleted";
	return "modified";
}

/**
 * Files that differ between the baseline tree and the current working tree.
 * Builds a fresh current-tree snapshot so newly created (untracked) files are
 * included, then diffs tree-to-tree. Hunk counts come from each file's diff;
 * binary files report a hunk count of 0 and status "binary".
 */
export function changedFiles(cwd: string, baselineTree: string): ChangedFile[] {
	const currentTree = captureTree(cwd);
	if (currentTree === null) return [];
	const res = runGit(cwd, ["diff", "--name-status", "-z", baselineTree, currentTree]);
	if (res.status !== 0 || res.stdout.length === 0) return [];
	// `-z` output: STATUS\0PATH\0STATUS\0PATH\0…  (renames add an extra path we
	// don't request via -M, so plain A/M/D pairs are expected).
	const parts = res.stdout.split("\0").filter((p) => p.length > 0);
	const files: ChangedFile[] = [];
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const code = parts[i];
		const path = parts[i + 1];
		const status = mapStatus(code);
		const { hunks, binary } = fileDiffAgainst(cwd, baselineTree, currentTree, path);
		files.push({
			path,
			status: binary ? "binary" : status,
			hunkCount: hunks,
		});
	}
	return files;
}

/** Internal: parsed diff summary for a path between two known trees. */
function fileDiffAgainst(
	cwd: string,
	baselineTree: string,
	currentTree: string,
	path: string,
): { diff: string; hunks: number; binary: boolean } {
	const res = runGit(cwd, ["diff", baselineTree, currentTree, "--", path]);
	const diff = res.stdout;
	const parsed = parseFileDiff(diff);
	return { diff, hunks: parsed.hunks.length, binary: parsed.binary };
}

/**
 * Unified diff (baseline → current) for a single path, with real `a/… b/…`
 * headers suitable for `git apply`. Returns the diff text and whether git
 * reported it binary.
 */
export function fileDiff(cwd: string, baselineTree: string, path: string): { diff: string; binary: boolean } {
	const currentTree = captureTree(cwd);
	if (currentTree === null) return { diff: "", binary: false };
	const { diff, binary } = fileDiffAgainst(cwd, baselineTree, currentTree, path);
	return { diff, binary };
}

/** The baseline content of a path (for the diff viewer's left side), or null
 * when the path did not exist in the baseline (a file the agent created). */
export function baselineContent(cwd: string, baselineTree: string, path: string): string | null {
	const buf = readBlob(cwd, baselineTree, path);
	return buf === null ? null : buf.toString("utf8");
}

/**
 * Reverse exactly one hunk of a file's baseline→current diff, undoing that hunk
 * in the working file while leaving the others intact. Returns true on success.
 */
export function revertHunk(cwd: string, baselineTree: string, path: string, hunkIndex: number): boolean {
	const { diff, binary } = fileDiff(cwd, baselineTree, path);
	if (binary || diff.length === 0) return false;
	const parsed = parseFileDiff(diff);
	const patch = sliceHunkPatch(parsed, hunkIndex);
	if (patch === undefined) return false;
	const res = runGit(cwd, ["apply", "--reverse", "--recount", "-p1", "-"], { input: patch });
	return res.status === 0;
}

/**
 * Restore a path to its baseline content: rewrite the file with the baseline
 * bytes, or delete it when it did not exist in the baseline. Returns true on
 * success (including a no-op delete of an already-absent file).
 */
export function revertFile(cwd: string, baselineTree: string, path: string): boolean {
	const abs = join(cwd, path);
	const buf = readBlob(cwd, baselineTree, path);
	try {
		if (buf === null) {
			if (existsSync(abs)) unlinkSync(abs);
			return true;
		}
		writeFileSync(abs, buf);
		return true;
	} catch {
		return false;
	}
}
