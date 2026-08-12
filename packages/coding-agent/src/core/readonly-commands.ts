/**
 * Read-only command allowlist — the INVERSE of forbidden-commands.
 *
 * Where forbidden-commands blocks known-dangerous patterns and allows
 * everything else, this module allows ONLY commands that match an explicit
 * allowlist of read-only "heads" and rejects everything else. This is the
 * gatekeeper for dreb's read-only "Ask mode", where the agent must not be
 * able to mutate the filesystem, repository, or environment.
 *
 * A command is allowed only if EVERY shell segment (after subshell and
 * shell-prefix normalization) matches at least one allowlist entry. Entries
 * are space-separated prefixes so subcommands can be matched precisely
 * (`git log` matches `git log --oneline` but bare `git` does not match
 * `git push`). Any output redirection (`>`/`>>`) disqualifies the command
 * because a read-only mode must never write files.
 *
 * ## Security model (why the OUTER command is authoritative)
 *
 * Command substitutions (`$(...)`, `` `...` ``) are handled so the *outer*
 * command head is what gets matched against the allowlist — NOT the inner
 * substitution. Extracting only the inner command (as the forbidden-commands
 * denylist safely does, because there checking the inner can only ADD matches)
 * would be a critical bypass for an allowlist: `rm -rf x $(git log)` must be
 * rejected on the `rm` head, even though `git log` is allowlisted. Each inner
 * substitution is ALSO required to be read-only, so `cat $(git rev-parse HEAD)`
 * is allowed (both `cat` and `git rev-parse` are read-only) while
 * `cat $(rm x)` is rejected (the substitution mutates).
 *
 * A handful of otherwise-read-only heads have built-in write/exec escape
 * hatches (`find -delete`/`-exec`, `sort -o`, `date -s`); these are rejected
 * via DANGEROUS_ARG_PATTERNS. Heads whose *entire purpose* includes trivial
 * mutation/execution (`sed -i`, `sed .../e`, `awk 'system()'`,
 * `awk 'print > f'`) are deliberately NOT on the allowlist at all.
 *
 * The shell normalization (segment splitting, prefix stripping) is shared with
 * forbidden-commands.ts to guarantee identical parsing semantics on both sides
 * of the guard.
 */

import { containsAnsiCQuoting, isEscaped, splitCommandSegments, stripShellPrefixes } from "./forbidden-commands.js";

/**
 * The base set of allowed command "heads". Entries are space-separated
 * prefixes for subcommand-aware matching — e.g. `git log` allows any
 * `git log ...` invocation but not `git push`.
 *
 * This list is intentionally conservative: only commands that read state
 * without mutating the filesystem, repository, or environment. Commands with
 * trivial write/exec escape hatches that cannot be neutralized by a simple
 * flag guard (`sed`, `awk`) are intentionally excluded.
 */
export const DEFAULT_READONLY_ALLOWLIST: string[] = [
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"rg",
	"grep",
	"find",
	"pwd",
	"echo",
	"which",
	"file",
	"stat",
	"tree",
	"sort",
	"uniq",
	"cut",
	"diff",
	"date",
	// git read-only subcommands
	"git log",
	"git diff",
	"git show",
	"git blame",
	"git status",
	"git branch",
	"git remote",
	"git tag",
	"git describe",
	"git rev-parse",
	"git ls-files",
	"git ls-tree",
	"git config --get",
	// gh read-only subcommands
	"gh pr view",
	"gh pr list",
	"gh issue view",
	"gh issue list",
	"gh repo view",
];

/**
 * Per-head flag/argument patterns that turn an otherwise read-only command
 * into a filesystem/state mutation. Keyed by the command's first word (the
 * allowlist entry's head). If any pattern matches the normalized segment, the
 * command is rejected even though its head is allowlisted.
 *
 * Examples blocked: `find . -delete`, `find . -exec rm {} \;`,
 * `sort -o out.txt in.txt`, `date -s '2020-01-01'`.
 */
