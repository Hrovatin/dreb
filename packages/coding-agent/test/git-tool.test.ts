import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stripAnsi from "strip-ansi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitToolDefinition, formatGitCall, formatGitResult, validateGitArgs } from "../src/core/tools/git.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

/**
 * The typed `git` tool is the capability-model replacement for gated bash in
 * Ask mode. These tests pin two things:
 *   1. `validateGitArgs` is fail-CLOSED on arguments — unknown flags, write
 *      flags, global redirectors, and mutating positionals are rejected.
 *   2. The tool executes via `spawn("git", ...)` with NO shell, so shell
 *      metacharacters in `args` are inert (passed to git verbatim).
 */

describe("validateGitArgs — read-only argument allow-list", () => {
	it("allows common read-only log/diff/show flags", () => {
		expect(validateGitArgs("log", ["--oneline", "-n", "5"])).toBeUndefined();
		expect(validateGitArgs("log", ["-5", "--stat", "--format=%H"])).toBeUndefined();
		expect(validateGitArgs("diff", ["--stat", "--cached"])).toBeUndefined();
		expect(validateGitArgs("show", ["HEAD", "--name-only"])).toBeUndefined();
		expect(validateGitArgs("status", ["--short", "--branch"])).toBeUndefined();
		expect(validateGitArgs("blame", ["-L", "1,20", "file.ts"])).toBeUndefined();
	});

	it("treats refs and paths (and everything after `--`) as read-only positionals", () => {
		expect(validateGitArgs("log", ["main", "--", "src/app.ts"])).toBeUndefined();
		expect(validateGitArgs("diff", ["HEAD~3", "HEAD", "--", "packages/"])).toBeUndefined();
		// A weird positional after `--` is inert to the validator (git only reads it).
		expect(validateGitArgs("log", ["--", "--output=/tmp/x"])).toBeUndefined();
	});

	it("rejects file-writing flags on otherwise read-only subcommands", () => {
		expect(validateGitArgs("log", ["--output=/tmp/pwn.txt"])).toMatch(/write files/);
		expect(validateGitArgs("diff", ["--output", "/tmp/pwn.txt"])).toMatch(/write files/);
		expect(validateGitArgs("show", ["-O", "/tmp/pwn.txt"])).toMatch(/write files/);
	});

	it("rejects global git options that redirect git or run code", () => {
		expect(validateGitArgs("log", ["-c", "core.pager=!touch /tmp/x"])).toMatch(/Global git option/);
		expect(validateGitArgs("log", ["--exec-path=/tmp/evil"])).toMatch(/Global git option/);
		expect(validateGitArgs("log", ["-C", "/etc"])).toMatch(/Global git option/);
		expect(validateGitArgs("status", ["--git-dir=/tmp/other/.git"])).toMatch(/Global git option/);
	});

	it("rejects unknown flags fail-closed", () => {
		expect(validateGitArgs("log", ["--totally-made-up"])).toMatch(/not in the read-only allow-list/);
		expect(validateGitArgs("status", ["--frobnicate"])).toMatch(/not in the read-only allow-list/);
	});

	it("rejects mutating positionals for branch and tag (create/rename)", () => {
		expect(validateGitArgs("branch", ["newbranch"])).toMatch(/could create or modify/);
		expect(validateGitArgs("tag", ["v9.9.9"])).toMatch(/could create or modify/);
		// but listing forms are fine
		expect(validateGitArgs("branch", ["-a"])).toBeUndefined();
		expect(validateGitArgs("branch", ["--sort=-committerdate", "--format=%(refname)"])).toBeUndefined();
		expect(validateGitArgs("tag", ["-l"])).toBeUndefined();
		expect(validateGitArgs("tag", ["-n5"])).toBeUndefined();
		expect(validateGitArgs("branch", ["--contains=HEAD"])).toBeUndefined();
		expect(validateGitArgs("branch", ["--points-at=HEAD"])).toBeUndefined();
	});

	it("rejects branch/tag creation smuggled after a bare `--` (round-9 finding 1)", () => {
		// `git branch -- <name>` / `git tag -- <name>` still CREATE the ref in real
		// git, so post-`--` tokens must be rejected for positionals:"none" subcommands.
		expect(validateGitArgs("branch", ["--", "newbranch"])).toMatch(/could create or modify/);
		expect(validateGitArgs("tag", ["--", "v9.9.9"])).toMatch(/could create or modify/);
		expect(validateGitArgs("branch", ["--", "--weird-name"])).toMatch(/could create or modify/);
		// Read subcommands still treat post-`--` tokens as inert pathspecs.
		expect(validateGitArgs("log", ["--", "newbranch"])).toBeUndefined();
	});

	it("allows read-only subcommand flags that share a name with a global option (round-9 finding 4)", () => {
		// The per-subcommand allow-list is authoritative: `-C` (diff/blame), `-c`
		// (ls-files --cached), and `--git-dir` (rev-parse) are legitimate read-only
		// flags even though they collide with dangerous *global* option names.
		expect(validateGitArgs("diff", ["-C"])).toBeUndefined();
		expect(validateGitArgs("blame", ["-C", "file.ts"])).toBeUndefined();
		expect(validateGitArgs("ls-files", ["-c"])).toBeUndefined();
		expect(validateGitArgs("rev-parse", ["--git-dir"])).toBeUndefined();
		// ...but the same names as a genuine global redirect (with a value, or on a
		// subcommand that doesn't list them) are still rejected.
		expect(validateGitArgs("rev-parse", ["--git-dir=/tmp/other/.git"])).toMatch(/Global git option/);
		expect(validateGitArgs("log", ["-C", "/etc"])).toMatch(/Global git option/);
	});

	it("covers the previously-untested read-only subcommands (round-9 finding 3)", () => {
		// describe
		expect(validateGitArgs("describe", ["--tags", "--always"])).toBeUndefined();
		expect(validateGitArgs("describe", ["--match=v*", "HEAD"])).toBeUndefined();
		expect(validateGitArgs("describe", ["--frobnicate"])).toMatch(/not in the read-only allow-list/);
		// rev-parse
		expect(validateGitArgs("rev-parse", ["--abbrev-ref", "HEAD"])).toBeUndefined();
		expect(validateGitArgs("rev-parse", ["--short=8", "HEAD"])).toBeUndefined();
		expect(validateGitArgs("rev-parse", ["--frobnicate"])).toMatch(/not in the read-only allow-list/);
		// ls-files
		expect(validateGitArgs("ls-files", ["--cached", "--full-name"])).toBeUndefined();
		expect(validateGitArgs("ls-files", ["--exclude=*.log"])).toBeUndefined();
		expect(validateGitArgs("ls-files", ["--frobnicate"])).toMatch(/not in the read-only allow-list/);
		// ls-tree
		expect(validateGitArgs("ls-tree", ["-r", "--name-only", "HEAD"])).toBeUndefined();
		expect(validateGitArgs("ls-tree", ["--format=%(path)"])).toBeUndefined();
		expect(validateGitArgs("ls-tree", ["--frobnicate"])).toMatch(/not in the read-only allow-list/);
		// shortlog
		expect(validateGitArgs("shortlog", ["-sn", "--all"])).toBeDefined(); // -sn is not a listed flag
		expect(validateGitArgs("shortlog", ["-s", "-n", "--all"])).toBeUndefined();
		expect(validateGitArgs("shortlog", ["--author=alice"])).toBeUndefined();
		expect(validateGitArgs("shortlog", ["--frobnicate"])).toMatch(/not in the read-only allow-list/);
	});

	it("rejects the full set of forbidden global and write flags (round-9 finding 8)", () => {
		// Global redirectors beyond -c/-C/--exec-path/--git-dir.
		expect(validateGitArgs("log", ["--work-tree=/tmp/x"])).toMatch(/Global git option/);
		expect(validateGitArgs("log", ["--namespace=x"])).toMatch(/Global git option/);
		expect(validateGitArgs("log", ["--config-env=x=Y"])).toMatch(/Global git option/);
		expect(validateGitArgs("log", ["--no-pager"])).toMatch(/Global git option/);
		// Write/exec flags beyond --output/-O.
		expect(validateGitArgs("log", ["--output-directory=/tmp"])).toMatch(/write files/);
		expect(validateGitArgs("log", ["--exec=touch /tmp/x"])).toMatch(/write files/);
		expect(validateGitArgs("log", ["--open-files-in-pager=less"])).toMatch(/write files/);
		expect(validateGitArgs("diff", ["--ext-diff"])).toMatch(/write files/);
	});

	it("rejects `remote -v` with trailing arguments (round-9 finding 11)", () => {
		expect(validateGitArgs("remote", ["-v", "extra"])).toMatch(/takes no further arguments/);
		expect(validateGitArgs("remote", ["--verbose", "origin"])).toMatch(/takes no further arguments/);
	});

	it("rejects mutating branch/tag flags", () => {
		expect(validateGitArgs("branch", ["-D", "main"])).toBeDefined();
		expect(validateGitArgs("branch", ["-d", "feature"])).toBeDefined();
		expect(validateGitArgs("branch", ["-m", "old", "new"])).toBeDefined();
		expect(validateGitArgs("tag", ["-d", "v1.0"])).toBeDefined();
	});

	it("only allows read-only remote sub-verbs", () => {
		expect(validateGitArgs("remote", [])).toBeUndefined();
		expect(validateGitArgs("remote", ["-v"])).toBeUndefined();
		expect(validateGitArgs("remote", ["show", "origin"])).toBeUndefined();
		expect(validateGitArgs("remote", ["get-url", "origin"])).toBeUndefined();
		expect(validateGitArgs("remote", ["add", "evil", "https://x"])).toMatch(/not read-only/);
		expect(validateGitArgs("remote", ["remove", "origin"])).toMatch(/not read-only/);
		expect(validateGitArgs("remote", ["set-url", "origin", "https://x"])).toMatch(/not read-only/);
	});

	it("git config is allowed only in read forms", () => {
		expect(validateGitArgs("config", ["--get", "user.name"])).toBeUndefined();
		expect(validateGitArgs("config", ["--list"])).toBeUndefined();
		expect(validateGitArgs("config", ["--get-regexp", "^user"])).toBeUndefined();
		// setting a value is a mutation
		expect(validateGitArgs("config", ["user.name", "attacker"])).toMatch(/read forms/);
		expect(validateGitArgs("config", ["--unset", "user.name"])).toBeDefined();
	});

	it("caps the number of arguments", () => {
		expect(validateGitArgs("log", new Array(100).fill("--oneline"))).toMatch(/Too many/);
	});
});

