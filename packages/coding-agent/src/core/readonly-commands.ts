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
 *   - brace parameter expansion `${...}`               (the `${` opener)
 *   - backgrounding / stderr piping `&`, `|&`, `&>`    (any `&` not in `&&`)
 *   - newlines (multiple commands / here-documents)
 *
 * Only after that hard reject does it split what remains — a pipeline/list of
 * plain simple commands joined by `|`, `&&`, `||`, `;` — on those operators
 * (quote-aware, but now only plain `'...'`/`"..."` quoting can occur) and
 * require EVERY segment's head to be allowlisted. Because the dangerous
 * constructs are gone, there is nothing left for a quote-desync to hide.
 *
 * Each segment must also survive a leading-prefix check: a segment whose first
 * token is an environment-variable assignment (`VAR=value cmd`), a path'd
 * command name (`/tmp/evil/ls`, `./x`), or a command-dispatch prefix
 * (`env`/`command`/`exec`/`builtin`, or a `\`-escaped head) is REJECTED. bash
 * honors all of these at runtime — `PATH=`/`LD_PRELOAD=`/`GIT_EXTERNAL_DIFF=`
 * assignments and path'd names change which binary executes — but a bare-name
 * allowlist match would look past them, so they are refused rather than
 * normalized away.
 *
 * This is deliberately conservative: legitimate-but-exotic read-only commands
 * such as `git show $(git rev-parse HEAD)`, `diff <(a) <(b)`, or `grep '>' f`
 * are rejected. That is an accepted trade-off for an opt-in exploration mode —
 * `/ask off` returns to normal (default) behavior for those cases.
 *
 * A handful of otherwise-read-only heads have built-in write/exec escape
 * hatches (`find -delete`/`-exec`, `sort -o`, `date -s`); these are rejected
 * via DANGEROUS_ARG_PATTERNS on the matched segment. A few git subcommands
 * (`git branch`/`git tag`/`git remote`) list state read-only in their bare
 * form but mutate with a name argument or write flag; GIT_READONLY_GUARDS
 * restricts them to their listing forms. Heads whose *entire purpose* includes
 * trivial mutation/execution (`sed -i`, `awk 'system()'`) are simply not on
 * the allowlist.
 *
 * The operator splitting is shared with forbidden-commands.ts to keep parsing
 * semantics consistent across the guard.
 */

import { splitCommandSegments } from "./forbidden-commands.js";

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
 * Read-only argument guards for git subcommands whose bare allowlist entry
 * would otherwise prefix-match a mutating invocation (finding 2). `git branch`,
 * `git tag`, and `git remote` all *list* state in their bare form but *mutate*
 * with a name argument or a write flag:
 *   - `git tag newtag` / `git branch newbranch` create refs (no flag needed)
 *   - `git branch -D main` / `git tag -d v1` delete refs
 *   - `git remote add|remove|rename|set-url ...` rewrite remotes
 *
 * Keyed by the FULL matched allowlist entry (not just `git`). Each guard
 * receives the argument tokens after the entry and returns true only for a
 * clearly read-only (listing) invocation. This is deliberately conservative:
 * read-only forms that take a positional value (`git tag -l 'v*'`,
 * `git branch --contains HEAD`) are over-blocked; `/ask off` is the escape
 * hatch.
 */
const READONLY_BRANCH_TAG_FLAGS = new Set([
	"-a",
	"--all",
	"-r",
	"--remotes",
	"-v",
	"-vv",
	"-vvv",
	"--verbose",
	"-l",
	"--list",
	"-i",
	"--ignore-case",
	"-n",
	"--show-current",
	"--merged",
	"--no-merged",
	"--color",
	"--no-color",
	"--column",
	"--no-column",
	"--omit-empty",
]);

function isReadOnlyBranchTagToken(token: string): boolean {
	if (READONLY_BRANCH_TAG_FLAGS.has(token)) return true;
	// Attached-value read-only listing/formatting flags (`--sort=…`,
	// `--format=…`, `--contains=…`, `--points-at=…`). Separate-value forms are
	// over-blocked (their value is a bare positional → rejected).
	if (/^--(?:sort|format|contains|no-contains|points-at)=/.test(token)) return true;
	return false;
}

const GIT_READONLY_GUARDS: Record<string, (args: string[]) => boolean> = {
	// Only flag-form listing invocations; any bare positional (a ref NAME →
	// create) or mutating flag (`-d`/`-D`/`-m`/`-c`/`-f`/…) is rejected.
	"git branch": (args) => args.every(isReadOnlyBranchTagToken),
	"git tag": (args) => args.every(isReadOnlyBranchTagToken),
	// Bare (`git remote`), verbose list (`git remote -v`), and the read-only
	// sub-verbs `show`/`get-url`. Everything else (`add`/`remove`/`rm`/
	// `rename`/`set-url`/`set-head`/`set-branches`/`prune`/`update`) mutates.
	"git remote": (args) => {
		if (args.length === 0) return true;
		if (args.every((a) => a === "-v" || a === "--verbose")) return true;
		return args[0] === "show" || args[0] === "get-url";
	},
};

/**
 * Reject a segment whose first token is a security-relevant prefix that bash
 * honors at runtime but that a bare-name allowlist match would look past
 * (finding 1). Operates on the raw (trimmed) segment BEFORE any allowlist
 * matching:
 *   - environment-variable assignment `VAR=value cmd` — bash sets the variable
 *     for the command's own execution, so `PATH=/tmp/evil ls`,
 *     `LD_PRELOAD=/x cat`, `GIT_EXTERNAL_DIFF=/x git diff` run attacker code
 *     while the allowlist would only see `ls`/`cat`/`git diff`.
 *   - a path'd command name `/tmp/evil/ls`, `./x`, `../x`, `bin/x` — the
 *     allowlist matches by bare name, so a path would run an arbitrary binary.
 *   - a `\`-escaped head (`\ls`) or a command-dispatch prefix
 *     (`env`/`command`/`exec`/`builtin`) that re-runs another command, often
 *     with attacker-controllable env/flags.
 *
 * All are unnecessary for read-only exploration and are refused outright rather
 * than normalized away (which is what let them through before).
 */
function hasDangerousLeadingPrefix(segment: string): boolean {
	const trimmed = segment.trimStart();
	if (trimmed.startsWith("\\")) return true;

	const firstToken = trimmed.split(/\s+/, 1)[0] ?? "";
	if (firstToken.length === 0) return false;

	// `VAR=value` environment assignment prefix.
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(firstToken)) return true;
	// A path in the command name (absolute, relative, or subdir).
	if (firstToken.includes("/")) return true;
	// Command-dispatch prefixes.
	if (firstToken === "env" || firstToken === "exec" || firstToken === "command" || firstToken === "builtin") {
		return true;
	}

	return false;
}

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
 * `"..."` quoting, `|` `&&` `||` `;` operators, and simple variable / brace-set
 * / glob / tilde expansion (`$VAR`, `{a,b}`, `*`, `~`) — none of which execute
 * a command or redirect on their own. Note `${...}` is NOT in this set; it is
 * rejected above.
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
		// Brace parameter expansion `${...}` — banned per the approved plan.
		// `${VAR}` is inert, but transformation forms (`${x@P}` prompt expansion
		// executes embedded substitutions) and future syntax make it safer to
		// refuse the whole construct; read-only exploration does not need it.
		if (ch === "$" && command[i + 1] === "{") return true;
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
 * segment contains no substitution, redirection, subshell, ANSI-C/brace
 * expansion, or backgrounding — so it is a plain `head args...` command
 * (possibly with `$VAR`/glob/tilde expansion and plain quotes). The segment
 * must (1) not carry a dangerous leading prefix (env-assignment / path'd name /
 * dispatch prefix), (2) have an allowlisted head, (3) pass any git read-only
 * guard for that head, and (4) not carry a write/exec escape-hatch flag.
 */
function isSimpleSegmentAllowed(segment: string, entries: string[]): boolean {
	const normalized = segment.trim();
	if (normalized.length === 0) return false;

	// Finding 1: refuse env-assignment / path'd / dispatch prefixes that bash
	// honors at runtime but a bare-name allowlist match would look past.
	if (hasDangerousLeadingPrefix(normalized)) return false;

	const entry = entries.find((e) => segmentMatchesEntry(normalized, e));
	if (!entry) return false;

	// Finding 2: restrict mutation-capable git subcommands to listing forms.
	const gitGuard = GIT_READONLY_GUARDS[entry];
	if (gitGuard) {
		const rest = normalized.slice(entry.length).trim();
		const args = rest.length === 0 ? [] : rest.split(/\s+/);
		if (!gitGuard(args)) return false;
	}

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
 * redirection/substitution/subshell/ANSI-C/brace-expansion/backgrounding
 * construct, a segment carrying a dangerous leading prefix (env-assignment /
 * path'd command name / dispatch prefix), a mutating git subcommand, and any
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
