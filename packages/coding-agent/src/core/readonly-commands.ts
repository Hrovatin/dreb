/**
 * Read-only command allowlist — the INVERSE of forbidden-commands.
 *
 * Where forbidden-commands blocks known-dangerous patterns and allows
 * everything else, this module allows ONLY commands that match an explicit
 * allowlist of read-only "heads" and rejects everything else. This is the
 * gatekeeper for dreb's read-only "Ask mode", where the agent must not be
 * able to mutate the filesystem, repository, or environment.
 *
 * ## Design: fail-closed by restriction (not by tokenizing bash)
 *
 * Earlier iterations tried to *understand* arbitrary bash — masking quotes,
 * splitting on operators, and recursively validating command substitutions —
 * so that constructs like `cat $(git rev-parse HEAD)` could be allowed while
 * `cat $(rm x)` was rejected. Faithfully re-implementing bash's word-splitting
 * and quoting grammar proved to be an unbounded rabbit hole: every round of
 * hardening, a new quoting/substitution corner (ANSI-C `$'...'`, `$$'` PID
 * expansion, `$'` nested inside a double-quoted `$(...)`, chained `;` inside a
 * quoted substitution, …) desynced the hand-rolled scanner and re-opened a
 * bypass. A guard that must be *perfect* to be *safe* is the wrong shape.
 *
 * So this gate no longer tries to safely parse those constructs — it REFUSES
 * them. `isAllowedReadOnlyCommand` first rejects, on the raw string and
 * quote-UNAWARE, any command containing a construct that can execute a command,
 * redirect I/O, or that the simple operator-splitter cannot reason about:
 *
 *   - command substitution `$(...)` / `` `...` ``  (any `(` `)` or backtick)
 *   - process substitution `<(...)` / `>(...)`      (the `(`, plus `<`/`>`)
 *   - subshell grouping `( ... )` and arithmetic `$(( ... ))`  (the parens)
 *   - ANY redirection `>` `>>` `<` `<<` `<<<` `&>` `2>`  (any `>` or `<`)
 *   - ANSI-C quoting `$'...'`                          (the `$'` opener)
 *   - backgrounding / stderr piping `&`, `|&`, `&>`    (any `&` not in `&&`)
 *   - newlines (multiple commands / here-documents)
 *
 * Only after that hard reject does it split what remains — a pipeline/list of
 * plain simple commands joined by `|`, `&&`, `||`, `;` — on those operators
 * (quote-aware, but now only plain `'...'`/`"..."` quoting can occur) and
 * require EVERY segment's head to be allowlisted. Because the dangerous
 * constructs are gone, there is nothing left for a quote-desync to hide.
 *
 * This is deliberately conservative: legitimate-but-exotic read-only commands
 * such as `git show $(git rev-parse HEAD)`, `diff <(a) <(b)`, or `grep '>' f`
 * are rejected. That is an accepted trade-off for an opt-in exploration mode —
 * `/ask off` returns to normal (default) behavior for those cases.
 *
 * A handful of otherwise-read-only heads have built-in write/exec escape
 * hatches (`find -delete`/`-exec`, `sort -o`, `date -s`); these are rejected
 * via DANGEROUS_ARG_PATTERNS on the matched segment. Heads whose *entire
 * purpose* includes trivial mutation/execution (`sed -i`, `awk 'system()'`)
 * are simply not on the allowlist.
 *
 * The operator splitting and shell-prefix normalization are shared with
 * forbidden-commands.ts to keep parsing semantics consistent across the guard.
 */

