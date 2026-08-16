#!/usr/bin/env bash
#
# rebuild-vscode.sh — rebase the `vscode` integration branch onto the `ask` branch.
#
# =============================================================================
#  What `vscode` is
# =============================================================================
# `vscode` is the VS Code extension integration branch. It bundles:
#   - the full VS Code extension (packages/vscode/, Phases 0-4b: PRs
#     #14/#16/#18/#21/#23) + its build glue, AND
#   - the worktree-isolation (#233) + parallel-mode (#4) + test-coverage (#8)
#     work (the same domain as the `worktree-cleaned` branch).
# Because it already contains the worktree work, karin lists `vscode` and does
# NOT list `worktree-cleaned` separately (see karin-branches.txt).
#
# =============================================================================
#  Why `vscode` is based on `ask` (BASE=feature/issue-10-ask-mode)
# =============================================================================
# The read-only Ask mode (`/ask on` / `/ask off`, issue #10) lives on the
# `feature/issue-10-ask-mode` branch. Wiring `/ask` through the extension needs
# the ask-mode CLI code (AgentSession.setAskMode + a new RPC method) present in
# the *same* lineage as the extension host code, so the extension can route the
# `/ask` builtin to the RPC toggle instead of surfacing "isn't available yet".
# We therefore rebase `vscode` onto `ask` (which is itself based on current
# master), so the vscode branch carries ask-mode. Because `vscode` now contains
# ask, karin lists `vscode` and does NOT list `feature/issue-10-ask-mode`
# separately (see karin-branches.txt), mirroring the worktree-cleaned rule.
#
# NOTE: keep `feature/issue-10-ask-mode` rebased on current master (via its own
# PR workflow) so that rebasing `vscode` onto it stays on the latest master.
#
# =============================================================================
#  Skill-doc reconciliation
# =============================================================================
# The `vscode` branch's history forked before master's #458, which rewrote the
# mach6 skill docs (mach6-review et al.) into the "counter-pressure" version.
# vscode still carried the older lineage, so a naive merge into karin produced
# a broken blend. Rebasing vscode onto `ask` (= master + ask commits) replays
# its work on top of #458 and reconciles those skill docs ONCE. The
# reconciliation is deterministic: for the known collision files, take
# `worktree-cleaned`'s versions (worktree-cleaned = the same worktree work
# already correctly rebased onto #458, so its skill docs are the canonical
# "#458 + worktree" result).
#
# Corruption-safety (aebrer/dreb#461): uses only `rebase` (+ `checkout -- file`
# to stage resolutions). `git rebase` never runs the test-running pre-commit
# hook, so the GIT_* env-leak corruption bug cannot fire.
#
# Usage:
#   ./rebuild-vscode.sh                 # rebase vscode onto ask in a transient worktree
# Then review and push explicitly:
#   git push --force-with-lease Hrovatin vscode
#
set -euo pipefail

BASE="${BASE:-feature/issue-10-ask-mode}"
RECONCILE_FROM="${RECONCILE_FROM:-worktree-cleaned}"
BUILD_PARENT="$(mktemp -d)"
BUILD_WT="${BUILD_WT:-$BUILD_PARENT/vscode-rebase}"

# Files where vscode's pre-#458 lineage collides with master; resolve each to
# RECONCILE_FROM (worktree-cleaned)'s already-reconciled "#458 + worktree" copy.
RECONCILE_FILES=(
	packages/coding-agent/skills/mach6-implement/SKILL.md
	packages/coding-agent/skills/mach6-plan/SKILL.md
	packages/coding-agent/skills/mach6-publish/SKILL.md
	packages/coding-agent/skills/mach6-review/SKILL.md
	packages/coding-agent/test/skills.test.ts
	test.sh
)

# vscode must not be checked out anywhere (we rebase it in a transient worktree).
if git worktree list --porcelain | grep -q '^branch refs/heads/vscode$'; then
	echo "ERROR: 'vscode' is checked out in a worktree — move that checkout off it and re-run." >&2
	exit 1
fi

cleanup() {
	local code=$?
	if [ "$code" -eq 0 ]; then
		git worktree remove --force "$BUILD_WT" 2>/dev/null || true
		rmdir "$BUILD_PARENT" 2>/dev/null || true
	else
		echo "rebase worktree left at: $BUILD_WT (resolve, 'git rebase --continue', then re-run)." >&2
	fi
}
trap cleanup EXIT

git config rerere.enabled true
git config rerere.autoUpdate true

# Rebase a throwaway copy of vscode onto BASE, then move the vscode ref to it.
git worktree add -B vscode-rebuild "$BUILD_WT" vscode >/dev/null
cd "$BUILD_WT"

if git rebase "$BASE"; then
	:
else
	# Drive the rebase to completion, auto-resolving the known collision files.
	while [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]; do
		unmerged="$(git diff --name-only --diff-filter=U)"
		[ -z "$unmerged" ] && { GIT_EDITOR=true git rebase --continue || true; continue; }
		leftover=""
		while IFS= read -r f; do
			[ -z "$f" ] && continue
			skip=""
			for rf in "${RECONCILE_FILES[@]}"; do [ "$f" = "$rf" ] && skip=1 && break; done
			if [ -n "$skip" ] && git cat-file -e "$RECONCILE_FROM:$f" 2>/dev/null; then
				git checkout "$RECONCILE_FROM" -- "$f"
			else
				leftover="$leftover $f"
			fi
		done <<< "$unmerged"
		if [ -n "${leftover// /}" ]; then
			echo "!! unexpected conflict in:$leftover" >&2
			echo "   Resolve in $BUILD_WT, 'git rebase --continue', then re-run." >&2
			exit 2
		fi
		git add -A
		GIT_EDITOR=true git rebase --continue || true
	done
fi

git branch -f vscode vscode-rebuild
git branch -D vscode-rebuild >/dev/null 2>&1 || true

TIP="$(git rev-parse --short vscode)"
echo "== vscode rebased onto $BASE -> $TIP =="
echo "   review, then push:  git push --force-with-lease Hrovatin vscode"
echo "   (karin then picks it up on its next rebuild: ./rebuild-karin.sh)"
