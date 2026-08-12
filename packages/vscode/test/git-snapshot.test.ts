/**
 * Real-git integration tests for the change-review snapshot engine. Each test
 * runs against a throwaway temp repo (mirroring `coding-agent`'s
 * `git-update.test.ts`), exercising the actual git plumbing: temp-index tree
 * capture, tree-to-tree change detection, and `git apply --reverse` per hunk.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});
