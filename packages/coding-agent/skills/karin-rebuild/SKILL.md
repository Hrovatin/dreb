---
name: karin-rebuild
description: Rebuild the karin integration branch (and its vscode component) from clean component branches using the karin-build scripts. USE WHEN master or any component branch advances and you need to regenerate the karin fork branch, or when asked to "rebuild karin", "rebuild the vscode branch", or "re-integrate the components".
---

# karin-rebuild — Regenerate the karin integration branch

`karin` (on the `Hrovatin` remote, PR #3) is an **integration branch**, not
hand-maintained. It is **rebuilt** from `master` + a manifest of component
branches. It is a **branch only — never a worktree**. Anything committed
directly onto `karin` is destroyed on the next rebuild — persistent changes
must live in a component branch listed in the manifest.

## Composition

```
karin = master + each component branch in custom/karin-branches.txt, merged --no-ff in order
```

The manifest and rebuild scripts live on the **`karin-build`** branch (Hrovatin)
under `custom/`:

- `custom/karin-branches.txt` — ordered list of component branches.
- `custom/rebuild-karin.sh` — rebuilds `karin` in a transient worktree.
- `custom/rebuild-vscode.sh` — rebases the CLEAN `vscode` branch onto the fork
  branch (`feature/issue-439-fork-from-current-state`).

The `vscode` component is itself derived: the VS Code extension (Phases 0-9)
rebased onto the fork-from-current-state branch, carrying the fork work + the
extension only.

## Corruption-safety — why merges/rebases, never commit/cherry-pick

The `GIT_*` env-leak pre-commit corruption bug (aebrer/dreb#461) only fires on
`git commit` / `git cherry-pick`, which run the **test-running `pre-commit`
hook**. `git rebase` and `git merge --no-ff` run the empty `pre-merge-commit`
hook instead, so they are corruption-safe. **Both scripts use only merge/rebase
(plus `commit --no-edit` to finalize a rerere-resolved merge, which is still a
merge commit).** Never hand-run `git cherry-pick` or a non-merge `git commit`
when rebuilding.

`git rerere` is enabled (`rerere.enabled`/`rerere.autoUpdate`) so recorded
cross-branch conflict resolutions replay automatically on every rebuild.

## Rebuild procedure

When **master or the extension advances**, rebuild in this order:

### 1. Rebuild the vscode component (only if the extension or fork base moved)

```bash
cd <karin-build worktree>/custom
./rebuild-vscode.sh
git push --force-with-lease Hrovatin vscode
```

### 2. Rebuild karin

`rebuild-karin.sh` builds inside a **transient worktree** (created and removed
each run) and **refuses to run if `karin` is checked out anywhere**. The main
hub normally has `karin` checked out, so move it off first:

```bash
# Free karin so the rebuild script will run
git -C /Users/karinhrovatin/Documents/code/dreb checkout master

cd <karin-build worktree>/custom
./rebuild-karin.sh                 # master + manifest components, merged --no-ff

# Review the rebuilt tip, then push:
git push --force-with-lease Hrovatin karin

# Restore the hub's karin checkout
git -C /Users/karinhrovatin/Documents/code/dreb checkout karin
```

If a conflict is **not** auto-resolved by rerere, the script stops and leaves
the build worktree in place. Resolve there, `git add -A`,
`git commit --no-edit`, then re-run (rerere records the resolution for next
time). Known recorded conflict: `packages/coding-agent/src/core/agent-session.ts`
(worktree-guard + ask-mode + fork logic all kept).

## Adding a new component (so a change survives rebuilds)

1. Create a component branch off `master` (or off the fork base for
   vscode-extension work) with the change; push it to `Hrovatin`.
2. On the **`karin-build`** branch, append the branch name to
   `custom/karin-branches.txt` (respect ordering; inline `# ...` comments are
   stripped). Commit and `git push Hrovatin karin-build`.
3. Rebuild karin (step 2 above). The new component is now permanently
   re-integrated on every rebuild.

## Guardrails

- `karin` is a **branch, never a worktree**. Do not `git worktree add` a
  permanent karin checkout.
- Never commit directly onto `karin` — it will be overwritten.
- The scripts never push for you; push explicitly with
  `--force-with-lease Hrovatin <branch>`.
- The `test.sh` unset block is a **union** of the fork's `GIT_*` vars and the
  extension/worktree `GIT_CONFIG*` vars — never drop one side when resolving.
