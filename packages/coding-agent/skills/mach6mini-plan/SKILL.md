---
name: mach6mini-plan
description: "Streamlined planning that skips issue creation — discuss with user, align on implementation, open PR directly. Usage: mach6mini-plan [description]"
argument-hint: "[description]"
---

# mach6mini-plan — Plan and Open PR (No Issue)

**User input:** $ARGUMENTS

This is a streamlined workflow that merges issue discussion + planning into one step. No GitHub issue is created — the PR becomes the source of truth.

This command is strictly for **planning**. Do NOT implement any code changes — no file edits, no file writes.

## Global Rules

1. **GitHub as shared memory** — Plans, reviews, assessments, and progress are posted as PR/issue comments so any future session can pick up context.
2. **HTML markers** — Use `<!-- mach6mini-plan -->` as the first line of plan comment bodies for reliable discovery.
3. **No `#N` in comment bodies** — GitHub auto-links `#N` to issues/PRs. Use "finding 3", "item 3", "stage 2" etc. instead.
4. **Safe git** — Never use `git add -A` or `git add .`. Stage files by name. Never stage secrets.
5. **Task tracking** — Use the `tasks_update` tool to show progress through multi-step commands.
6. **Project conventions** — Check for CLAUDE.md, AGENTS.md, .dreb/CONTEXT.md, and CONTRIBUTING.md before planning.
7. **Non-interactive `gh`** — Set `GH_PAGER=cat` and `GH_EDITOR=cat` before all `gh` commands to prevent interactive prompts from hanging the agent. Use `--body-file` instead of inline `--body` for all `gh pr comment`, `gh pr create`, and `gh issue create` calls to avoid shell interpretation of backticks.

## Step 1: Set up task tracking

```
tasks_update([
  { id: "gather", title: "Gather requirements", status: "in_progress" },
  { id: "explore", title: "Explore codebase", status: "pending" },
  { id: "plan", title: "Draft implementation plan", status: "pending" },
  { id: "branch", title: "Create branch and draft PR", status: "pending" },
  { id: "post", title: "Post plan to PR", status: "pending" }
])
```

## Step 2: Gather requirements

If the user provided a description in `$ARGUMENTS`, use it as the starting point.

If no arguments were provided, ask the user:
- What do they want to build or change?
- What problem does it solve?
- Any constraints or requirements?

**Discuss and align** — Before proceeding, ensure you and the user are aligned on:
- The scope of the work
- What "done" looks like
- Any constraints or non-goals

This discussion phase replaces formal issue creation. Get explicit user approval before proceeding to exploration.

Update task: gather → completed, explore → in_progress.

## Step 3: Read project conventions

Check for and read (first found):
- CONTRIBUTING.md, DEVELOPMENT.md, .github/CONTRIBUTING.md
- CLAUDE.md, AGENTS.md, .dreb/CONTEXT.md

Extract planning-relevant guidance: project layers, testing expectations, coding conventions.

## Step 4: Explore the codebase

Launch 2-3 Explore subagents in parallel. Agent definitions specify their own model with a provider fallback list — defaults work across providers and are fine for most cases. Override only with good reason.
- **Similar features**: Find existing code that solves related problems, trace implementation patterns
- **Architecture**: Map relevant architecture layers, abstractions, data flow
- **Integration points**: Identify where new code connects to existing systems

Include project conventions in each agent's context. Each agent returns 5-10 key files. Read all identified files.

Update task: explore → completed, plan → in_progress.

## Step 5: Draft the plan

Create an implementation plan with:
- Clear analysis of the problem
- **Deliverables**: What will be produced (be specific)
- **Acceptance criteria**: How to verify the work is done
- **Files to create or modify**: List each with what changes
- **Testing approach**: What tests to write, what to verify
- **Risks and open questions**: Anything that might derail implementation

The plan should be **high-level on implementation details** (avoid cascading spec errors from over-specifying) but **specific on deliverables and acceptance criteria**.

**Project-layer coverage:** Cross-check the plan against discovered project layers. Every affected layer should be addressed.

**Test coverage is mandatory, not optional.** Every new behavior, command handler, formatting function, or event wiring must include tests in the plan. If the target package lacks test infrastructure, the plan must include setting it up as a deliverable — this cannot be deferred.

Present the plan to the user. Discuss and revise if they have feedback.

**Get explicit approval** before creating the branch and PR.

Update task: plan → completed, branch → in_progress.

## Step 6: Create branch and draft PR

Use a git worktree to isolate the PR's work from the current directory.

```bash
# Derive branch name from the plan
# Format: feature/<slug> (slug = 3-5 words from title, lowercase, hyphens)
# Note: No issue number since this workflow skips issue creation

# Check if a worktree already exists for this branch
git worktree list
# If a worktree exists for the branch, reuse it (skip branch + worktree creation).
# If not, create the branch and worktree:

# Create the branch (without switching to it)
git branch feature/<slug>

# Determine repo name for worktree path convention
REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")

# Create a worktree for the new branch (use slug for path since no issue number)
git worktree add "../${REPO_NAME}-worktrees/<slug>" feature/<slug>
```

Switch the agent's working directory to the worktree using the `chdir` tool:
```
chdir { path: "../<repo-name>-worktrees/<slug>" }
```

Now operating in the worktree — create the empty commit and push:
```bash
git commit --allow-empty -m "chore: open PR for <brief description>"

git push -u origin feature/<slug>

# Open draft PR (no "Closes #N" since no issue)
cat > /tmp/gh-body.md << 'MACH6_EOF'
<brief description of the change>

## Summary

<2-3 sentence summary of what this PR does>

Implementation plan posted as a comment below.
MACH6_EOF
gh pr create --draft --title "<title>" --body-file /tmp/gh-body.md
```

Update task: branch → completed, post → in_progress.

## Step 7: Post plan to PR

```bash
cat > /tmp/gh-comment.md << 'MACH6_EOF'
<!-- mach6mini-plan -->
## Implementation Plan

<full plan content>

---
*Plan created by mach6mini*
MACH6_EOF
gh pr comment <pr-number> --body-file /tmp/gh-comment.md
```

Update task: post → completed.

Suggest next step: `/skill:mach6mini-implement <pr-number>` to implement and push in one step.
