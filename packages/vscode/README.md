# dreb for VS Code

A native chat client for the [dreb](https://github.com/aebrer/dreb) coding agent, embedded in VS Code as a webview. It drives dreb over its RPC protocol (`RpcClient` from `@dreb/coding-agent/rpc`) and streams responses into a chat panel — separating the agent's thinking/tool activity from its final answer, with slash commands and inline prompts.

This package is modeled on `@dreb/dashboard`: an extension **host** owns the RPC child and the authoritative transcript state, and a **webview** renders it. The only transport difference is that the dashboard's HTTP+SSE layer is replaced by VS Code's `postMessage` bridge.

> Status: **Phase 3** (change review — per-turn git snapshot + per-hunk keep/reject) on top of Phase 2 (built-in slash commands + TUI-parity status header) and the Phase 0 + 1 foundation. See the [tracking issue](https://github.com/Hrovatin/dreb/issues/12) for the roadmap.

## Architecture

```
src/
  shared/        # DTOs + pure projection reducer (imported by BOTH sides)
    protocol.ts       host ↔ webview message envelopes (no @dreb import)
    projection.ts     RPC events → transcript render model (pure, tested)
  host/          # extension host (Node, ESM) — compiled with tsgo
    extension.ts        activate(): registers `dreb.openChat` + review commands
    session-controller.ts  one RpcClient + authoritative transcript per session
    webview-bridge.ts   postMessage wiring + webview HTML/CSP
    cli-path.ts         resolve the dreb CLI (setting → dependency)
    slash-router.ts     route composer text → prompt vs builtin RPC (pure, tested)
    session-registry.ts single-live-panel lifecycle (reentrancy-safe, pure, tested)
    host-ui.ts          native-prompt port (quick pick / input / dialogs); vscode-free
    vscode-host-ui.ts   the real `HostUi` backed by `vscode.window`
    git-snapshot.ts     per-turn baseline capture + diff + `git apply -R` (pure node, tested)
    diff-hunks.ts       unified-diff hunk parsing / slicing (pure, tested)
    review-model.ts     change-review cycle + accept state (pure, tested)
    review-ui.ts        SCM / quick-diff / diff-viewer port; vscode-free
    vscode-review-ui.ts the real `ReviewUi` backed by `vscode.scm`
  shared/
    format.ts           status-header + `/session` display formatters (pure, tested)
  webview/       # SolidJS UI — bundled with Vite → dist/webview
    app.tsx             transcript, collapsible activity box, composer, needs-input,
                        the status header (model · thinking · cost · ctx), and the
                        change-review bar
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
