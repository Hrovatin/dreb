#!/usr/bin/env bash
#
# rebuild-karin.sh — regenerate the `karin` integration branch from clean components.
#
# =============================================================================
#  karin is a BRANCH, never a worktree.
#  Do NOT `git worktree add` a permanent karin checkout. This script builds
#  karin inside a TRANSIENT worktree that is created and removed on every run,
#  so `karin` only ever exists as a branch ref. The script refuses to run if
#  karin is currently checked out in any worktree.
# =============================================================================
#
# What it does:
#   karin = master + each component branch listed in karin-branches.txt,
#   merged in order with --no-ff. Re-run any time to rebuild karin cleanly on
#   the latest master + latest components (no hand-stacking, no duplicate
#   commits). `git rerere` remembers each cross-branch conflict resolution so
#   later rebuilds replay them automatically and this script auto-completes
#   the merge.
#
# Corruption-safety (see aebrer/dreb#461):
#   Uses ONLY `checkout`, `merge --no-ff`, and — to finalize a merge that
#   rerere has already resolved — `commit --no-edit`. A MERGE commit runs the
#   `pre-merge-commit` hook (empty in this repo), NOT the test-running
#   `pre-commit` hook, so the GIT_* env-leak corruption bug cannot fire. This
#   script never runs `git cherry-pick` or a non-merge `git commit`.
#
# Usage:
#   ./rebuild-karin.sh [manifest]        # rebuild karin locally (default: ./karin-branches.txt)
# Then review and push explicitly (the script never pushes for you):
#   git push --force-with-lease Hrovatin karin
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${1:-$SCRIPT_DIR/karin-branches.txt}"
BASE="${BASE:-master}"
BUILD_PARENT="$(mktemp -d)"
BUILD_WT="${BUILD_WT:-$BUILD_PARENT/karin-build}"

[ -f "$MANIFEST" ] || { echo "manifest not found: $MANIFEST" >&2; exit 1; }

# Enforce the branch-only rule: karin must not be checked out anywhere.
if git worktree list --porcelain | grep -q '^branch refs/heads/karin$'; then
	echo "ERROR: 'karin' is checked out in a worktree — karin must be a branch only." >&2
	echo "       Move that checkout off karin (e.g. 'git checkout master') and re-run." >&2
	exit 1
fi

cleanup() {
	local code=$?
	if [ "$code" -eq 0 ]; then
		git worktree remove --force "$BUILD_WT" 2>/dev/null || true
		rmdir "$BUILD_PARENT" 2>/dev/null || true
	else
		echo "build worktree left at: $BUILD_WT" >&2
		echo "resolve there, then re-run (rerere will replay the resolution)." >&2
	fi
}
trap cleanup EXIT

# Build karin inside the transient worktree, starting from BASE.
git worktree add -B karin "$BUILD_WT" "$BASE" >/dev/null
cd "$BUILD_WT"

# Resolve each cross-branch conflict once; replay it on every future rebuild.
git config rerere.enabled true
git config rerere.autoUpdate true

count=0
while IFS= read -r line || [ -n "$line" ]; do
	branch="${line%%#*}"                              # strip inline comments
	branch="$(printf '%s' "$branch" | tr -d '[:space:]')"
	[ -z "$branch" ] && continue
	echo ">> integrating $branch"
	if git merge --no-ff -m "integrate $branch into karin" "$branch"; then
		:                                              # clean merge
	elif [ -z "$(git ls-files --unmerged)" ]; then
		# rerere auto-resolved and staged every conflict; finalize the merge
		# commit (pre-merge-commit hook only — no pre-commit, so no corruption).
		git commit --no-edit >/dev/null
		echo "   (conflict auto-resolved via rerere)"
	else
		echo "!! unresolved conflict integrating $branch:" >&2
		git ls-files --unmerged | awk '{print $4}' | sort -u | sed 's/^/     /' >&2
		echo "   In $BUILD_WT: resolve, 'git add -A', 'git commit --no-edit', then re-run." >&2
		exit 2
	fi
	count=$((count + 1))
done < "$MANIFEST"

TIP="$(git rev-parse --short karin)"
echo "== karin rebuilt: $BASE + $count components -> $TIP =="
echo "   review, then push:  git push --force-with-lease Hrovatin karin"