const DANGEROUS_ARG_PATTERNS: Record<string, RegExp[]> = {
	find: [
		/(?:^|\s)-delete(?:\s|$)/,
		/(?:^|\s)-exec(?:dir)?(?:\s|$)/,
		/(?:^|\s)-ok(?:dir)?(?:\s|$)/,
		/(?:^|\s)-f(?:print|printf|print0|ls)(?:\s|$)/,
	],
	// `-o`/`--output` write to a file. Match `-o` anywhere in a short-flag
	// cluster (`-o`, `-ro`) and in attached-value form (`-oFILE`) — a plain
	// `/(?:^|\s)-o(?:\s|$)/` would miss `sort -ro out.txt` / `sort -oout.txt`.
	// Only `-o` among sort's short flags takes/writes a file, so matching any
	// short cluster containing `o` is precise here. The long form matches any
	// unambiguous getopt_long abbreviation of `--output` (`--o`, `--out`, …),
	// since `output` is sort's only long option beginning with `o`.
	sort: [/(?:^|\s)-[a-zA-Z]*o/, /(?:^|\s)--o(?:u(?:t(?:p(?:u(?:t)?)?)?)?)?(?:=|\s|$)/],
	// `-s`/`--set` change the system clock. `-s` takes an argument, so in a
	// short-flag cluster it can only follow no-argument flags (`-u` utc, `-R`
	// rfc-email); match `-[uR]*s` to catch `-s`, `-us`, `-Rs`, and attached
	// `-s2020`/`-us2020` forms. This deliberately excludes `-I` (which absorbs
	// the rest of the token as its optional TIMESPEC), so read-only
	// `date -Iseconds` is NOT matched. The long form matches any unambiguous
	// abbreviation of `--set` (`--s`, `--se`), `set` being date's only long
	// option beginning with `s`.
	date: [/(?:^|\s)-[uR]*s/, /(?:^|\s)--s(?:e(?:t)?)?(?:=|\s|$)/],
};

/**
 * Walk `command` maintaining bash-accurate, escape-aware quote state and
 * return true as soon as `detect` fires at a position OUTSIDE any active
 * quote. Shared by the redirection and process-substitution scanners so both
 * agree on exactly which characters are quoted.
 *
 * Escape handling mirrors `maskQuotedContent`/`isEscaped` in
 * forbidden-commands.ts: a backslash-escaped `\"`/`\'` is a literal character,
 * NOT a quote delimiter. Getting this wrong fails OPEN — a single stray `\"`
 * would otherwise flip the scanner "inside quotes" for the rest of the string
 * and hide a real, live `>` or `<(` from detection.
 *
 * This scanner models plain `'...'` and `"..."` only. It does NOT try to model
 * bash ANSI-C `$'...'` quoting: `isAllowedReadOnlyCommand` rejects any command
 * containing `$'` outright (via `containsAnsiCQuoting`) BEFORE this scanner
 * runs, so a `$'...'` never reaches it.
 */
function scanOutsideQuotes(command: string, detect: (ch: string, i: number, cmd: string) => boolean): boolean {
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "'" && !inDouble) {
			// Bash performs no escaping inside single quotes, so a `'` always
			// closes. Outside any quote, a backslash-escaped `\'` is literal and
			// must NOT open a single-quoted region.
			if (inSingle) inSingle = false;
			else if (!isEscaped(command, i)) inSingle = true;
		} else if (ch === '"' && !inSingle) {
			// A backslash-escaped `\"` is a literal quote, not a delimiter.
			if (!isEscaped(command, i)) inDouble = !inDouble;
		} else if (!inSingle && !inDouble && detect(ch, i, command)) {
			return true;
		}
	}

	return false;
}

