# dreb for VS Code

A native chat client for the [dreb](https://github.com/aebrer/dreb) coding agent, embedded in VS Code as a webview. It drives dreb over its RPC protocol (`RpcClient` from `@dreb/coding-agent/rpc`) and streams responses into a chat panel — separating the agent's thinking/tool activity from its final answer, with slash commands and inline prompts.

This package is modeled on `@dreb/dashboard`: an extension **host** owns the RPC child and the authoritative transcript state, and a **webview** renders it. The only transport difference is that the dashboard's HTTP+SSE layer is replaced by VS Code's `postMessage` bridge.

> Status: **Phase 0 + 1** (foundation + MVP chat). See the [tracking issue](https://github.com/Hrovatin/dreb/issues/12) for the roadmap.

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
  webview/       # SolidJS UI — bundled with Vite → dist/webview
    app.tsx             transcript, collapsible activity box, composer, needs-input
```

- The host keeps the authoritative `TranscriptState`. On (re)load the webview announces `ready` and receives a full snapshot, so recreating the webview never loses the conversation.
- Host and webview apply the **same** pure `applyEvent` reducer, so live streaming and the reload snapshot stay consistent.

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