import { splitCommandSegments, stripShellPrefixes } from "./forbidden-commands.js";

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
 * These cover mutation via FLAGS, which survive the construct reject above
 * (they use no shell metacharacters). Examples blocked: `find . -delete`,
 * `find . -exec rm {} \;`, `sort -o out.txt in.txt`, `date -s '2020-01-01'`.
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
 * Reject — quote-UNAWARE, on the raw string — any command containing a shell
 * construct that can execute a command, redirect I/O, or that the simple
 * operator-splitter cannot safely tokenize. This is the heart of the
 * fail-closed-by-restriction design (see the module doc): rather than parse
 * these constructs correctly (a repeatedly-bypassed approach), read-only mode
 * refuses them outright.
 *
 * The scan is intentionally NOT quote-aware: even a metacharacter that would be
 * inert inside quotes (`grep '>' f`, `echo "a|b"` … well, `|` is allowed, but
 * `echo "a>b"`) causes rejection. That over-blocks some legitimate commands,
 * which is the accepted trade-off — it means NO quoting subtlety can smuggle a
 * dangerous construct past this check. `/ask off` is the escape hatch.
 *
 * Allowed to remain (handled by the later operator split): plain `'...'` /
 * `"..."` quoting, `|` `&&` `||` `;` operators, variable/brace/glob/tilde
 * expansion (`$VAR`, `${VAR}`, `{a,b}`, `*`, `~`) — none of which execute a
 * command or redirect on their own.
 */
function hasDisallowedConstruct(command: string): boolean {
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (
			ch === "(" || // $(...), <(...), >(...), (subshell), $(( arithmetic ))
			ch === ")" ||
			ch === "`" || // `...` command substitution
			ch === ">" || // > >> &> >( 2> — any output redirection / output procsub
			ch === "<" || // < << <<< <( — any input redirection / here-doc / procsub
			ch === "\n" ||
			ch === "\r" // newline: multiple commands / here-documents
		) {
			return true;
		}
		// ANSI-C quoting `$'...'` — its C-escape rules (`\'`, `\n`, `\x27`)
		// differ from a plain single-quoted string and cannot be modeled by the
		// operator-splitter's quote masker.
		if (ch === "$" && command[i + 1] === "'") return true;
	}

	// Backgrounding `&`, stderr pipe `|&`, and `&>` all use a `&` that is not
	// part of the `&&` operator. Strip every `&&` pair, then any surviving `&`
	// is a disallowed background/redirect operator.
	if (command.replace(/&&/g, "").includes("&")) return true;

	return false;
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
 * Whether a single simple command segment is an allowed read-only command.
 *
 * By the time this runs, `hasDisallowedConstruct` has already guaranteed the
 * segment contains no substitution, redirection, subshell, ANSI-C quoting, or
 * backgrounding — so it is a plain `head args...` command (possibly with
 * variable/brace/glob expansion and plain quotes). The head must be allowlisted
 * and must not carry a write/exec escape-hatch flag.
 */
function isSimpleSegmentAllowed(segment: string, entries: string[]): boolean {
	const normalized = stripShellPrefixes(segment).trim();
	if (normalized.length === 0) return false;

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
 * Returns true ONLY if (1) the command contains none of the disallowed shell
 * constructs (`hasDisallowedConstruct`), and (2) every operator-split segment
 * is a plain, allowlisted read-only command. Empty/whitespace commands, any
 * redirection/substitution/subshell/ANSI-C/backgrounding construct, and any
 * segment whose head is not allowlisted (or carries a write/exec flag) return
 * false.
 *
 * @param command The full command string to check.
 * @param allowlist When provided (and an array), REPLACES the default
 *   allowlist entirely — matching the full-replacement override semantics of
 *   settings arrays. When undefined or not an array, the default is used.
 */
export function isAllowedReadOnlyCommand(command: string, allowlist?: string[]): boolean {
	if (typeof command !== "string") return false;
	if (command.trim().length === 0) return false;

	// Fail-closed reject of every construct that can execute/redirect or that
	// the operator-splitter cannot safely tokenize. This single check removes
	// the entire class of quote-desync / nested-substitution bypasses that a
	// quote-aware parser repeatedly failed to close (see the module doc).
	if (hasDisallowedConstruct(command)) return false;

	const entries = Array.isArray(allowlist) ? allowlist : DEFAULT_READONLY_ALLOWLIST;

	// What remains is a pipeline/list of plain simple commands. Split on
	// `|`/`&&`/`||`/`;` (quote-aware; only plain quoting can occur now) and
	// require every segment to be an allowlisted read-only command.
	const segments = splitCommandSegments(command);
	if (segments.length === 0) return false;

	for (const segment of segments) {
		if (!isSimpleSegmentAllowed(segment, entries)) return false;
	}

	return true;
}
