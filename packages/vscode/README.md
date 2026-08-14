# dreb for VS Code

A native chat client for the [dreb](https://github.com/aebrer/dreb) coding agent, embedded in VS Code as a webview. It drives dreb over its RPC protocol (`RpcClient` from `@dreb/coding-agent/rpc`) and streams responses into a chat panel — separating the agent's thinking/tool activity from its final answer, with slash commands and inline prompts.

This package is modeled on `@dreb/dashboard`: an extension **host** owns the RPC child and the authoritative transcript state, and a **webview** renders it. The only transport difference is that the dashboard's HTTP+SSE layer is replaced by VS Code's `postMessage` bridge.

> Status: **Phase 5** (sessions side panel — a Copilot-style sidebar listing sessions with live status, resume, rename, pin, archive, delete; multiple sessions run concurrently) on top of Phase 4b (context tagging — tag an editor selection or a file/folder into the current chat), Phase 3 (change review — per-turn git snapshot + per-hunk keep/reject), Phase 2 (built-in slash commands + TUI-parity status header), and the Phase 0 + 1 foundation. See the [tracking issue](https://github.com/Hrovatin/dreb/issues/12) for the roadmap.

## Architecture

```
src/
  shared/        # DTOs + pure projection reducer (imported by BOTH sides)
    protocol.ts       host ↔ webview message envelopes (no @dreb import)
    projection.ts     RPC events → transcript render model (pure, tested)
  host/          # extension host (Node, ESM) — compiled with tsgo
    extension.ts        activate(): registers the chat + sessions sidebar + review commands; owns the session pool
    session-controller.ts  one RpcClient + authoritative transcript per session (resume via `--session`, live run-state, rename)
    webview-bridge.ts   postMessage wiring + webview HTML/CSP
    cli-path.ts         resolve the dreb CLI (setting → dependency)
    slash-router.ts     route composer text → prompt vs builtin RPC (pure, tested)
    session-registry.ts multi-session pool — one live panel per session key, reentrancy-safe (pure, tested)
    session-inventory.ts on-disk session enumeration via @dreb/coding-agent's SessionManager (vscode-free)
    session-flags.ts    pin/archive persistence over globalState, keyed by session path (pure seam, tested)
    sessions-view-model.ts sidebar list-building + action routing (pure, vscode-free, tested)
    sessions-view.ts    the `dreb.sessions` WebviewView glue (postMessage transport + HTML shell)
    tag-selection.ts    tag-selection-into-chat orchestration (pure, vscode-free, tested)
    host-ui.ts          native-prompt port (quick pick / input / dialogs); vscode-free
    vscode-host-ui.ts   the real `HostUi` backed by `vscode.window`
    git-snapshot.ts     per-turn baseline capture + diff + `git apply -R` (pure node, tested)
    diff-hunks.ts       unified-diff hunk parsing / slicing (pure, tested)
    review-model.ts     change-review cycle + accept state (pure, tested)
    review-ui.ts        SCM / quick-diff / diff-viewer port; vscode-free
    vscode-review-ui.ts the real `ReviewUi` backed by `vscode.scm`
  shared/
    format.ts           status-header + `/session` display formatters (pure, tested)
    tagged-context.ts   selection + file/folder context DTOs, chip label, prompt fold + threshold (pure, tested)
    session-list.ts     disk+live session reconciliation, grouping, deterministic ordering, status (pure, tested)
    sidebar-protocol.ts host ↔ sessions-sidebar message envelopes (no @dreb import)
  webview/       # SolidJS UI — bundled with Vite → dist/webview (chat) + dist/webview-sidebar (sessions)
    app.tsx             transcript, collapsible activity box, composer, needs-input,
                        the status header (model · thinking · cost · ctx), and the
                        change-review bar
    sidebar/app.tsx     the sessions side panel — grouped list, live status, resume,
                        inline rename, pin / archive / delete
```

- The host keeps the authoritative `TranscriptState`. On (re)load the webview announces `ready` and receives a full snapshot, so recreating the webview never loses the conversation.
- Host and webview apply the **same** pure `applyEvent` reducer, so live streaming and the reload snapshot stay consistent.
- `SessionController` drives native VS Code prompts only through the `HostUi` port, so the controller and its tests stay node-only; `vscode-host-ui.ts` is the sole place that imports `vscode` for prompts.

## Slash commands

Type `/` in the composer to run a built-in command instead of sending a prompt. dreb's server advertises builtins via `get_commands` but rejects them as prompts, so the host intercepts every builtin and routes it to an RPC method or a native VS Code surface:

| Command | Action |
| --- | --- |
| `/model` | Native quick pick to switch the active model (session-local). |
| `/compact` | Summarize and compact the conversation context. |
| `/new` | Start a new session. |
| `/reload` | Reload skills, extensions, prompts, and settings. |
| `/dream` | Consolidate and prune memories. |
| `/session` | Show session info and stats (messages, tokens, cost, context). |
| `/name` | Set the session display name (native input box). |
| `/export` | Export the session to HTML (native save dialog). |
| `/import` | Import and resume a session from JSONL (native open dialog). |
| `/quit` | End the session; the panel stays open showing an ended banner. Re-run **dreb: Open Chat** for a fresh session. |

Commands owned by later phases (`/settings`, `/scoped-models`, `/fork`, `/tree`, `/resume`) and terminal-only commands (`/login`, `/logout`, `/copy`, `/hotkeys`, `/buddy`) are recognized but surface a notice rather than running. An unrecognized command (e.g. `/foo`) surfaces an "unknown command" notice.

## Status header

The webview renders a compact header mirroring the TUI: **model · thinking level · cost · context usage**. Cost shows the session total (`$0.123`, `+ (sub)` on a subscription) and, when known, the larger daily total (`, today $1.23`); context usage shows `ctx 42%`. All formatting lives in the pure `shared/format.ts` so the header renders costs consistently.

## Change review

Because the agent runs out-of-process and writes edits straight to disk, the extension can't hold changes in an unsaved overlay. Instead it **snapshots a git baseline before each turn** and reviews the working tree against it (the non-interactive analogue of `git restore -p`):

- **Baseline** — before the first turn of a review cycle, `git-snapshot.ts` captures the working tree into a git tree object via a *throwaway index*, so neither your real index nor working tree is touched. Because it snapshots the tree *as-is* (including your own uncommitted edits), later diffs isolate **only** what the agent changed. Changes **compound** across turns until you accept or revert.
- **Detection** — after each turn (`agent_end`), a baseline→current tree diff lists the changed files (adds/mods/deletes, git-detected — so `bash`-tool writes count too), shown in a **change-review bar** in the webview and an SCM group **"dreb — pending review"** with inline change gutters (via a `QuickDiffProvider` pointed at the baseline).
- **Keep / reject** — the `dreb.review.*` commands accept a file (clear its marker — **no commit**), accept/revert all, revert a whole file to baseline, or **reject the hunk at the cursor** (`dreb.review.rejectHunkAtCursor`, which drives `git apply --reverse` on exactly that hunk). Rejecting a hunk restores only that region and never clobbers your own pre-existing edits.

Review is host-authoritative, so it survives webview reload. Outside a git repository it degrades gracefully (disabled, no snapshots). The pure logic (`review-model.ts`, `diff-hunks.ts`) and the git plumbing (`git-snapshot.ts`, against real temp repos) are unit-tested; all `vscode` SCM/diff calls are isolated behind the `ReviewUi` port.

## Sessions sidebar

The **dreb** activity-bar container hosts a **Sessions** side panel (a SolidJS `WebviewView`, bundled separately into `dist/webview-sidebar`) that lists your dreb sessions Copilot-style:

- **Grouping & ordering** — sessions in the **current workspace** are listed first ("This workspace"); sessions from **other working directories** appear in collapsible per-project groups below; **archived** sessions collapse into their own section. Ordering is **deterministic** (per this repo's "Determinism Over Recency" rule): pinned first, then most-recently-modified — live run-state never reorders rows, so cards don't jump around while streaming.
- **Sources** — on-disk sessions are enumerated host-side via `@dreb/coding-agent`'s `SessionManager` (`list` / `listAll`, no RPC child needed); live sessions come from the pool. A live controller and its disk row are the **same** session (reconciled by session-file path) and show as one row — `session-list.ts` owns this pure merge/group/sort.
- **Live status** — each row shows **running** (agent streaming), **needs input** (awaiting a selection/confirmation prompt), or **idle/done**, derived from the projected transcript (`streaming` / `uiRequests`). The sidebar refreshes (debounced) as controllers stream.
- **Multiple concurrent sessions** — selecting a session **opens or resumes** it in a chat panel (resume passes `--session <path>` to the RPC child). Several sessions run **at once** and keep running when you switch tabs/focus: the single-slot registry is now a keyed **`SessionPool`** holding one live panel per session key.
- **Organize** — **rename** (persisted via the `set_session_name` RPC; a closed session is renamed by briefly spawning a headless resume child), **pin**, **archive** (hidden from the main list, not deleted — retained on disk and reachable under "Archived"), and **delete** (behind a modal confirmation; removes the transcript and its flags). Pin/archive flags persist in `globalState`, keyed by session path.

The list-building and action routing live in the vscode-free `sessions-view-model.ts` (unit-tested with fakes); `sessions-view.ts` is the thin `WebviewView` transport, mirroring `webview-bridge.ts`. The concurrency-safe pool core stays in the pure, tested `session-registry.ts`.

## Editor integration

Tag context into the chat as removable chips. Two kinds of context can be tagged, and both accumulate as chips in the composer that you can remove before sending:

**Editor selection.** Select any range (a whole line or part of one) and run **dreb: Add Selection to Chat** — from the command palette or the editor right-click menu (shown only when there is a selection, `when: editorHasSelection`). The selection is added as a **removable chip** labelled `basename:line` (or `basename:start-end`). On send, a small selection is folded into the prompt as a located, fenced code block (workspace-relative path + line range) so the agent knows exactly where the code came from. A **large** selection (over `MAX_INLINE_SELECTION_LINES` = 40 lines, or `MAX_INLINE_SELECTION_CHARS` = 2000 characters) instead folds as a `` `path` (lines a-b) `` reference only, to keep the prompt short. The selection is captured **at tag time** (a pre-resolved snapshot, not a lazy reference).

**File / folder.** Type `@` in the composer to open the native VS Code file/folder picker (`showOpenDialog` with files and folders selectable, multi-select). Each chosen path is added as a **removable chip** (`basename`, or `basename/` for a folder). On send, a file/folder tag folds into the prompt as a **path reference only — never the contents** (e.g. `` `src/app.ts` `` or `` `src/host/` (directory) ``), so the agent can open and explore it as needed without bloating the prompt. Paths are workspace-relative when the pick is inside the workspace; the workspace root itself folds as `` `./` (directory) ``, and a pick outside the workspace uses its **absolute** path so the reference stays unambiguous (rather than a bare basename that could collide with a same-named file under the workspace).

dreb's agent accepts text + images only, so there is no separate structured-context channel: all tags are folded into the prompt text. Sending with only chips and no typed text is allowed. Tagging with no chat open opens one first, then attaches.

The pure DTO builders, chip label/title, threshold logic, and prompt formatter are unit-tested in `shared/tagged-context.ts`; the selection command orchestration lives in the vscode-free `host/tag-selection.ts`; the file picker is driven through the `HostUi` port (`pickWorkspaceFiles`), so the controller stays vscode-free. Delivery to the composer is queued until the webview is `ready` so tagging into a freshly opened chat still lands.


## Requirements

- **VS Code 1.100+** — this is an [ESM extension](https://code.visualstudio.com/updates/v1_100#_esm-support-for-extensions) (`"type": "module"`), which requires the ESM-capable extension host.
- **Node 22.x** available to the extension host — `RpcClient` spawns `node <cli.js> --mode rpc`.
- A resolvable dreb CLI (see below).

## Locating the dreb CLI

`RpcClient` spawns the compiled dreb CLI. The host resolves its absolute path in this order:

1. the **`dreb.cliPath`** setting, if set (absolute path to `@dreb/coding-agent`'s `dist/cli.js`);
2. dependency resolution via the bundled `@dreb/coding-agent` (works out of the box in the F5 dev host).

When running a packaged `.vsix` that does not ship the CLI, set `dreb.cliPath` to a local dreb install's `dist/cli.js`.

## Settings

| Setting | Description |
| --- | --- |
| `dreb.cliPath` | Absolute path to the dreb CLI (`dist/cli.js`). Empty = auto-resolve. |
| `dreb.provider` | Optional provider passed to dreb (e.g. `anthropic`). |
| `dreb.model` | Optional model id/pattern passed to dreb. |

## Development

From the repo root the package builds as part of the monorepo `build` chain. Standalone:

```bash
cd packages/vscode
npm run build            # tsgo (host) + vite (webview) → dist/
npm test                 # vitest (host + projection logic)
npm run typecheck:webview  # type-check the DOM/webview code (not in the root check)
```

Then press **F5** ("Run Extension") to launch an Extension Development Host and run **dreb: Open Chat**.

### Packaging

```bash
npm run package          # → dreb-vscode-<version>.vsix (via @vscode/vsce)
```

Install the `.vsix` with `code --install-extension dreb-vscode-<version>.vsix`.

## Testing notes

Host and projection logic are unit-tested with vitest in a node environment (deterministic, no display required). Extension-activation smoke tests via `@vscode/test-electron` are intentionally out of scope for now — the CI `test` job has no display; adding them would require `xvfb-run`.

## Versioning

Unlike the npm-published packages, this extension is **versioned independently** and is excluded from the repo's `sync-version` script. It is not published to the npm registry.
