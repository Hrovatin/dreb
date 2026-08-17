# dreb for VS Code

A native chat client for the [dreb](https://github.com/aebrer/dreb) coding agent, embedded in VS Code as a webview. It drives dreb over its RPC protocol (`RpcClient` from `@dreb/coding-agent/rpc`) and streams responses into a chat panel — separating the agent's thinking/tool activity from its final answer, with slash commands and inline prompts.

This package is modeled on `@dreb/dashboard`: an extension **host** owns the RPC child and the authoritative transcript state, and a **webview** renders it. The only transport difference is that the dashboard's HTTP+SSE layer is replaced by VS Code's `postMessage` bridge.

> Status: **Phase 9** (session lifecycle robustness — reopening a session always re-activates it, restarting a crashed session from its transcript instead of showing a dead panel; sleep-on-idle is now two configurable inactivity timers: a detached-idle deactivation and a no-user-input cap that bounds abandoned/running sessions) on top of Phase 7 (background sessions — a closed chat never interrupts a working agent; the session keeps running in the background and, once idle, sleeps to release its RPC child until reopened; run-state shows in the tab title and the sidebar), Phase 6 (session tree — Copilot-style inline restore-checkpoint + fork controls in the chat, plus a branch-tree view), Phase 5b (clickable code links — file/symbol references in answers open the code in the editor, grounded in the session's own tool results), Phase 5 (sessions side panel — a Copilot-style sidebar listing sessions with live status, resume, rename, pin, archive, delete; multiple sessions run concurrently), Phase 4b (context tagging — tag an editor selection or a file/folder into the current chat), Phase 3 (change review — per-turn git snapshot + per-hunk keep/reject), Phase 2 (built-in slash commands + TUI-parity status header), and the Phase 0 + 1 foundation. See the [tracking issue](https://github.com/Hrovatin/dreb/issues/12) for the roadmap.

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
    session-view-lifecycle.ts sleep-on-inactivity driver — backgrounds a closed session, sleeps it on an idle timer or a no-user-input cap; treats a crashed controller as not-reusable so reopen restarts it (pure, tested)
    session-inventory.ts on-disk session enumeration via @dreb/coding-agent's SessionManager (vscode-free)
    session-flags.ts    pin/archive persistence over globalState, keyed by session path (pure seam, tested)
    sessions-view-model.ts sidebar list-building + action routing (pure, vscode-free, tested)
    sessions-view.ts    the `dreb.sessions` WebviewView glue (postMessage transport + HTML shell)
    tag-selection.ts    tag-selection-into-chat orchestration (pure, vscode-free, tested)
    workspace-search.ts @-typeahead pure helpers — folder name-matching over a directory-listing walk + structural-symbol filtering (vscode-free, tested)
    host-ui.ts          native-prompt port (quick pick / input / dialogs); vscode-free
    vscode-host-ui.ts   the real `HostUi` backed by `vscode.window`
    git-snapshot.ts     per-turn baseline capture + diff + `git apply -R` (pure node, tested)
    diff-hunks.ts       unified-diff hunk parsing / slicing (pure, tested)
    review-model.ts     change-review cycle + accept state (pure, tested)
    review-ui.ts        SCM / quick-diff / diff-viewer port; vscode-free
    vscode-review-ui.ts the real `ReviewUi` backed by `vscode.scm`
    source-link-ui.ts   clicked-code-link open/resolve port; vscode-free
    vscode-source-link-ui.ts the real `SourceLinkUi` (open file / resolve symbol → definition)
  shared/
    format.ts           status-header + `/session` display formatters (pure, tested)
    tagged-context.ts   selection + file/folder/symbol context DTOs, chip label, prompt fold + threshold (pure, tested)
    mention.ts          `@`/`@@` composer trigger parsing, glob escaping, and typeahead result ranking (pure, tested)
    session-list.ts     disk+live session reconciliation, grouping, deterministic ordering, status (pure, tested)
    sidebar-protocol.ts host ↔ sessions-sidebar message envelopes (no @dreb import)
  webview/       # SolidJS UI — bundled with Vite → dist/webview (chat) + dist/webview-sidebar (sessions)
    app.tsx             transcript, collapsible activity box, composer, needs-input,
                        the status header (model · thinking · cost · ctx), the
                        change-review bar, and the inline restore/fork checkpoint
                        controls + branch-tree overlay (Phase 6)
    code-links.ts       grounded file/symbol linkification of answers (pure, tested)
    composer-resize.ts  clamp helper for the drag-resizable composer height (pure, tested)
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

## Queued messages (send while working)

You don't have to wait for the agent to finish before typing your next instruction. Sending a message while a turn is in flight **steers** it — the message is injected into the running turn (rather than being rejected as a mid-stream `prompt`, which would silently drop it). Queued messages show as **chips above the composer** ("2 queued messages") until they're delivered, so nothing you send is invisible.

Pressing **Stop** aborts the current turn. Because an abort leaves any still-queued messages undelivered, the extension **clears the queue and restores that text back into the composer** — you decide whether to resend it, rather than losing it. If you'd already started typing a new message when you hit Stop, the restored text is **prepended before your draft** (queued messages first, then your in-progress text) so neither is lost — never overwriting what you were typing. The pending queue is host-authoritative (refreshed from the RPC child on run transitions and after each queued submit) so the chips survive a webview reload.

## Change review

Because the agent runs out-of-process and writes edits straight to disk, the extension can't hold changes in an unsaved overlay. Instead it **snapshots a git baseline before each turn** and reviews the working tree against it (the non-interactive analogue of `git restore -p`):

- **Baseline** — before the first turn of a review cycle, `git-snapshot.ts` captures the working tree into a git tree object via a *throwaway index*, so neither your real index nor working tree is touched. Because it snapshots the tree *as-is* (including your own uncommitted edits), later diffs isolate **only** what the agent changed. Changes **compound** across turns until you accept or revert.
- **Detection** — after each turn (`agent_end`), a baseline→current tree diff lists the changed files (adds/mods/deletes, git-detected — so `bash`-tool writes count too), shown in a **change-review bar** in the webview and an SCM group **"dreb — pending review"** with inline change gutters (via a `QuickDiffProvider` pointed at the baseline).
- **Keep / reject** — the `dreb.review.*` commands accept a file (clear its marker — **no commit**), accept/revert all, revert a whole file to baseline, or **reject the hunk at the cursor** (`dreb.review.rejectHunkAtCursor`, which drives `git apply --reverse` on exactly that hunk). Rejecting a hunk restores only that region and never clobbers your own pre-existing edits. The change-review bar in chat also has an **"Accept all"** button that clears every pending edit from the review accumulation area in one click (the same accept-all path as the SCM title action — no commit), so you can dismiss the review set without leaving the chat.

Review is host-authoritative, so it survives webview reload. Outside a git repository it degrades gracefully (disabled, no snapshots). The pure logic (`review-model.ts`, `diff-hunks.ts`) and the git plumbing (`git-snapshot.ts`, against real temp repos) are unit-tested; all `vscode` SCM/diff calls are isolated behind the `ReviewUi` port.

## Sessions sidebar

The **dreb** activity-bar container hosts a **Sessions** side panel (a SolidJS `WebviewView`, bundled separately into `dist/webview-sidebar`) that lists your dreb sessions Copilot-style:

- **Grouping & ordering** — sessions in the **current workspace** are listed first ("This workspace"); sessions from **other working directories** appear in collapsible per-project groups below; **archived** sessions collapse into their own section. Ordering is **deterministic** (per this repo's "Determinism Over Recency" rule): pinned first, then most-recently-modified — live run-state never reorders rows, so cards don't jump around while streaming.
- **Sources** — on-disk sessions are enumerated host-side via `@dreb/coding-agent`'s `SessionManager` (`list` / `listAll`, no RPC child needed); live sessions come from the pool. A live controller and its disk row are the **same** session (reconciled by session-file path) and show as one row — `session-list.ts` owns this pure merge/group/sort.
- **Live status** — each row shows **running** (agent streaming), **needs input** (awaiting a selection/confirmation prompt), or **idle/done**, derived from the projected transcript (`streaming` / `uiRequests`). The sidebar refreshes (debounced) as controllers stream — including for **backgrounded** sessions with no open tab.
- **Multiple concurrent sessions** — selecting a session **opens or resumes** it in a chat panel (resume passes `--session <path>` to the RPC child). Several sessions run **at once** and keep running when you switch tabs/focus: the single-slot registry is now a keyed **`SessionPool`** holding one live panel per session key.
- **Background sessions (sleep-on-inactivity)** — closing a chat tab **never interrupts a working agent**. Only the webview view detaches (via `webview-bridge.ts`); the `SessionController` and its RPC child keep running in the background. Two configurable timers then govern when a session **sleeps** (its controller is disposed and its child released, leaving a resumable on-disk row that reopening restores from the persisted transcript):
  - **Idle deactivation** (`dreb.session.idleSleepMinutes`, default **60**) — a **detached + idle** session (tab closed, turn finished, nothing pending) sleeps after this many minutes. Reopening the tab before it fires reattaches instantly with no loss. A **running** or **needs-input** session is never slept by this timer.
  - **Inactivity cap** (`dreb.session.inactivitySleepHours`, default **4**) — any session with **no user input** for this many hours sleeps **regardless of state** — including a focused tab, a session awaiting input, and a running turn. This is the abandonment/runaway backstop so an unanswered prompt or a hung agent cannot hold an RPC child indefinitely; the timer resets on every submit or prompt answer.

  Either setting can be `0` to disable that timer; whichever fires first wins. This policy lives in the pure, tested `session-view-lifecycle.ts`; the vscode glue (detach on `onDidDispose`, reattach a fresh panel on reopen) is in `extension.ts`.
- **Reopen always re-activates** — reopening a session from the sidebar always yields a live, connected session. A backgrounded-but-live session **reattaches** its existing controller (no restart, no interruption); a slept, `/quit`-ended, or disk-only row rebuilds fresh from disk; and a **crashed** session (its RPC child exited unexpectedly) is **restarted** from its persisted transcript rather than revealing a dead panel — the host treats a failed controller as not-reusable (`SessionController.hasFailed()`). Before you reopen it, a crashed session keeps its **needs input** indicator (the input is genuinely still needed).
- **Status in the tab** — the chat panel's **tab title** reflects run-state (`dreb ● running`, `dreb ⚠ needs input`, or `dreb`), so a background/unfocused session's status is visible in the editor tab strip. There are **no** toast notifications — the tab title and sidebar icon are the only attention surfaces.
- **Stop** — a **Stop** action on a running / needs-input row aborts the current turn and ends the session (releasing its RPC child). This is the only way to deliberately interrupt a working agent — closing a tab never aborts.
- **Organize** — **rename** (persisted via the `set_session_name` RPC; a closed session is renamed by briefly spawning a headless resume child), **pin**, **archive** (hidden from the main list, not deleted — retained on disk and reachable under "Archived"), and **delete** (behind a modal confirmation; routed through dreb's `SessionManager.deleteSession` — trash-first with a permanent-unlink fallback, `.jsonl` validation, and an active-session guard — clearing the persisted flags only once the delete succeeds). Pin/archive flags persist in `globalState`, keyed by session path.

The list-building and action routing live in the vscode-free `sessions-view-model.ts` (unit-tested with fakes); `sessions-view.ts` is the thin `WebviewView` transport, mirroring `webview-bridge.ts`. The concurrency-safe pool core stays in the pure, tested `session-registry.ts`.

## Editor integration

Tag context into the chat as removable chips. Two kinds of context can be tagged, and both accumulate as chips in the composer that you can remove before sending:

**Editor selection.** Select any range (a whole line or part of one) and run **dreb: Add Selection to Chat** — from the command palette or the editor right-click menu (shown only when there is a selection, `when: editorHasSelection`). The selection is added as a **removable chip** labelled `basename:line` (or `basename:start-end`). On send, a small selection is folded into the prompt as a located, fenced code block (workspace-relative path + line range) so the agent knows exactly where the code came from. A **large** selection (over `MAX_INLINE_SELECTION_LINES` = 40 lines, or `MAX_INLINE_SELECTION_CHARS` = 2000 characters) instead folds as a `` `path` (lines a-b) `` reference only, to keep the prompt short. The selection is captured **at tag time** (a pre-resolved snapshot, not a lazy reference).

**File / folder / symbol.** Type `@` in the composer to open an **inline typeahead** that filters the workspace as you keep typing — matching **folders**, **files**, and code **symbols** (classes/functions/methods/…), ordered folders → files → symbols. Pick an entry to insert an inline **`@name` reference** at the caret (the chip label — `@app.ts`, `@host/` for a folder, `@Symbol`) **and** add it as a chip. Type `@@` instead to open the full **native** VS Code file/folder picker (`showOpenDialog` with files and folders selectable, multi-select) for cases the typeahead doesn't surface; each pick likewise inserts an inline `@name` reference at the caret in addition to its chip. Each chosen entry is a **removable chip** (`basename`, `basename/` for a folder, or the symbol name). On send, a file/folder tag folds into the prompt as a **path reference only — never the contents** (e.g. `` `src/app.ts` `` or `` `src/host/` (directory) ``), so the agent can open and explore it as needed without bloating the prompt. Paths are workspace-relative when the pick is inside the workspace; the workspace root itself folds as `` `./` (directory) ``, and a pick outside the workspace uses its **absolute** path so the reference stays unambiguous (rather than a bare basename that could collide with a same-named file under the workspace).

The typeahead search runs host-side (debounced, capped, and ranked by filename-prefix match): folders come from a bounded breadth-first `readDirectory` walk of the open workspace roots (which lists **all** subdirectories, so **empty** folders surface too — unlike a `findFiles` file-ancestor derivation), files from `findFiles`, and symbols from the workspace symbol provider — each source degrades independently, so a failing source just drops its own rows rather than emptying the dropdown.

dreb's agent accepts text + images only, so there is no separate structured-context channel: all tags are folded into the prompt text. Sending with only chips and no typed text is allowed. Tagging with no chat open opens one first, then attaches.

The pure DTO builders, chip label/title, threshold logic, and prompt formatter are unit-tested in `shared/tagged-context.ts`; the selection command orchestration lives in the vscode-free `host/tag-selection.ts`; the native picker and the typeahead search are driven through the `HostUi` port (`pickWorkspaceFiles`, `searchWorkspace`), so the controller stays vscode-free. The typeahead's pure derivation logic (folder name-matching over the directory-listing walk, structural-symbol filtering) lives in `host/workspace-search.ts`, the inline-reference insertion (`mentionReference`) and the `@`/`@@` trigger parsing in `shared/mention.ts` — all vscode-free and unit-tested. Native `@@`-picker tags carry a `picker` origin so the composer inserts an inline reference for them while editor-selection tags stay chip-only. Delivery to the composer is queued until the webview is `ready` so tagging into a freshly opened chat still lands.


## Clickable code links

File paths and code symbols that appear in an answer render as **clickable links** that open the referenced code at the right spot in the editor.

- **File references** — a `path:line[:col]` (e.g. `src/app.ts:38`) or a workspace-relative path with a directory + extension render as links. Clicking opens the file and selects/reveals the line (1-based line/column from the answer are converted to VS Code's 0-based `Position`).
- **Symbol references** — a class/function name renders as a link **only when it is grounded** — i.e. it actually appeared in this response's own tool results (`search`/`grep`). Clicking prefers the symbol's real **definition** via the workspace symbol provider; if the language server finds nothing, it falls back to the **grounded location** captured from the tool hit. This grounding gate is what keeps ordinary prose from being over-linkified.
- **Reliability lives in the client, not the model.** The agent is never trusted to emit valid links: the webview linkifies syntactically/greedily but only *grounds* ambiguous symbols against real tool hits, and the host **validates** on click (a path that does not exist, or a symbol that resolves nowhere, shows an unobtrusive notice — never a broken jump). References that match nothing real simply stay plain text.
- Links are wired via **event delegation → `postToHost`** (not `href` navigation), so they work under the webview's strict `default-src 'none'` CSP.

Grounding + linkification are pure and unit-tested in `webview/code-links.ts` (`buildGroundedRefs` parses the tool-output formats; `linkifyAnswer` walks the sanitized answer DOM without corrupting existing markdown links/code spans). The open/resolve logic is driven through the vscode-free `host/source-link-ui.ts` port (real impl `host/vscode-source-link-ui.ts`), so the controller stays testable. A grounded symbol carries its usage location so the host can jump even before the language server resolves; semantic-search-based resolution is a possible future deepening.

## Session tree — restore checkpoint + fork

Every conversation is a **branch tree**: you can rewind to an earlier point or fork a new line of conversation, without losing the branches you leave behind.

- **Inline controls (Copilot-style).** After each response the transcript shows a subtle **"Restore Checkpoint · ⑃ Fork"** divider. **Restore Checkpoint** rewinds the conversation to that turn; **Fork** branches a new line of conversation from it. **Restore Checkpoint is omitted at the current turn** (restoring to where you already are is a no-op), and **Fork is shown only where the session can actually branch** — turns the backend refuses to fork from (errored/aborted turns, or turns whose tool results live in descendant entries that a branch cannot carry) hide the Fork control rather than offering a click that only surfaces a "Couldn't fork…" notice. When a turn offers neither control, its divider is not rendered at all.
- **Fork semantics.** Forking at an assistant turn continues from that answer (your composer is untouched); forking at a user turn pre-fills the composer with that message's re-ask text. Cancelling a fork or restore surfaces an unobtrusive notice and leaves the conversation untouched.
- **Branch-tree view.** The header's **⑃ tree** button opens an overlay of every turn on every branch (the current leaf is marked); picking any node jumps there — so a forked or rewound branch is always reachable again.
- **Reuses the existing RPC surface.** Fork/restore/tree are wired over dreb's `fork` / `get_fork_messages` / `get_tree` / `navigate_tree` / `get_messages` commands — no backend changes. The webview never holds session entry ids; the host derives them from the session tree and aligns them to the rendered turns.

After a restore or fork moves the leaf (and on resume of a persisted session), the host rebuilds the transcript from the target branch (`SessionController.rebuildTranscript`) and re-snapshots the webview via the same `resync` path as `/new` and `/import`. The rebuild fetches the branch's **full provider messages** (`get_messages`) and folds them into the same `ResponseGroup` model the live event stream builds, so a restored/forked/resumed chat renders **identically to a fresh live chat** — full markdown answers plus one collapsible thinking/tool activity box per run (no truncated previews, no `(no content)`/`(aborted)` placeholders). If the reload RPCs fail *after* the backend already moved the leaf, the host resets and resyncs to a clean state with a notice (parity with the resume guard) rather than leaving the pre-move branch on screen. The pure pieces — `foldMessagesIntoState` (rebuild: one group per agent run, delimited by user messages, with `thinking`/`toolCall` parts folded into the activity box and paired to their `toolResult` by id) and `alignCheckpoints` (map response groups → **run-terminal** entry ids, anchored to the most recent turn so an interrupted or tool-using run can't misalign the rest) — live in `shared/projection.ts` and are unit-tested; the inline controls and branch-tree overlay (`CheckpointBar` / `TreePanel` in `webview/app.tsx`) post to the host under the strict CSP via event delegation, and all host logic stays vscode-free (RPC-faked in tests).


## Resizable composer

The message composer can be **dragged taller** so long prompts get more room, up to ~80% of the panel height, then collapsed back to its compact two-row default.

- **Top drag handle.** A thin grip along the composer's top edge (a focusable `<hr>` with the implicit ARIA **separator/splitter** role) is dragged with the pointer to set the height; **double-click** it to snap back to the natural height. Because the composer is bottom-docked, the handle sits on top rather than using a native bottom-right resize corner.
- **Keyboard resizable.** With the handle focused, **↑/↓** grow/shrink by a step, **Home** resets to the compact default, and **End** maximizes; `aria-valuemin`/`valuemax`/`valuenow` are kept in sync for screen readers.
- **Pure, tested clamp.** The height math is isolated in `webview/composer-resize.ts` (`clampComposerHeight`) — DOM-independent and unit-tested (including the degenerate `max < min` case) — while `app.tsx` owns the pointer/keyboard wiring and window-level listener lifecycle.


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
| `dreb.session.idleSleepMinutes` | Minutes a detached + idle session stays alive before sleeping (releasing its RPC child). Reopening before then reattaches losslessly. Default `60`; `0` disables; an invalid value falls back to the default. |
| `dreb.session.inactivitySleepHours` | Hours without user input after which a session sleeps regardless of state (including a focused, awaiting-input, or running session). Resets on submit / prompt answer. Default `4`; `0` disables; an invalid value falls back to the default. |

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
