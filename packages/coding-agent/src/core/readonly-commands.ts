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
 * The shell normalization (segment splitting, subshell unwrapping, prefix
 * stripping) is shared with forbidden-commands.ts to guarantee identical
 * parsing semantics on both sides of the guard.
 */

import { splitCommandSegments, stripShellPrefixes, stripSubshellWrapper } from "./forbidden-commands.js";

/**
 * The base set of allowed command "heads". Entries are space-separated
 * prefixes for subcommand-aware matching — e.g. `git log` allows any
 * `git log ...` invocation but not `git push`.
 *
 * This list is intentionally conservative: only commands that read state
 * without mutating the filesystem, repository, or environment.
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
	"sed",
	"awk",
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
 * Detect output redirection (`>` or `>>`) outside of quoted strings.
 *
 * A read-only mode must never write files, so any output redirect
 * disqualifies the command. Input redirection (`<`) is fine because it
 * only reads. Quoted content is ignored so `echo "a > b"` is not treated
 * as a redirect.
 */
function hasOutputRedirection(command: string): boolean {
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
		} else if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
		} else if (ch === ">" && !inSingle && !inDouble) {
			return true;
		}
	}

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
 * Check whether a command is allowed under the read-only allowlist.
 *
 * Returns true ONLY if every shell segment matches at least one allowlist
 * entry after normalization. If any segment is not allowed, returns false.
 * Empty/whitespace commands and commands containing output redirection
 * (`>`/`>>`) return false.
 *
 * @param command The full command string to check.
 * @param allowlist When provided (and an array), REPLACES the default
 *   allowlist entirely — matching the full-replacement override semantics of
 *   settings arrays. When undefined or not an array, the default is used.
 */
export function isAllowedReadOnlyCommand(command: string, allowlist?: string[]): boolean {
	if (typeof command !== "string") return false;
	if (command.trim().length === 0) return false;

	// A read-only mode must never write files — reject output redirection.
	if (hasOutputRedirection(command)) return false;

	const entries = Array.isArray(allowlist) ? allowlist : DEFAULT_READONLY_ALLOWLIST;

	const segments = splitCommandSegments(command);
	if (segments.length === 0) return false;

	for (const segment of segments) {
		// Normalize: unwrap subshells ($(...), (...), `...`) then strip
		// pass-through shell prefixes (env, exec, command, builtin, paths).
		const normalized = stripShellPrefixes(stripSubshellWrapper(segment)).trim();
		if (normalized.length === 0) return false;

		const matched = entries.some((entry) => segmentMatchesEntry(normalized, entry));
		if (!matched) return false;
	}

	return true;
}