/**
 * Detect output redirection (`>` or `>>`) outside of quoted strings.
 *
 * A read-only mode must never write files, so any output redirect
 * disqualifies the command. Input redirection (`<`) is fine because it
 * only reads. Quoted content is ignored so `echo "a > b"` is not treated
 * as a redirect, and escaped quotes are honored (see `scanOutsideQuotes`).
 *
 * This is applied per-segment AND to each extracted command substitution
 * (see `isSegmentAllowed`), so a `>` hidden inside a double-quoted
 * substitution — `cat "$(echo hi > f)"`, where the outer `"` would otherwise
 * mask the `>` from a single top-level scan — is still caught once the inner
 * `echo hi > f` is checked on its own (the surrounding quote is gone there).
 */
function hasOutputRedirection(command: string): boolean {
	return scanOutsideQuotes(command, (ch) => ch === ">");
}

/**
 * Detect bash process substitution (`<(cmd)` or `>(cmd)`) outside of quotes.
 *
 * Process substitution runs `cmd` in a subshell UNCONDITIONALLY when the shell
 * parses the token — regardless of whether the outer command ever reads the
 * resulting FIFO — so `diff <(git log) <(rm -rf x)` executes `rm` even though
 * the outer head (`diff`) is allowlisted. A read-only mode has no legitimate
 * use for process substitution, so any occurrence is rejected outright.
 *
 * The scan is quote-aware (including escaped quotes): a literal `"<(x)"` /
 * `'<(x)'` is inert text and is NOT flagged. Applied per-segment and to each
 * extracted substitution (via `isSegmentAllowed`), so process substitution
 * nested inside a quoted `$(...)` — which bash still executes — is caught when
 * the inner is checked.
 */
function hasProcessSubstitution(command: string): boolean {
	return scanOutsideQuotes(command, (ch, i, cmd) => (ch === "<" || ch === ">") && cmd[i + 1] === "(");
}

/**
 * Check whether a normalized segment matches an allowlist entry.
 *
 * A match requires the segment to equal the entry exactly, or to start with
 * the entry followed by whitespace (so `git log` matches `git log --oneline`
 * but not `git logfoo`, and `cat` matches `cat file` but not `category`).
 */
function segmentMatchesEntry(segment: string, entry: string): boolean {
	if (segment === entry) return true;
	if (segment.startsWith(entry)) {
		const next = segment[entry.length];
		return next === " " || next === "\t";
	}
	return false;
}

/**
 * Split a segment into its outer text (with every command substitution
 * replaced by a single space) plus the list of inner substitution commands.
 *
 * Handles balanced `$( ... )` (including nesting) and `` `...` `` backticks.
 * Returns `null` if a substitution is unbalanced, which the caller treats as
 * a rejection — a read-only guard must fail CLOSED on anything it cannot parse.
 */
function splitSubstitutions(segment: string): { outer: string; inners: string[] } | null {
	let outer = "";
	const inners: string[] = [];
	let i = 0;
	const n = segment.length;

	while (i < n) {
		const ch = segment[i];
		if (ch === "$" && segment[i + 1] === "(") {
			// Find the matching close paren, honoring nested `$( ... )`.
			let depth = 1;
			let j = i + 2;
			while (j < n && depth > 0) {
				if (segment[j] === "(") depth++;
				else if (segment[j] === ")") {
					depth--;
					if (depth === 0) break;
				}
				j++;
			}
			if (depth !== 0) return null; // unbalanced → fail closed
			inners.push(segment.slice(i + 2, j).trim());
			outer += " ";
			i = j + 1;
		} else if (ch === "`") {
			let j = i + 1;
			while (j < n && segment[j] !== "`") j++;
			if (j >= n) return null; // unbalanced backtick → fail closed
			inners.push(segment.slice(i + 1, j).trim());
			outer += " ";
			i = j + 1;
		} else {
			outer += ch;
			i++;
		}
	}

	return { outer, inners };
}

/**
 * Whether a single shell segment is an allowed read-only command.
 *
 * The OUTER command head is authoritative: any command substitution is masked
 * before head matching (so `rm ... $(git log)` is judged on `rm`, not
 * `git log`), and every inner substitution must itself be read-only.
 */
