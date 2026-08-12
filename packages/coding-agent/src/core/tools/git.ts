import { spawn } from "node:child_process";
import type { AgentTool } from "@dreb/agent-core";
import { Text } from "@dreb/tui";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

/**
 * Typed, read-only `git` tool.
 *
 * This is the capability-model replacement for running `git` through the shell
 * in read-only Ask mode. Instead of validating an arbitrary command *string*
 * (which is unbounded — see the retired `readonly-commands` gate), this tool:
 *
 *   1. accepts a fixed enum of read-only subcommands plus a typed `args` array,
 *   2. validates every argument token against a per-subcommand allow-list of
 *      safe flags (unknown flags are rejected — fail-closed), and
 *   3. executes via `spawn("git", [...])` with **no shell**, so there is no
 *      word-splitting, quoting, expansion, redirection, or PATH lookup of any
 *      other binary to bypass. The `args` array is passed to git verbatim.
 *
 * The only residual surface is git's own write/exec flags (e.g. `--output`,
 * `-c`, `--exec-path`), which the per-subcommand flag allow-list rejects because
 * they are simply not on any safe list.
 */

const GIT_SUBCOMMANDS = [
	"status",
	"log",
	"diff",
	"show",
	"blame",
	"branch",
	"tag",
	"remote",
	"describe",
	"rev-parse",
	"ls-files",
	"ls-tree",
	"shortlog",
	"config",
] as const;

type GitSubcommand = (typeof GIT_SUBCOMMANDS)[number];

const gitSchema = Type.Object({
	subcommand: Type.Union(
		GIT_SUBCOMMANDS.map((name) => Type.Literal(name)),
		{ description: "Read-only git subcommand to run." },
	),
	args: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Arguments passed verbatim to git (no shell). Only read-only flags are permitted; write/exec flags " +
				"(e.g. --output, -c, --exec-path) and mutating sub-verbs are rejected. Paths/refs after `--` are read-only.",
		}),
	),
});

export type GitToolInput = Static<typeof gitSchema>;

const MAX_ARGS = 64;

/**
 * Global git options that redirect git to another repo/dir or run arbitrary
 * code. These only take effect *before* the subcommand (we place the subcommand
 * ourselves, so a user-supplied copy lands after it and is inert), but we reject
 * them unconditionally as defense-in-depth.
 */
const FORBIDDEN_GLOBAL_OPTION =
	/^(?:-c|-C|--exec-path|--git-dir|--work-tree|--namespace|--config-env|--no-pager)(?:=|$)/;

/**
 * Flags that write a file or run a subprocess even on an otherwise read-only
 * subcommand. Always rejected regardless of subcommand.
 */
const FORBIDDEN_WRITE_FLAG = /^(?:-O|--output|--output-directory|--exec|--open-files-in-pager|--ext-diff)(?:=|$)/;

interface SubcommandSpec {
	/** Flags allowed as-is (exact match). */
	flags: Set<string>;
	/** Flags allowed with an attached value (matched against the whole token). */
	flagPatterns: RegExp[];
	/**
	 * How positional (non-flag) arguments are treated:
	 *   - "read": positionals are refs/paths git only reads (default).
	 *   - "none": no bare positionals allowed (they would create/rename, e.g.
	 *     `git branch <name>` / `git tag <name>`).
	 *   - a validator for the leading positional(s) (used by `remote`).
	 */
	positionals: "read" | "none";
	/** Optional custom validator run before generic flag checks. */
	validate?: (args: string[]) => string | undefined;
}

const LISTING_FLAG_PATTERNS = [
	/^--sort=/,
	/^--format=/,
	/^--contains=/,
	/^--no-contains=/,
	/^--merged=/,
	/^--no-merged=/,
	/^--points-at=/,
	/^--color(?:=.*)?$/,
];

/** `remote` is only read-only when bare, `-v`, or `show`/`get-url <name>`. */
function validateRemote(args: string[]): string | undefined {
	if (args.length === 0) return undefined;
	const [first, ...rest] = args;
	if (first === "-v" || first === "--verbose") {
		return rest.length === 0 ? undefined : `git remote ${first} takes no further arguments`;
	}
	if (first === "show" || first === "get-url") {
		// `git remote show [-n] <name...>` / `git remote get-url [--all] <name>` — read-only.
		for (const tok of rest) {
			if (tok.startsWith("-") && tok !== "-n" && tok !== "--all" && tok !== "--push") {
				return `Flag "${tok}" is not allowed for git remote ${first}`;
			}
		}
		return undefined;
	}
	return `git remote sub-verb "${first}" is not read-only (only bare, -v, show, get-url are allowed)`;
}