describe("git tool — shell-free execution", () => {
	let repo: string;
	const tool = () => createGitToolDefinition(repo);

	beforeAll(() => {
		repo = mkdtempSync(join(tmpdir(), "dreb-git-tool-"));
		mkdirSync(repo, { recursive: true });
		const run = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
		run(["init", "-q"]);
		run(["config", "user.email", "t@example.com"]);
		run(["config", "user.name", "Tester"]);
		writeFileSync(join(repo, "a.txt"), "hello\n");
		run(["add", "a.txt"]);
		run(["commit", "-q", "-m", "initial commit"]);
	});

	afterAll(() => {
		if (repo) rmSync(repo, { recursive: true, force: true });
	});

	const exec = async (subcommand: string, args: string[]) => {
		const def = tool();
		return def.execute("id", { subcommand, args } as never, undefined as never, () => {}, undefined as never);
	};

	it("runs a real read-only git log", async () => {
		const result = await exec("log", ["--oneline"]);
		const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
		expect(text).toContain("initial commit");
	});

	it("passes args to git verbatim — shell metacharacters are inert (no shell)", async () => {
		// If this were run through a shell, the `; touch` would execute. Via
		// execFile it becomes a single literal git argument → git errors, and
		// crucially the marker file is NEVER created.
		const marker = join(repo, "SHOULD_NOT_EXIST");
		const result = await exec("log", [`--format=; touch ${marker}`]);
		const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
		// git ran (or errored) but did not execute a shell command.
		expect(text).not.toContain("SHOULD_NOT_EXIST created");
		const { existsSync } = await import("node:fs");
		expect(existsSync(marker)).toBe(false);
	});

	it("blocks a write flag before spawning git (no file written)", async () => {
		const target = join(repo, "pwn.txt");
		const result = await exec("log", [`--output=${target}`]);
		const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
		expect(text).toMatch(/write files/);
		const { existsSync } = await import("node:fs");
		expect(existsSync(target)).toBe(false);
	});

	it("blocks a mutating positional before spawning git (no branch created)", async () => {
		const result = await exec("branch", ["created-by-attacker"]);
		const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
		expect(text).toMatch(/could create or modify/);
		// Verify no such branch exists.
		const branches = execFileSync("git", ["branch", "--list"], { cwd: repo, encoding: "utf-8" });
		expect(branches).not.toContain("created-by-attacker");
	});

	it("blocks branch creation smuggled after `--` before spawning git (no branch created)", async () => {
		const result = await exec("branch", ["--", "dashdash-branch"]);
		const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
		expect(text).toMatch(/could create or modify/);
		const branches = execFileSync("git", ["branch", "--list"], { cwd: repo, encoding: "utf-8" });
		expect(branches).not.toContain("dashdash-branch");
	});
});