function isSegmentAllowed(segment: string, entries: string[]): boolean {
	const trimmed = segment.trim();
	if (trimmed.length === 0) return false;

	// Process substitution executes its inner command unconditionally — reject
	// it in every segment and (via the recursive inner check below) inside any
	// command substitution, including quoted `$(...)` that bash still executes.
	if (hasProcessSubstitution(trimmed)) return false;

	// Output redirection writes a file. Checking it here (not only once on the
	// raw top-level string) means a `>` hidden inside a double-quoted `$(...)`
	// is caught when the extracted inner is evaluated on its own.
	if (hasOutputRedirection(trimmed)) return false;

	// Bare subshell grouping: `(cmd)` runs `cmd` in a subshell — judge the inner.
	// (Command substitutions `$(...)`/`` `...` `` are handled below.)
	if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
		return isSegmentAllowed(trimmed.slice(1, -1), entries);
	}

	const split = splitSubstitutions(trimmed);
	if (!split) return false; // unbalanced substitution → fail closed

	// Every command substitution must itself be a read-only command, otherwise
	// the substitution executes a mutating command as a side effect.
	for (const inner of split.inners) {
		if (inner.length === 0) return false;
		if (!isSegmentAllowed(inner, entries)) return false;
	}

	// The outer command (substitutions masked to spaces) determines the head.
	const normalized = stripShellPrefixes(split.outer).trim();
	if (normalized.length === 0) {
		// Segment was purely command substitution(s), e.g. `$(git log)`.
		// Allowed only because every inner was verified read-only above.
		return split.inners.length > 0;
	}

	const entry = entries.find((e) => segmentMatchesEntry(normalized, e));
	if (!entry) return false;

	// Reject write/exec escape-hatch flags on otherwise-read-only heads.
	const head = entry.split(" ")[0];
	const dangerous = DANGEROUS_ARG_PATTERNS[head];
	if (dangerous?.some((re) => re.test(normalized))) return false;

	return true;
}

/**
 * Check whether a command is allowed under the read-only allowlist.
 *
 * Returns true ONLY if every shell segment is a read-only command after
 * normalization. Empty/whitespace commands, output redirection (`>`/`>>`),
 * unbalanced command substitutions, and any segment whose outer head is not
 * allowlisted (or carries a write/exec flag) return false.
 *
 * @param command The full command string to check.
 * @param allowlist When provided (and an array), REPLACES the default
 *   allowlist entirely — matching the full-replacement override semantics of
 *   settings arrays. When undefined or not an array, the default is used.
 */
export function isAllowedReadOnlyCommand(command: string, allowlist?: string[]): boolean {
	if (typeof command !== "string") return false;
	if (command.trim().length === 0) return false;

	// Reject bash ANSI-C `$'...'` quoting outright, BEFORE any quote-sensitive
	// scan below. It has no legitimate use in a read-only command, and its
	// escaping rules differ from a plain single-quoted string in ways the
	// scanners here deliberately do not model — failing CLOSED on it removes an
	// entire class of quote-desync bypass (a `\'` inside `$'...'` that would
	// otherwise mask a following operator/redirect/process-substitution). This
	// must run first so `hasOutputRedirection`/`hasProcessSubstitution`/
	// `splitCommandSegments` never have to reason about a `$'...'` token.
	if (containsAnsiCQuoting(command)) return false;

	// A read-only mode must never write files — reject output redirection.
	if (hasOutputRedirection(command)) return false;

	// Reject process substitution `<(...)`/`>(...)` — it executes its inner
	// command unconditionally. (Also enforced per-segment/inner below; this
	// top-level check is defense in depth.)
	if (hasProcessSubstitution(command)) return false;

	const entries = Array.isArray(allowlist) ? allowlist : DEFAULT_READONLY_ALLOWLIST;

	const segments = splitCommandSegments(command);
	if (segments.length === 0) return false;

	for (const segment of segments) {
		if (!isSegmentAllowed(segment, entries)) return false;
	}

	return true;
}