const GIT_SPECS: Record<GitSubcommand, SubcommandSpec> = {
	status: {
		flags: new Set(["-s", "--short", "-b", "--branch", "--long", "--porcelain", "--ignored", "-z"]),
		flagPatterns: [/^--porcelain=/, /^--untracked-files(?:=.*)?$/, /^-u.*$/, /^--ignored=/, /^--column(?:=.*)?$/],
		positionals: "read",
	},
	log: {
		flags: new Set([
			"--oneline",
			"--stat",
			"--shortstat",
			"--numstat",
			"--name-only",
			"--name-status",
			"--graph",
			"--decorate",
			"--no-decorate",
			"--abbrev-commit",
			"--no-abbrev-commit",
			"--reverse",
			"--merges",
			"--no-merges",
			"--first-parent",
			"--all",
			"--branches",
			"--tags",
			"--remotes",
			"-p",
			"--patch",
			"--follow",
			"--source",
			"--left-right",
			"--cherry-mark",
		]),
		flagPatterns: [
			/^-\d+$/,
			/^-n\d*$/,
			/^--max-count=/,
			/^--skip=/,
			/^--format=/,
			/^--pretty(?:=.*)?$/,
			/^--date=/,
			/^--decorate=/,
			/^--author=/,
			/^--committer=/,
			/^--grep=/,
			/^--since=/,
			/^--until=/,
			/^--after=/,
			/^--before=/,
			/^--abbrev=/,
			/^-U\d*$/,
			/^--unified=/,
		],
		positionals: "read",
	},
	diff: {
		flags: new Set([
			"--stat",
			"--shortstat",
			"--numstat",
			"--name-only",
			"--name-status",
			"--cached",
			"--staged",
			"-p",
			"--patch",
			"--raw",
			"-w",
			"--ignore-all-space",
			"-b",
			"--ignore-space-change",
			"--find-renames",
			"-M",
			"--find-copies",
			"-C",
			"--no-color",
		]),
		flagPatterns: [/^-U\d*$/, /^--unified=/, /^--color(?:=.*)?$/, /^--diff-filter=/, /^--stat=/],
		positionals: "read",
	},
	show: {
		flags: new Set([
			"--stat",
			"--shortstat",
			"--numstat",
			"--name-only",
			"--name-status",
			"-p",
			"--patch",
			"--oneline",
			"--abbrev-commit",
			"-s",
			"--no-patch",
		]),
		flagPatterns: [/^--format=/, /^--pretty(?:=.*)?$/, /^--date=/, /^-U\d*$/, /^--unified=/, /^--color(?:=.*)?$/],
		positionals: "read",
	},
	blame: {
		flags: new Set([
			"-l",
			"-s",
			"-e",
			"--show-email",
			"-w",
			"-M",
			"-C",
			"-f",
			"--show-name",
			"-n",
			"--show-number",
			"--porcelain",
			"--line-porcelain",
			"-p",
		]),
		flagPatterns: [/^-L/, /^--date=/, /^--since=/, /^--abbrev=/],
		positionals: "read",
	},
	branch: {
		flags: new Set([
			"-a",
			"--all",
			"-r",
			"--remotes",
			"-v",
			"-vv",
			"--verbose",
			"-l",
			"--list",
			"--column",
			"--no-column",
			"-i",
			"--ignore-case",
		]),
		flagPatterns: LISTING_FLAG_PATTERNS,
		positionals: "none",
	},
	tag: {
		flags: new Set(["-l", "--list", "-i", "--ignore-case", "--column", "--no-column"]),
		// `-n<num>` shows N annotation lines (read-only).
		flagPatterns: [/^-n\d*$/, ...LISTING_FLAG_PATTERNS],
		positionals: "none",
	},
	remote: {
		flags: new Set(["-v", "--verbose"]),
		flagPatterns: [],
		positionals: "read",
		validate: validateRemote,
	},
	describe: {
		flags: new Set(["--tags", "--all", "--always", "--long", "--contains", "--dirty", "--broken", "--first-parent"]),
		flagPatterns: [/^--match=/, /^--exclude=/, /^--abbrev=/, /^--candidates=/, /^--dirty=/, /^--broken=/],
		positionals: "read",
	},
	"rev-parse": {
		flags: new Set([
			"--abbrev-ref",
			"--short",
			"--symbolic",
			"--symbolic-full-name",
			"--all",
			"--branches",
			"--tags",
			"--remotes",
			"--show-toplevel",
			"--show-prefix",
			"--show-cdup",
			"--git-dir",
			"--absolute-git-dir",
			"--is-inside-work-tree",
			"--is-inside-git-dir",
			"--is-bare-repository",
			"--verify",
			"--quiet",
			"-q",
			"HEAD",
		]),
		flagPatterns: [/^--short=/, /^--abbrev-ref=/, /^--default=/],
		positionals: "read",
	},
	"ls-files": {
		flags: new Set([
			"--cached",
			"--deleted",
			"--modified",
			"--others",
			"--ignored",
			"--stage",
			"-s",
			"--unmerged",
			"--full-name",
			"-z",
			"--exclude-standard",
			"-t",
			"-c",
			"-m",
			"-o",
			"-d",
		]),
		flagPatterns: [/^--exclude=/, /^--format=/, /^--abbrev=/],
		positionals: "read",
	},
	"ls-tree": {
		flags: new Set([
			"-r",
			"-d",
			"-t",
			"-l",
			"--long",
			"--name-only",
			"--name-status",
			"--full-name",
			"--full-tree",
			"-z",
			"--abbrev",
		]),
		flagPatterns: [/^--abbrev=/, /^--format=/],
		positionals: "read",
	},
	shortlog: {
		flags: new Set([
			"-n",
			"--numbered",
			"-s",
			"--summary",
			"-e",
			"--email",
			"--all",
			"--branches",
			"--tags",
			"--remotes",
			"--no-merges",
		]),
		flagPatterns: [/^--format=/, /^--since=/, /^--until=/, /^--author=/, /^--group=/, /^-w\d*/, /^-\d+$/],
		positionals: "read",
	},
	config: {
		flags: new Set([
			"--get",
			"--get-all",
			"--get-regexp",
			"--get-urlmatch",
			"--list",
			"-l",
			"--name-only",
			"--null",
			"-z",
			"--global",
			"--local",
			"--system",
			"--worktree",
			"--show-origin",
			"--show-scope",
			"--includes",
		]),
		flagPatterns: [/^--get-color=/, /^--type=/],
		positionals: "read",
		validate: (args) => {
			// `git config` is read-only ONLY in explicit get/list forms. Any other
			// invocation (setting a value, --unset, --edit, --add, etc.) mutates.
			const READ_FORMS = new Set([
				"--get",
				"--get-all",
				"--get-regexp",
				"--get-urlmatch",
				"--list",
				"-l",
				"--get-color",
			]);
			const hasReadForm = args.some((a) => READ_FORMS.has(a) || a.startsWith("--get-color="));
			if (!hasReadForm) {
				return "git config is only allowed in read forms (--get, --get-all, --get-regexp, --list). Setting values is blocked.";
			}
			return undefined;
		},
	},
};