describe("git tool — timeout, abort, and output cap (round-10 findings 1/2/3/5)", () => {
	let repo: string;

	beforeAll(() => {
		repo = mkdtempSync(join(tmpdir(), "dreb-git-tool-r10-"));
		mkdirSync(repo, { recursive: true });
		const run = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
		run(["init", "-q"]);
		run(["config", "user.email", "t@example.com"]);
		run(["config", "user.name", "Tester"]);
		writeFileSync(join(repo, "a.txt"), "hello\n");
		run(["add", "a.txt"]);
		run(["commit", "-q", "-m", "initial commit"]);
	});

	afterAll(() => {
		if (repo) rmSync(repo, { recursive: true, force: true });
	});

	// A spawn seam that ignores the git args and instead launches a real,
	// long-lived process in its own group. Its internal timer (10 minutes) is
	// deliberately far longer than this file's 30s vitest `testTimeout` and the
	// explicit per-test timeouts below, so the process CANNOT self-exit during a
	// test: the only way the promise settles is if killProcessTree actually reaps
	// it. If the timeout/abort/tree-kill wiring regresses to a no-op, these tests
	// hang until their per-test timeout and FAIL — they cannot pass falsely.
	const sleeperSpawn = ((_cmd: string, _args: readonly string[], opts: object) =>
		spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], opts as never)) as typeof spawn;

	const textOf = (result: { content: Array<{ text?: string }> }) => result.content.map((c) => c.text ?? "").join("");

	it("rejects immediately when the abort signal is already aborted (no spawn)", async () => {
		const def = createGitToolDefinition(repo);
		const controller = new AbortController();
		controller.abort();
		await expect(
			def.execute(
				"id",
				{ subcommand: "log", args: [] } as never,
				controller.signal,
				undefined as never,
				undefined as never,
			),
		).rejects.toThrow(/aborted/i);
	});

	it("kills the process tree and rejects when aborted mid-run", async () => {
		const def = createGitToolDefinition(repo, { spawnFn: sleeperSpawn });
		const controller = new AbortController();
		const p = def.execute(
			"id",
			{ subcommand: "log", args: [] } as never,
			controller.signal,
			undefined as never,
			undefined as never,
		);
		setTimeout(() => controller.abort(), 50);
		// The sleeper runs for 10 minutes; the only way this promise rejects within
		// the 10s budget is if onAbort's killProcessTree genuinely reaps it.
		await expect(p).rejects.toThrow(/Operation aborted/);
	}, 10_000);

	it("times out and tree-kills a hanging git, rejecting with a timeout message (finding 2)", async () => {
		const def = createGitToolDefinition(repo, { timeoutMs: 100, spawnFn: sleeperSpawn });
		// The sleeper never self-exits within the budget, so a "timed out" rejection
		// can only arrive if the watchdog's killProcessTree actually terminates it.
		await expect(
			def.execute(
				"id",
				{ subcommand: "log", args: [] } as never,
				undefined as never,
				undefined as never,
				undefined as never,
			),
		).rejects.toThrow(/timed out/i);
	}, 10_000);

	it("maps a spawn ENOENT to a clear 'git is not installed' error (rewritten .catch path)", async () => {
		// A real spawn of a missing binary emits `error` with code ENOENT, which
		// waitForChildProcess surfaces to the rewritten .catch branch.
		const missingBinarySpawn = (() => spawn("dreb-definitely-not-a-real-binary-xyz", [])) as unknown as typeof spawn;
		const def = createGitToolDefinition(repo, { spawnFn: missingBinarySpawn });
		await expect(
			def.execute(
				"id",
				{ subcommand: "log", args: [] } as never,
				undefined as never,
				undefined as never,
				undefined as never,
			),
		).rejects.toThrow(/git is not installed or not on PATH/i);
	});

	it("wraps a non-ENOENT spawn error in a 'Failed to run git' message (rewritten .catch path)", async () => {
		// Fake child that emits a generic (non-ENOENT) error after the tool has
		// attached its listeners, exercising the .catch fallback branch.
		const genericErrorSpawn = (() => {
			const child = new EventEmitter() as unknown as ReturnType<typeof spawn>;
			Object.assign(child, { stdout: null, stderr: null, pid: undefined, killed: false, kill: () => true });
			setTimeout(() => {
				child.emit("error", Object.assign(new Error("permission denied"), { code: "EACCES" }));
			}, 0);
			return child;
		}) as unknown as typeof spawn;
		const def = createGitToolDefinition(repo, { spawnFn: genericErrorSpawn });
		await expect(
			def.execute(
				"id",
				{ subcommand: "log", args: [] } as never,
				undefined as never,
				undefined as never,
				undefined as never,
			),
		).rejects.toThrow(/Failed to run git: permission denied/i);
	});

	it("stops git early and returns partial output when the capture cap is hit (finding 3)", async () => {
		// Tiny cap forces capHit on the very first data chunk from a real git read.
		const def = createGitToolDefinition(repo, { maxCaptureBytes: 8 });
		const result = await def.execute(
			"id",
			{ subcommand: "log", args: ["--format=%H"] } as never,
			undefined as never,
			undefined as never,
			undefined as never,
		);
		const text = textOf(result);
		expect(text).toMatch(/git was stopped early/);
		// The captured portion (before the marker) is bounded near the cap, not the
		// full 40-char commit hash.
		const preMarker = text.split("\n\n[output exceeded")[0];
		expect(preMarker.length).toBeLessThanOrEqual(8);
	});

	it("a cap hit wins over a since-armed timeout — success, not a spurious timeout (finding 5)", async () => {
		// Cap hits on the first chunk and disarms the 50ms watchdog, so even with a
		// short timeout the result is the bounded-capture success, never a timeout.
		const def = createGitToolDefinition(repo, { maxCaptureBytes: 8, timeoutMs: 50 });
		const result = await def.execute(
			"id",
			{ subcommand: "log", args: ["--format=%H"] } as never,
			undefined as never,
			undefined as never,
			undefined as never,
		);
		const text = textOf(result);
		expect(text).toMatch(/git was stopped early/);
		expect(text).not.toMatch(/timed out/i);
	});

	it("byte-accounts the cap so multi-byte UTF-8 output cannot overshoot (finding 4)", async () => {
		// Commit a CJK-heavy message; with a small byte cap the captured prefix must
		// be bounded by BYTES, not UTF-16 code units (each 日 is 3 UTF-8 bytes).
		execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "日".repeat(50)], { cwd: repo });
		const def = createGitToolDefinition(repo, { maxCaptureBytes: 12 });
		const result = await def.execute(
			"id",
			{ subcommand: "log", args: ["--format=%s"] } as never,
			undefined as never,
			undefined as never,
			undefined as never,
		);
		const text = textOf(result);
		expect(text).toMatch(/git was stopped early/);
		const preMarker = text.split("\n\n[output exceeded")[0];
		// Byte length of the captured prefix must not exceed the cap.
		expect(Buffer.byteLength(preMarker, "utf-8")).toBeLessThanOrEqual(12);
	});
});

