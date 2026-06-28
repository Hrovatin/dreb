---
name: mach6-push
description: "Commit changes, push to remote, and post a progress comment on the associated PR or issue. Stages files by name (never git add -A), matches existing commit style, auto-detects PR from branch. Usage: mach6-push [optional commit message]"
argument-hint: "[commit message]"
---

# mach6-push — Commit, Push, Progress Comment

**User input:** $ARGUMENTS

## Global Rules

1. **GitHub as shared memory** — Progress is posted as PR/issue comments so any future session can pick up context.
2. **HTML markers** — Use `<!-- mach6-progress -->` as the first line of progress comment bodies.
3. **No `#N` in comment bodies** — Use "finding 3", "item 3", "stage 2" etc. instead.
4. **Safe git** — Never use `git add -A` or `git add .`. Stage files by name. Never stage secrets (.env, credentials, tokens, keys).
5. **Task tracking** — Use the `tasks_update` tool to show progress.
6. **Non-interactive `gh`** — Set `GH_PAGER=cat` and `GH_EDITOR=cat` before all `gh` commands to prevent interactive prompts from hanging the agent. Use `--body-file` instead of inline `--body` for all `gh pr comment`, `gh pr create`, and `gh issue create` calls to avoid shell interpretation of backticks. Write each body to a **unique per-invocation temp file** via `mktemp` (e.g. `GH_BODY="$(mktemp /tmp/gh-comment.$$.XXXXXXXX)"`) — never a fixed path like `/tmp/gh-comment.md`, which concurrent mach6 sessions on the same machine would clobber, cross-posting one session's body to another's PR/issue.
7. **Stop after durable progress** — The commit, push, and GitHub progress comment are the accountability and recovery boundary. Do not invoke `mach6-review` or continue into a formal review cycle. Only the user may start formal review; offer it with `suggest_next` and stop.

## Step 1: Set up task tracking

```
tasks_update([
  { id: "stage", title: "Stage changes", status: "in_progress" },
  { id: "commit", title: "Commit", status: "pending" },
  { id: "push", title: "Push to remote", status: "pending" },
  { id: "comment", title: "Post progress comment", status: "pending" }
])
```

## Step 2: Stage changes

Run `git status` and `git diff` to understand the current state.

- If you have context from this session about which files were modified, stage those by name.
- If files are already staged and look correct, proceed.
- If unclear (fresh session, no context), review all changes and ask the user what to stage.
- **Never** use `git add -A` or `git add .`
- **Never** stage secrets (.env, credentials, tokens, keys)

Update task: stage → completed, commit → in_progress.

## Step 3: Commit

Check recent commit style:
```bash
git log --oneline -10
```

Generate a commit message that:
- Follows the repository's existing style
- Summarizes the nature of the changes
- Uses the user's override message if provided

```bash
git commit -m "<message>"
```

Update task: commit → completed, push → in_progress.

## Step 4: Push

```bash
git push
```

If no upstream is set, use `git push -u origin <branch>`.

Update task: push → completed, comment → in_progress.

## Step 5: Post progress comment

### 5a: Inspect the diff

Examine the committed changes to understand their structure:

```bash
git diff HEAD~1 HEAD
```

If this is the first commit on the branch (no `HEAD~1`), use:

```bash
git show HEAD
```

Analyze the diff:
- **Multi-file changes**: identify entry points, shared utilities, call direction, and data flow between files
- **Single-file changes**: identify public API surface, internal helpers, call graph, and key data structures
- **Trivial changes** (typo fixes, config tweaks, version bumps): note that no structural impact occurred

### 5b: Detect the associated PR or issue

1. **Session context first**: If an earlier mach6 command in this session targeted a specific PR or issue, use that.
2. **PR detection**: Try `gh pr view --json number,url` on current branch. If a PR exists, comment on it.
3. **Branch name fallback**: Check branch name for issue number pattern (e.g., `feature/issue-55-*`). If found, comment on that issue.
4. **Skip gracefully**: If neither works, skip commenting and inform the user.

If session context points to an issue but a PR also exists on the current branch, prefer the PR.

### 5c: Post the comment

Post a progress comment using the formalized structure below:

```bash
GH_BODY="$(mktemp /tmp/gh-comment.$$.XXXXXXXX)"
cat > "$GH_BODY" << 'MACH6_EOF'
<!-- mach6-progress -->
## Progress Update

### Architecture
<generated from diff analysis — see guidance below>

### New files
- `path/to/file.ts` — one-line description

### Modified files
- `path/to/file.ts` — one-line description

**Commit:** `<hash>`

---
*Progress tracked by mach6*
MACH6_EOF
gh pr comment <number> --body-file "$GH_BODY"
```

**Core sections** — always present:
- **Architecture** — generated from diff analysis (see guidance below)
- **New files** — omit the header if no new files in this commit
- **Modified files** — omit the header if no modified files in this commit

**Optional sections** — add when helpful to a reader or future session:
- `### Verification` — if tests were run or specific behaviors were validated
- `### Migration notes` — if schema, API, or config changes require consumer action
- `### Known limitations` — if the work is intentionally incomplete or has known gaps

**Architecture section guidance:**

Write 1–8 sentences that give a **self-contained** structural description of the changes. A reader who sees only this comment should fully understand what was built, how it's organized, and how the pieces connect — without opening any file.

- **Multi-file pushes**: Describe inter-file relationships — which files are entry points, which are shared utilities, which call which, what data flows between them. Then drill into key intra-file structure for non-trivial files (public API surface, internal helpers, class/function relationships).
- **Single-file pushes**: Describe intra-file structure — public API vs internal helpers, call graph, key data structures, how the parts compose.
- **Trivial changes** (typo fixes, version bumps, config tweaks): Include the section but keep it brief — e.g., "Single config value change in `settings.json`, no structural impact."
- **Focus**: on the most architecturally significant relationships. Omit exhaustive detail.

**Examples:**

Multi-file:
> **Architecture**
>
> `acquisition_run_positionAcqf.py` is the main entry point for position-diversified GP acquisition runs. Both it and the existing `acquisition_run.py` delegate shared data-loading and search-space construction to `utils.py` (`load_protein_data`, `build_searchspace`, `build_campaign`). Results are written to `result_metrics_d-*` files, which `acquisition_analysis.ipynb` loads for plotting.

Single-file:
> **Architecture**
>
> `parser.ts` exposes one public function `parse()` which drives the pipeline. It delegates tokenisation to `tokenize()` and AST construction to `buildNode()`, both private. Error recovery is centralised in `recover()`, called by `buildNode()` on unexpected tokens.

Update task: comment → completed.

Report: what was committed, where pushed, and where the comment was posted (with link). The work is now durably saved and available for accountable review.

Stop here. Do not invoke `mach6-review`, launch formal review agents, or begin a review-fix-review loop. Only the user may start formal review.

Use `suggest_next` for exactly one context-appropriate command, then end the turn:
- If on a feature branch with a PR: `/skill:mach6-review <pr-number>`
- If on a feature branch without a PR: `/skill:mach6-plan <issue-number>` to create one
- If on the default branch: an issue-oriented next step
