---
name: mach6mini-implement
description: "Streamlined implementation that pushes automatically after completion. Reads plan, implements, commits, pushes, posts progress — all in one. Usage: mach6mini-implement 42"
argument-hint: "<pr-number>"
---

# mach6mini-implement — Implement and Push

**User input:** $ARGUMENTS

This is a streamlined workflow that merges implementation + push into one step. After implementing the plan, changes are automatically committed, pushed, and a progress comment is posted.

## Global Rules

1. **GitHub as shared memory** — Plans, reviews, and progress are posted as PR comments with HTML markers.
2. **HTML markers** — Use `<!-- mach6mini-progress -->` as the first line of progress comment bodies.
3. **No `#N` in comment bodies** — Use "finding 3", "item 3" etc. instead.
4. **Safe git** — Never use `git add -A` or `git add .`. Stage files by name. Never stage secrets.
5. **Task tracking** — Use the `tasks_update` tool to show progress.
6. **Non-interactive `gh`** — Set `GH_PAGER=cat` and `GH_EDITOR=cat` before all `gh` commands. Use `--body-file` instead of `--body`.
7. **Comment priority** — If PR discussion modifies or contradicts the original plan, **the latest comments are the source of truth**. Parse comment timestamps and apply modifications chronologically. When in doubt, follow the most recent user instructions.

## Step 1: Parse input and checkout

Extract the PR number from `$ARGUMENTS`.

```bash
# Get the PR's branch name
PR_BRANCH=$(gh pr view <pr-number> --json headRefName --jq '.headRefName')
REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")

# Check if a worktree already exists for this branch
git worktree list
# If a worktree exists for the PR branch, reuse it.
# If not, create one — derive worktree path from branch name
git worktree add "../${REPO_NAME}-worktrees/<derived-from-branch>" "$PR_BRANCH"
```

Switch the agent's working directory to the worktree using the `chdir` tool:
```
chdir { path: "<worktree-path>" }
```

Then pull latest changes:
```bash
git pull
```

## Step 2: Read plan and build effective requirements

Read ALL PR comments to get complete context:
```bash
gh pr view <pr-number> --json title,body,comments,createdAt
```

**Build effective requirements:**

1. **Find the plan comment** — Look for `<!-- mach6mini-plan -->` or `<!-- mach6-plan -->` marker. This is the baseline.

2. **Scan subsequent comments chronologically** — For each comment after the plan:
   - If it modifies scope (adds/removes deliverables), update requirements
   - If it changes acceptance criteria, use the new criteria
   - If it provides implementation guidance, incorporate it
   - If it contradicts the plan, **follow the later comment**

3. **Identify the effective requirements** — The plan as modified by all subsequent discussion. Summarize what you will actually implement.

If no plan comment exists, tell the user and suggest running `/skill:mach6mini-plan` first.

## Step 3: Set up task tracking

Create tasks based on the effective requirements (plan + modifications):
```
tasks_update([
  { id: "read", title: "Read plan and codebase", status: "completed" },
  { id: "feature-1", title: "Implement <deliverable 1>", status: "in_progress" },
  { id: "feature-2", title: "Implement <deliverable 2>", status: "pending" },
  { id: "test", title: "Add/update tests", status: "pending" },
  { id: "verify", title: "Build and verify", status: "pending" },
  { id: "push", title: "Commit and push", status: "pending" },
  { id: "comment", title: "Post progress", status: "pending" }
])
```

## Step 4: Read the codebase

Read all files mentioned in the effective requirements. Understand the existing code before making changes.

## Step 5: Implement

Use the `feature-dev` subagent to implement each deliverable. `feature-dev` is a **pre-existing agent definition** shipped with dreb — it has full tool access (read, write, edit, grep, find, ls, bash, search) and uses a strong-tier model with a provider fallback list.

**For each deliverable**, launch a `feature-dev` subagent with:
- The specific deliverable to implement (from effective requirements, not stale plan)
- Full context including any PR discussion that modified the requirements
- The list of files to read for understanding existing patterns
- Instructions to run tests and linting after making changes
- **If tests are specified, they MUST be written as part of the implementation**

**Parallelism:** If deliverables are independent (don't modify the same files), run their `feature-dev` agents in parallel. If they have dependencies, run sequentially.

**Small plans (1-2 simple deliverables):** You may implement directly instead of delegating.

Update task tracking as each deliverable completes.

## Step 6: Verify

After all implementation is complete:
- Run the project's test suite
- Run any linting/formatting tools
- Build the project if applicable
- Verify each deliverable from the **effective requirements** is addressed

Update task: verify → completed, push → in_progress.

## Step 7: Commit and push

Stage all modified files **by name** (never `git add -A`):
```bash
git status
git add <file1> <file2> ...
```

Check recent commit style and commit:
```bash
git log --oneline -5
git commit -m "<message following repo style>"
```

Push:
```bash
git push
```

Update task: push → completed, comment → in_progress.

## Step 8: Post progress comment

Examine the committed changes:
```bash
git diff HEAD~1 HEAD
```

Post a progress comment:
```bash
cat > /tmp/gh-comment.md << 'MACH6_EOF'
<!-- mach6mini-progress -->
## Progress Update

### Architecture
<describe how the changed files relate — entry points, utilities, data flow>

### New files
- `path/to/file.ts` — one-line description

### Modified files
- `path/to/file.ts` — one-line description

### Verification
<tests run, behaviors validated>

**Commit:** `<hash>`

---
*Progress tracked by mach6mini*
MACH6_EOF
gh pr comment <pr-number> --body-file /tmp/gh-comment.md
```

Update task: comment → completed.

Suggest next step: `/skill:mach6-review <pr-number>` for code review.