describe("git tool — render helpers (round-9 finding 12)", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("formatGitCall renders the subcommand and args", () => {
		const out = stripAnsi(formatGitCall({ subcommand: "log", args: ["--oneline", "-n", "5"] }, theme));
		expect(out).toContain("git");
		expect(out).toContain("log");
		expect(out).toContain("--oneline -n 5");
	});

	it("formatGitCall shows an invalid-arg marker when the subcommand is not a string", () => {
		const out = stripAnsi(formatGitCall({ subcommand: 123 as unknown as string }, theme));
		expect(out).toContain("[invalid arg]");
	});

	it("formatGitResult renders output lines", () => {
		const result = { content: [{ type: "text", text: "line1\nline2\nline3" }] };
		const out = stripAnsi(formatGitResult(result, { expanded: false, isPartial: false }, theme, false));
		expect(out).toContain("line1");
		expect(out).toContain("line3");
	});

	it("formatGitResult truncates to 20 lines when not expanded and notes the remainder", () => {
		const text = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n");
		const result = { content: [{ type: "text", text }] };
		const collapsed = stripAnsi(formatGitResult(result, { expanded: false, isPartial: false }, theme, false));
		expect(collapsed).toContain("line20");
		expect(collapsed).not.toContain("line21");
		expect(collapsed).toContain("(10 more lines)");
		// Expanded shows everything with no remainder note.
		const expanded = stripAnsi(formatGitResult(result, { expanded: true, isPartial: false }, theme, false));
		expect(expanded).toContain("line30");
		expect(expanded).not.toContain("more lines");
	});
});
