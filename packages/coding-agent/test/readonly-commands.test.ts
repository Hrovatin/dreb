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

		it("allows plain quoted arguments (no disallowed metacharacters)", () => {
			expect(isAllowedReadOnlyCommand("grep 'foo bar' file")).toBe(true);
			expect(isAllowedReadOnlyCommand('grep "foo bar" file')).toBe(true);
			expect(isAllowedReadOnlyCommand("find . -name '*.ts'")).toBe(true);
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

		it("disallows env-prefixed mutating command", () => {
			expect(isAllowedReadOnlyCommand("env rm x")).toBe(false);
		});
	});

	describe("chained and piped commands", () => {
		it("disallows a chain where one segment is bad", () => {
			expect(isAllowedReadOnlyCommand("git log && rm -rf x")).toBe(false);
			expect(isAllowedReadOnlyCommand("cat f | rm x")).toBe(false);
			expect(isAllowedReadOnlyCommand("git status ; npm publish")).toBe(false);
		});

		it("allows a pipe where every segment is allowed", () => {
			expect(isAllowedReadOnlyCommand("cat f | grep x")).toBe(true);
			expect(isAllowedReadOnlyCommand("git log | head")).toBe(true);
		});

		it("allows &&/||/; chains where every segment is allowed", () => {
			expect(isAllowedReadOnlyCommand("git log && git status")).toBe(true);
			expect(isAllowedReadOnlyCommand("cat a || cat b")).toBe(true);
			expect(isAllowedReadOnlyCommand("ls ; pwd")).toBe(true);
		});
	});

	// ── B1 design: fail-closed by restriction ──────────────────────────────
	// Read-only mode REJECTS, on the raw string, any construct that can execute
	// a command, redirect I/O, or that the operator-splitter cannot safely
	// tokenize. This is one uniform check (`hasDisallowedConstruct`) that
	// removes the entire class of quote-desync / nested-substitution bypasses,
	// replacing the previous recursive quote-tracking scanners.
	// ── Finding 1: environment-assignment / path / dispatch prefix injection ──
	// `stripShellPrefixes` used to LAUNDER these leading prefixes for the
	// allowlist match while bash honored them at runtime (`PATH=`/`LD_PRELOAD=`/
	// `GIT_EXTERNAL_DIFF=` → arbitrary code execution; a path'd name → arbitrary
	// binary). They are now rejected outright before matching.
	describe("dangerous leading prefixes are rejected (finding 1)", () => {
		it("rejects VAR=value environment-assignment prefixes", () => {
			expect(isAllowedReadOnlyCommand("PATH=/tmp/evil ls -la /etc")).toBe(false);
			expect(isAllowedReadOnlyCommand("LD_PRELOAD=/tmp/evil.so cat file.txt")).toBe(false);
			expect(isAllowedReadOnlyCommand("GIT_EXTERNAL_DIFF=/tmp/evil.sh git diff")).toBe(false);
			expect(isAllowedReadOnlyCommand("GIT_PAGER=/tmp/evil git log")).toBe(false);
			expect(isAllowedReadOnlyCommand("env LD_PRELOAD=/tmp/evil.so ls")).toBe(false);
		});

		it("rejects a path'd command name (absolute, relative, or subdir)", () => {
			expect(isAllowedReadOnlyCommand("/tmp/evil/ls")).toBe(false);
			expect(isAllowedReadOnlyCommand("./evil")).toBe(false);
			expect(isAllowedReadOnlyCommand("../evil ls")).toBe(false);
			expect(isAllowedReadOnlyCommand("bin/x")).toBe(false);
		});

		it("rejects backslash-escape and command-dispatch prefixes", () => {
			expect(isAllowedReadOnlyCommand("\\ls")).toBe(false);
			expect(isAllowedReadOnlyCommand("env ls")).toBe(false);
			expect(isAllowedReadOnlyCommand("command ls")).toBe(false);
			expect(isAllowedReadOnlyCommand("exec ls")).toBe(false);
			expect(isAllowedReadOnlyCommand("builtin pwd")).toBe(false);
		});

		it("still allows `=` and `/` when they are in ARGUMENTS, not the head", () => {
			// The prefix check only inspects the first token (the command name).
			expect(isAllowedReadOnlyCommand("cat /etc/hosts")).toBe(true);
			expect(isAllowedReadOnlyCommand("grep foo=bar file")).toBe(true);
			expect(isAllowedReadOnlyCommand("git config --get user.name")).toBe(true);
			expect(isAllowedReadOnlyCommand("echo $HOME")).toBe(true);
		});
	});

	// ── Finding 2: mutation-capable git subcommands restricted to listing ────
	// Bare `git branch`/`git tag`/`git remote` allowlist entries used to
	// prefix-match ref-creating/deleting/remote-rewriting invocations. They are
	// now restricted to their read-only listing forms.
	describe("git branch/tag/remote restricted to read-only forms (finding 2)", () => {
		it("blocks ref-creating / deleting / moving git branch and git tag", () => {
			expect(isAllowedReadOnlyCommand("git tag newtag")).toBe(false);
			expect(isAllowedReadOnlyCommand("git branch newbranch")).toBe(false);
			expect(isAllowedReadOnlyCommand("git branch -D main")).toBe(false);
			expect(isAllowedReadOnlyCommand("git branch -d feature")).toBe(false);
			expect(isAllowedReadOnlyCommand("git tag -d v1.0")).toBe(false);
			expect(isAllowedReadOnlyCommand("git branch -m old new")).toBe(false);
			expect(isAllowedReadOnlyCommand("git branch --set-upstream-to=origin/main")).toBe(false);
			expect(isAllowedReadOnlyCommand("git tag -a v1 -m msg")).toBe(false);
		});

		it("blocks remote-rewriting git remote subcommands", () => {
			expect(isAllowedReadOnlyCommand("git remote add evil https://attacker.example/r.git")).toBe(false);
			expect(isAllowedReadOnlyCommand("git remote remove origin")).toBe(false);
			expect(isAllowedReadOnlyCommand("git remote rename a b")).toBe(false);
			expect(isAllowedReadOnlyCommand("git remote set-url origin https://attacker.example")).toBe(false);
			expect(isAllowedReadOnlyCommand("git remote prune origin")).toBe(false);
		});

		it("allows read-only listing forms", () => {
			expect(isAllowedReadOnlyCommand("git branch")).toBe(true);
			expect(isAllowedReadOnlyCommand("git branch -a")).toBe(true);
			expect(isAllowedReadOnlyCommand("git branch -vv")).toBe(true);
			expect(isAllowedReadOnlyCommand("git branch --list")).toBe(true);
			expect(isAllowedReadOnlyCommand("git tag")).toBe(true);
			expect(isAllowedReadOnlyCommand("git tag -l")).toBe(true);
			expect(isAllowedReadOnlyCommand("git tag --list")).toBe(true);
			expect(isAllowedReadOnlyCommand("git remote")).toBe(true);
			expect(isAllowedReadOnlyCommand("git remote -v")).toBe(true);
			expect(isAllowedReadOnlyCommand("git remote show origin")).toBe(true);
			expect(isAllowedReadOnlyCommand("git remote get-url origin")).toBe(true);
		});
	});

	describe("disallowed constructs are rejected outright", () => {
		it("rejects command substitution $(...) and backticks", () => {
			expect(isAllowedReadOnlyCommand("$(git log)")).toBe(false);
			expect(isAllowedReadOnlyCommand("`git status`")).toBe(false);
			expect(isAllowedReadOnlyCommand("cat $(git rev-parse HEAD)")).toBe(false);
			expect(isAllowedReadOnlyCommand("git log $(cat file)")).toBe(false);
			// Mutating outer command with a trailing substitution — rejected.
			expect(isAllowedReadOnlyCommand("rm -rf ./build $(git log)")).toBe(false);
			expect(isAllowedReadOnlyCommand("rm `cat foobar`")).toBe(false);
			expect(isAllowedReadOnlyCommand("git push origin +main $(ls)")).toBe(false);
			// Mutating inner — rejected.
			expect(isAllowedReadOnlyCommand("cat $(rm x)")).toBe(false);
			expect(isAllowedReadOnlyCommand("echo $(git push)")).toBe(false);
			// Unbalanced substitution — still rejected (contains `(` / backtick).
			expect(isAllowedReadOnlyCommand("cat $(git log")).toBe(false);
			expect(isAllowedReadOnlyCommand("cat `git log")).toBe(false);
		});

		it("rejects process substitution <(...) and >(...)", () => {
			expect(isAllowedReadOnlyCommand("diff <(git log) <(git status)")).toBe(false);
			expect(isAllowedReadOnlyCommand("diff <(git log) <(rm -rf /tmp/x)")).toBe(false);
			expect(isAllowedReadOnlyCommand("cat foo >(tee /tmp/pwned)")).toBe(false);
			expect(isAllowedReadOnlyCommand("echo hi >(bash -c 'rm -rf /')")).toBe(false);
		});

		it("rejects subshell grouping and arithmetic parentheses", () => {
			expect(isAllowedReadOnlyCommand("(git status)")).toBe(false);
			expect(isAllowedReadOnlyCommand("echo $((1 + 1))")).toBe(false);
		});

		it("rejects all output/input redirection", () => {
			expect(isAllowedReadOnlyCommand("cat f > out.txt")).toBe(false);
			expect(isAllowedReadOnlyCommand("cat f >> out.txt")).toBe(false);
			expect(isAllowedReadOnlyCommand("echo hi &> out.txt")).toBe(false);
			expect(isAllowedReadOnlyCommand("cat 2> err.txt")).toBe(false);
			// Input redirection / here-strings / here-docs are rejected too
			// (fail-closed — `<` also introduces `<(` and `<<<`).
			expect(isAllowedReadOnlyCommand("cat < in.txt")).toBe(false);
			expect(isAllowedReadOnlyCommand("cat <<< 'here string'")).toBe(false);
		});

		it("rejects backgrounding and stderr-pipe & (but not the && operator)", () => {
			expect(isAllowedReadOnlyCommand("git log &")).toBe(false);
			expect(isAllowedReadOnlyCommand("cat f |& grep x")).toBe(false);
			// Control: `&&` is a permitted operator, not a background `&`.
			expect(isAllowedReadOnlyCommand("git log && git status")).toBe(true);
		});

		it("rejects ANSI-C $'...' quoting (and the $$' PID-expansion form)", () => {
			expect(isAllowedReadOnlyCommand("echo $'a\\tb'")).toBe(false);
			expect(isAllowedReadOnlyCommand("grep $'\\t' file")).toBe(false);
			expect(isAllowedReadOnlyCommand("echo $$'plain'")).toBe(false);
		});

		it("rejects brace parameter expansion (dollar-brace) (finding 3)", () => {
			// The `$` and `{` are concatenated so the source contains no literal
			// `${` (which biome's noTemplateCurlyInString would flag); the runtime
			// strings are exactly `echo ${x}`, `echo ${HOME}`, etc.
			const D = "$";
			expect(isAllowedReadOnlyCommand(`echo ${D}{x}`)).toBe(false);
			expect(isAllowedReadOnlyCommand(`echo ${D}{HOME}`)).toBe(false);
			expect(isAllowedReadOnlyCommand(`echo ${D}{x@P}`)).toBe(false);
			// Nested $(...) inside the expansion is independently caught by the
			// paren ban too, but the ${ opener rejects it first regardless.
			expect(isAllowedReadOnlyCommand(`cat ${D}{FILE:-${D}(rm x)}`)).toBe(false);
			// Plain `$VAR` (no brace) remains allowed.
			expect(isAllowedReadOnlyCommand("echo $HOME")).toBe(true);
		});

		it("rejects embedded newlines (multiple commands / here-docs)", () => {
			expect(isAllowedReadOnlyCommand("git log\nrm -rf x")).toBe(false);
			expect(isAllowedReadOnlyCommand("git log\n")).toBe(false);
		});
	});

	// ── Round-6 regression PoCs ─────────────────────────────────────────────
	// These previously bypassed the gate by hiding a `$'...'` / chained command
	// inside a double-quoted `$(...)`. Under B1 they are rejected structurally
	// (they all contain `$(` / `(` / `>`), with no quote-parsing required.
	describe("round-6 nested-substitution PoCs are rejected", () => {
		it("blocks $'...' nested in a double-quoted command substitution", () => {
			expect(isAllowedReadOnlyCommand("cat \"$(echo $'a\\'b' > /tmp/mk)\"")).toBe(false);
			expect(isAllowedReadOnlyCommand("cat \"$(git log $'\\'' ; rm -rf /tmp/x)\"")).toBe(false);
		});

		it("blocks a chained command inside a double-quoted command substitution", () => {
			expect(isAllowedReadOnlyCommand('echo "$(echo x ; touch /tmp/marker)"')).toBe(false);
			expect(isAllowedReadOnlyCommand('echo "$(git log ; rm -rf /tmp/x)"')).toBe(false);
		});

		it("blocks the same via backticks and process substitution", () => {
			expect(isAllowedReadOnlyCommand('git log "`echo hi ; touch /tmp/marker`"')).toBe(false);
			expect(isAllowedReadOnlyCommand('cat "$(diff <(rm x) y)"')).toBe(false);
		});
	});

	// ── Accepted over-block trade-off ───────────────────────────────────────
	// B1 rejects some legitimate read-only commands because they use a banned
	// metacharacter (even inside quotes) or a substitution. This is the
	// deliberate cost of the fail-closed design; `/ask off` is the escape hatch.
	describe("accepted over-blocks (fail-closed trade-off)", () => {
		it("rejects otherwise read-only commands that use a substitution", () => {
			expect(isAllowedReadOnlyCommand("git show $(git rev-parse HEAD)")).toBe(false);
			expect(isAllowedReadOnlyCommand('cat "$(git rev-parse HEAD)"')).toBe(false);
			expect(isAllowedReadOnlyCommand("diff <(sort a) <(sort b)")).toBe(false);
		});

		it("rejects quoted metacharacters that would be inert in real bash", () => {
			expect(isAllowedReadOnlyCommand('echo "a > b"')).toBe(false);
			expect(isAllowedReadOnlyCommand("echo 'a > b'")).toBe(false);
			expect(isAllowedReadOnlyCommand("grep '<(' file")).toBe(false);
			expect(isAllowedReadOnlyCommand('echo "a $\'b"')).toBe(false);
			expect(isAllowedReadOnlyCommand("echo \\$'x'")).toBe(false);
		});
	});

	// Regression tests for mutation-capable allowlist heads via FLAGS. These use
	// no shell metacharacters, so they survive `hasDisallowedConstruct` and are
	// caught by DANGEROUS_ARG_PATTERNS on the matched segment.
	describe("mutation-capable heads and flags", () => {
		it("does not allow sed or awk at all (write/exec escape hatches)", () => {
			expect(isAllowedReadOnlyCommand("sed -i s/a/b/ file.txt")).toBe(false);
			expect(isAllowedReadOnlyCommand("sed s/a/b/ file.txt")).toBe(false);
			// awk / sed are not on the allowlist at all (write/exec escape hatches),
			// so they are rejected regardless of arguments.
			expect(isAllowedReadOnlyCommand("awk 'BEGIN{print}' file")).toBe(false);
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

		// Finding 3: `-s` bundled behind a no-argument flag (`-u`, `-R`) is
		// still the clock-setting `--set`, e.g. getopt parses `-us` as `-u -s`.
		it("blocks date -s bundled behind no-arg short flags", () => {
			expect(isAllowedReadOnlyCommand("date -us2020-01-01")).toBe(false);
			expect(isAllowedReadOnlyCommand("date -us '2020-01-01'")).toBe(false);
			expect(isAllowedReadOnlyCommand("date -Rs2020-01-01")).toBe(false);
			// Read-only clusters/flags without -s remain allowed.
			expect(isAllowedReadOnlyCommand("date -R")).toBe(true);
			expect(isAllowedReadOnlyCommand("date -Iseconds")).toBe(true);
		});

		// Finding 4: getopt_long accepts any unambiguous abbreviation of a long
		// option, so `--o`/`--out` == `--output` and `--s`/`--se` == `--set`.
		it("blocks unambiguous long-option abbreviations of --output / --set", () => {
			expect(isAllowedReadOnlyCommand("sort --o=/tmp/pwn.txt in.txt")).toBe(false);
			expect(isAllowedReadOnlyCommand("sort --ou=/tmp/pwn.txt in.txt")).toBe(false);
			expect(isAllowedReadOnlyCommand("sort --out=/tmp/pwn.txt in.txt")).toBe(false);
			expect(isAllowedReadOnlyCommand("sort --outp=/tmp/pwn.txt in.txt")).toBe(false);
			expect(isAllowedReadOnlyCommand("sort --outpu=/tmp/pwn.txt in.txt")).toBe(false);
			expect(isAllowedReadOnlyCommand("date --se=2020-01-01")).toBe(false);
			expect(isAllowedReadOnlyCommand("date --s=2020-01-01")).toBe(false);
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
