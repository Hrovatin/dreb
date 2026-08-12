# dreb for VS Code

A native chat client for the [dreb](https://github.com/aebrer/dreb) coding agent, embedded in VS Code as a webview. It drives dreb over its RPC protocol (`RpcClient` from `@dreb/coding-agent/rpc`) and streams responses into a chat panel — separating the agent's thinking/tool activity from its final answer, with slash commands and inline prompts.

This package is modeled on `@dreb/dashboard`: an extension **host** owns the RPC child and the authoritative transcript state, and a **webview** renders it. The only transport difference is that the dashboard's HTTP+SSE layer is replaced by VS Code's `postMessage` bridge.

> Status: **Phase 2** (built-in slash commands + TUI-parity status header) on top of the Phase 0 + 1 foundation and MVP chat. See the [tracking issue](https://github.com/Hrovatin/dreb/issues/12) for the roadmap.

## Architecture

```
src/
  shared/        # DTOs + pure projection reducer (imported by BOTH sides)
    protocol.ts       host ↔ webview message envelopes (no @dreb import)
    projection.ts     RPC events → transcript render model (pure, tested)
  host/          # extension host (Node, ESM) — compiled with tsgo
    extension.ts        activate(): registers `dreb.openChat`, owns the panel
    session-controller.ts  one RpcClient + authoritative transcript per session
    webview-bridge.ts   postMessage wiring + webview HTML/CSP
    cli-path.ts         resolve the dreb CLI (setting → dependency)
    slash-router.ts     route composer text → prompt vs builtin RPC (pure, tested)
    session-registry.ts single-live-panel lifecycle (reentrancy-safe, pure, tested)
    host-ui.ts          native-prompt port (quick pick / input / dialogs); vscode-free
    vscode-host-ui.ts   the real `HostUi` backed by `vscode.window`
  shared/
    format.ts           status-header + `/session` display formatters (pure, tested)
  webview/       # SolidJS UI — bundled with Vite → dist/webview
    app.tsx             transcript, collapsible activity box, composer, needs-input,
                        and the status header (model · thinking · cost · ctx)
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