/**
 * Validate a subcommand's argument list against its spec. Returns an error
 * message string if any token is disallowed, or `undefined` if the whole list
 * is read-only-safe. Everything after a bare `--` is treated as read-only
 * positionals (paths/refs git only reads).
 */
export function validateGitArgs(subcommand: GitSubcommand, args: string[]): string | undefined {
	if (args.length > MAX_ARGS) return `Too many git arguments (max ${MAX_ARGS}).`;
	const spec = GIT_SPECS[subcommand];
	if (!spec) return `Subcommand "${subcommand}" is not a supported read-only git command.`;

	if (spec.validate) {
		const err = spec.validate(args);
		if (err) return err;
	}

	let sawDoubleDash = false;
	for (const rawToken of args) {
		if (sawDoubleDash) continue; // post-`--` tokens are read-only pathspecs
		if (rawToken === "--") {
			sawDoubleDash = true;
			continue;
		}
		if (FORBIDDEN_GLOBAL_OPTION.test(rawToken)) {
			return `Global git option "${rawToken}" is not allowed in read-only mode.`;
		}
		if (FORBIDDEN_WRITE_FLAG.test(rawToken)) {
			return `Flag "${rawToken}" can write files and is not allowed in read-only mode.`;
		}
		if (!rawToken.startsWith("-")) {
			// Bare positional (ref/path). For subcommands where a positional would
			// create or rename (branch/tag), reject it.
			if (spec.positionals === "none") {
				return `git ${subcommand} does not accept the positional argument "${rawToken}" in read-only mode (it could create or modify a ${subcommand}). Use listing flags only.`;
			}
			continue;
		}
		if (spec.flags.has(rawToken)) continue;
		if (spec.flagPatterns.some((re) => re.test(rawToken))) continue;
		return `Flag "${rawToken}" is not in the read-only allow-list for git ${subcommand}. Turn off Ask mode (/ask off) to run arbitrary git commands.`;
	}
	return undefined;
}

