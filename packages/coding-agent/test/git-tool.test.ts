import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitToolDefinition, validateGitArgs } from "../src/core/tools/git.js";

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
});
