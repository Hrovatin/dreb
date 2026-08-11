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

		// Regression tests for bundled/attached short-flag forms (finding I3):
		// `-o`/`-s` must be caught even when combined with other short flags
		// or with the value attached directly to the flag.
		it("blocks bundled and attached sort -o forms", () => {
			expect(isAllowedReadOnlyCommand("sort -ro out.txt in.txt")).toBe(false);
			expect(isAllowedReadOnlyCommand("sort -oout.txt in.txt")).toBe(false);
			expect(isAllowedReadOnlyCommand("sort -o=out.txt in.txt")).toBe(false);
			// Read-only sort flag clusters without -o remain allowed.
			expect(isAllowedReadOnlyCommand("sort -rn file")).toBe(true);
			expect(isAllowedReadOnlyCommand("sort -bf file")).toBe(true);
		});

		it("blocks attached date -s but not the read-only date -Iseconds", () => {
			expect(isAllowedReadOnlyCommand("date -s2020-01-01")).toBe(false);
			expect(isAllowedReadOnlyCommand("date --set=2020-01-01")).toBe(false);
			// `-Iseconds` / `-u` are read-only and must NOT be over-blocked.
			expect(isAllowedReadOnlyCommand("date -Iseconds")).toBe(true);
			expect(isAllowedReadOnlyCommand("date -u")).toBe(true);
		});
	});

	// Regression tests for process-substitution bypass (finding C1): `<(...)`
	// and `>(...)` execute their inner command unconditionally, so the outer
	// allowlisted head must not rescue them.
	describe("process substitution bypass", () => {
		it("blocks process substitution with a mutating inner", () => {
			expect(isAllowedReadOnlyCommand("diff <(git log) <(rm -rf /tmp/x)")).toBe(false);
			expect(isAllowedReadOnlyCommand("cat <(bash -c 'rm -rf /')")).toBe(false);
			expect(isAllowedReadOnlyCommand("echo <(git push origin main --force)")).toBe(false);
			expect(isAllowedReadOnlyCommand("git log <(rm -rf /)")).toBe(false);
		});

		it("blocks process substitution even with an allowlisted inner", () => {
			// A read-only mode has no legitimate use for process substitution;
			// reject it outright regardless of what the inner command is.
			expect(isAllowedReadOnlyCommand("diff <(git log) <(git status)")).toBe(false);
		});

		it("blocks process substitution nested inside a quoted command substitution", () => {
			expect(isAllowedReadOnlyCommand('cat "$(diff <(rm x) y)"')).toBe(false);
		});

		it("does not flag a quoted literal <( ) as process substitution", () => {
			expect(isAllowedReadOnlyCommand('grep "<(" file')).toBe(true);
			expect(isAllowedReadOnlyCommand("cat < in.txt")).toBe(true); // input redirection stays allowed
		});
	});

	// Regression tests for the quoted-substitution redirection bypass
	// (finding C2): a `>` inside a double-quoted `$(...)` still writes a file
	// because bash executes the substitution; the outer quote must not mask it.
	describe("redirection hidden inside a quoted command substitution", () => {
		it("blocks a write redirect inside a double-quoted substitution", () => {
			expect(isAllowedReadOnlyCommand('cat "$(echo hi > /tmp/pwned)"')).toBe(false);
			expect(isAllowedReadOnlyCommand('echo "$(echo pwn >> /tmp/z)"')).toBe(false);
			expect(isAllowedReadOnlyCommand('cat "prefix $(echo hi > /tmp/w) suffix"')).toBe(false);
		});

		it("still allows a read-only double-quoted substitution and inert quoted >", () => {
			expect(isAllowedReadOnlyCommand('cat "$(git rev-parse HEAD)"')).toBe(true);
			expect(isAllowedReadOnlyCommand('echo "a > b"')).toBe(true);
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