function gitEnv(): NodeJS.ProcessEnv {
	// Pin a non-interactive, non-paging, no-lock environment. Because stdio is
	// piped (not a TTY) git never pages anyway, but GIT_PAGER=cat is belt-and
	// suspenders against the `core.pager=!shell` escape. GIT_OPTIONAL_LOCKS=0
	// keeps read commands (e.g. status) from writing the index.
	return {
		...process.env,
		GIT_PAGER: "cat",
		PAGER: "cat",
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
	};
}

export interface GitToolDetails {
	subcommand: string;
	exitCode: number | null;
	truncation?: TruncationResult;
}

export function createGitToolDefinition(cwd: string): ToolDefinition<typeof gitSchema, GitToolDetails | undefined> {
	return {
		name: "git",
		label: "git",
		description:
			"Run a read-only git command (log, diff, show, status, blame, branch, tag, remote, describe, rev-parse, " +
			"ls-files, ls-tree, shortlog, config --get). Arguments are passed to git verbatim without a shell — only " +
			"read-only flags are permitted; mutating flags/sub-verbs (commit, checkout, --output, -c, etc.) are blocked. " +
			"Use this instead of `bash git ...` when you only need to inspect repository state.",
		promptSnippet: "Run read-only git commands (log/diff/show/status/blame/…)",
		parameters: gitSchema,
		async execute(
			_toolCallId,
			{ subcommand, args }: { subcommand: GitSubcommand; args?: string[] },
			signal?: AbortSignal,
		) {
			const argList = args ?? [];
			const validationError = validateGitArgs(subcommand, argList);
			if (validationError) {
				return {
					content: [{ type: "text" as const, text: `git ${subcommand}: ${validationError}` }],
					details: undefined,
				};
			}

			return new Promise<{
				content: Array<{ type: "text"; text: string }>;
				details: GitToolDetails | undefined;
			}>((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				const child = spawn("git", [subcommand, ...argList], {
					cwd,
					env: gitEnv(),
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stdout = "";
				let stderr = "";
				let aborted = false;
				const onAbort = () => {
					aborted = true;
					if (!child.killed) child.kill();
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				child.stdout?.on("data", (chunk) => {
					stdout += chunk.toString();
				});
				child.stderr?.on("data", (chunk) => {
					stderr += chunk.toString();
				});
				child.on("error", (error) => {
					signal?.removeEventListener("abort", onAbort);
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						reject(new Error("git is not installed or not on PATH"));
						return;
					}
					reject(new Error(`Failed to run git: ${error.message}`));
				});
				child.on("close", (code) => {
					signal?.removeEventListener("abort", onAbort);
					if (aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					const combined = stdout || stderr ? `${stdout}${stderr}` : "";
					const raw = combined.length > 0 ? combined : code === 0 ? "(no output)" : `git exited with code ${code}`;
					const truncation = truncateHead(raw, { maxLines: Number.MAX_SAFE_INTEGER });
					let output = truncation.content;
					if (truncation.truncated) {
						output += `\n\n[${formatSize(DEFAULT_MAX_BYTES)} limit reached — refine the git command]`;
					}
					const details: GitToolDetails = {
						subcommand,
						exitCode: code,
						...(truncation.truncated ? { truncation } : {}),
					};
					resolve({ content: [{ type: "text" as const, text: output }], details });
				});
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0, undefined, true);
			text.setText(formatGitCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0, undefined, true);
			text.setText(formatGitResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

function formatGitCall(
	args: { subcommand?: string; args?: string[] } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const subcommand = str(args?.subcommand);
	const invalidArg = invalidArgText(theme);
	const rest = Array.isArray(args?.args) ? args.args.join(" ") : "";
	let text = theme.fg("toolTitle", theme.bold("git")) + " ";
	text += subcommand === null ? invalidArg : theme.fg("accent", subcommand);
	if (rest) text += theme.fg("toolOutput", ` ${rest}`);
	return text;
}

function formatGitResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GitToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trimEnd();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += theme.fg("muted", `\n... (${remaining} more lines)`);
		}
	}
	return text;
}

export function createGitTool(cwd: string): AgentTool<typeof gitSchema> {
	return wrapToolDefinition(createGitToolDefinition(cwd));
}

/** Default git tool using process.cwd() for backwards compatibility. */
export const gitToolDefinition = createGitToolDefinition(process.cwd());
export const gitTool = createGitTool(process.cwd());
