import { describe, expect, it } from "vitest";
import { DEFAULT_READONLY_ALLOWLIST, isAllowedReadOnlyCommand } from "../src/core/readonly-commands.js";

describe("isAllowedReadOnlyCommand", () => {
	describe("git read subcommands", () => {
		it("allows git log variants", () => {
			expect(isAllowedReadOnlyCommand("git log")).toBe(true);
			expect(isAllowedReadOnlyCommand("git log --oneline")).toBe(true);
		});

		it("allows git diff --stat", () => {
			expect(isAllowedReadOnlyCommand("git diff --stat")).toBe(true);
		});

		it("disallows git push", () => {
			expect(isAllowedReadOnlyCommand("git push")).toBe(false);
		});

		it("disallows git commit", () => {
			expect(isAllowedReadOnlyCommand("git commit -m 'x'")).toBe(false);
		});

		it("disallows bare git", () => {
			expect(isAllowedReadOnlyCommand("git")).toBe(false);
		});
	});

	describe("basic read-only commands", () => {
		it("allows ls -la", () => {
			expect(isAllowedReadOnlyCommand("ls -la")).toBe(true);
		});

		it("allows cat file", () => {
			expect(isAllowedReadOnlyCommand("cat file")).toBe(true);
		});

		it("allows rg pattern", () => {
			expect(isAllowedReadOnlyCommand("rg pattern")).toBe(true);
		});
	});

	describe("mutating / non-allowlisted commands", () => {
		it("disallows rm file", () => {
			expect(isAllowedReadOnlyCommand("rm file")).toBe(false);
		});

		it("disallows npm install", () => {
			expect(isAllowedReadOnlyCommand("npm install")).toBe(false);
		});

		it("disallows python x.py", () => {
			expect(isAllowedReadOnlyCommand("python x.py")).toBe(false);
		});
	});

	describe("chained and piped commands", () => {
		it("disallows a chain where one segment is bad", () => {
			expect(isAllowedReadOnlyCommand("git log && rm -rf x")).toBe(false);
		});

		it("allows a pipe where every segment is allowed", () => {
			expect(isAllowedReadOnlyCommand("cat f | grep x")).toBe(true);
		});
	});

	describe("output redirection", () => {
		it("disallows writing to a file with >", () => {
			expect(isAllowedReadOnlyCommand("cat f > out.txt")).toBe(false);
		});

		it("disallows appending to a file with >>", () => {
			expect(isAllowedReadOnlyCommand("cat f >> out.txt")).toBe(false);
		});

		it("allows input redirection with <", () => {
			expect(isAllowedReadOnlyCommand("cat < in.txt")).toBe(true);
		});
	});

	describe("subshell and prefix bypasses", () => {
		it("disallows a subshell that writes", () => {
			expect(isAllowedReadOnlyCommand("$(git push)")).toBe(false);
		});

		it("disallows env-prefixed mutating command", () => {
			expect(isAllowedReadOnlyCommand("env rm x")).toBe(false);
		});

		it("allows a whole-segment read-only command substitution", () => {
			expect(isAllowedReadOnlyCommand("$(git log)")).toBe(true);
			expect(isAllowedReadOnlyCommand("`git status`")).toBe(true);
		});

		it("allows a read-only outer command with a read-only substitution argument", () => {
			expect(isAllowedReadOnlyCommand("cat $(git rev-parse HEAD)")).toBe(true);
			expect(isAllowedReadOnlyCommand("git log $(cat file)")).toBe(true);
		});

		it("rejects a substitution whose inner command mutates", () => {
			expect(isAllowedReadOnlyCommand("cat $(rm x)")).toBe(false);
			expect(isAllowedReadOnlyCommand("echo $(git push)")).toBe(false);
		});
	});

	// Regression tests for the command-substitution allowlist bypass (finding 1):
	// the OUTER command head is authoritative, so a mutating command suffixed
	// with an allowlisted substitution must NOT be approved.
	describe("command-substitution bypass (outer head authoritative)", () => {
		it("blocks a mutating outer command with a trailing $() substitution", () => {
			expect(isAllowedReadOnlyCommand("rm -rf ./build $(git log)")).toBe(false);
			expect(isAllowedReadOnlyCommand("chmod 777 secret.key $(ls)")).toBe(false);
			expect(isAllowedReadOnlyCommand("mv $(cat a) $(cat b)")).toBe(false);
			expect(isAllowedReadOnlyCommand("npm publish $(pwd)")).toBe(false);
		});

		it("blocks a mutating outer command with a trailing backtick substitution", () => {
			expect(isAllowedReadOnlyCommand("rm `cat foobar`")).toBe(false);
		});

		it("blocks a git push variant hidden behind a substitution", () => {
			// Not caught by the forbidden-commands force-push denylist, so the
			// allowlist itself must reject it.
			expect(isAllowedReadOnlyCommand("git push origin +main $(ls)")).toBe(false);
		});

		it("fails closed on unbalanced command substitutions", () => {
			expect(isAllowedReadOnlyCommand("cat $(git log")).toBe(false);
			expect(isAllowedReadOnlyCommand("cat `git log")).toBe(false);
		});
	});

	// Regression tests for mutation-capable allowlist heads (finding 2).
	describe("mutation-capable heads and flags", () => {
		it("does not allow sed or awk at all (write/exec escape hatches)", () => {
			expect(isAllowedReadOnlyCommand("sed -i s/a/b/ file.txt")).toBe(false);
			expect(isAllowedReadOnlyCommand("sed s/a/b/ file.txt")).toBe(false);
			expect(isAllowedReadOnlyCommand("awk 'BEGIN{system(\"rm -rf /tmp/x\")}'")).toBe(false);
			expect(isAllowedReadOnlyCommand("awk '{print > \"out\"}' file")).toBe(false);
		});

		it("blocks find with mutating action flags but allows plain find", () => {
			expect(isAllowedReadOnlyCommand("find . -name '*.ts'")).toBe(true);
			expect(isAllowedReadOnlyCommand("find . -delete")).toBe(false);
			expect(isAllowedReadOnlyCommand("find . -name '*.tmp' -delete")).toBe(false);
			expect(isAllowedReadOnlyCommand("find . -exec rm {} ;")).toBe(false);
			expect(isAllowedReadOnlyCommand("find . -execdir touch {} ;")).toBe(false);
			expect(isAllowedReadOnlyCommand("find . -fprintf out.txt '%p'")).toBe(false);
		});

		it("blocks sort -o / --output but allows plain sort", () => {
			expect(isAllowedReadOnlyCommand("sort file")).toBe(true);
			expect(isAllowedReadOnlyCommand("sort -o out.txt in.txt")).toBe(false);
			expect(isAllowedReadOnlyCommand("sort --output=out.txt in.txt")).toBe(false);
		});

		it("blocks date -s / --set but allows plain date", () => {
			expect(isAllowedReadOnlyCommand("date")).toBe(true);
			expect(isAllowedReadOnlyCommand("date -s '2020-01-01'")).toBe(false);
			expect(isAllowedReadOnlyCommand("date --set='2020-01-01'")).toBe(false);
		});
	});

	describe("custom allowlist override", () => {
		it("replaces defaults entirely", () => {
			// Only "echo" allowed → cat is now rejected, echo accepted.
			expect(isAllowedReadOnlyCommand("cat file", ["echo"])).toBe(false);
			expect(isAllowedReadOnlyCommand("echo hi", ["echo"])).toBe(true);
		});

		it("ignores non-array allowlist and uses defaults", () => {
			// @ts-expect-error testing runtime guard against bad input
			expect(isAllowedReadOnlyCommand("cat file", "cat")).toBe(true);
		});
	});

	describe("edge cases", () => {
		it("returns false for empty string", () => {
			expect(isAllowedReadOnlyCommand("")).toBe(false);
		});

		it("returns false for whitespace-only string", () => {
			expect(isAllowedReadOnlyCommand("   ")).toBe(false);
		});

		it("does not match 'category' with the 'cat' entry", () => {
			expect(isAllowedReadOnlyCommand("category")).toBe(false);
		});
	});

	describe("DEFAULT_READONLY_ALLOWLIST", () => {
		it("exposes the base allowlist as an array", () => {
			expect(Array.isArray(DEFAULT_READONLY_ALLOWLIST)).toBe(true);
			expect(DEFAULT_READONLY_ALLOWLIST).toContain("ls");
			expect(DEFAULT_READONLY_ALLOWLIST).toContain("git log");
		});
	});
});
