/**
 * Pure filesystem-path helpers for the extension host.
 *
 * No `vscode` import, so these are unit-testable in plain node. The realpath
 * resolution here backs both repo-relative CLI resolution and — crucially — the
 * webview `localResourceRoots` / `asWebviewUri` construction: a repo-local
 * install (`npm run install-vscode`) symlinks `packages/vscode` into
 * `~/.vscode/extensions`, and VS Code's webview resource server realpath-resolves
 * every requested file before checking it against the allowed roots. If the roots
 * are built from the symlink path, the resolved file path won't match and the
 * webview's `main.js`/`main.css` 404 (blank chat). Resolving the root to its real
 * path here makes both sides agree.
 */

import { realpathSync } from "node:fs";

/**
 * Resolve a filesystem path through symlinks, falling back to the raw path when
 * resolution fails (e.g. a dangling link after the repo was moved/deleted).
 *
 * `realpath` is injectable so the fallback branch is unit-testable without a real
 * filesystem. For a plain (non-symlinked) path this is effectively a no-op —
 * `realpathSync` returns the same canonical path — so `.vsix` and F5 installs are
 * unaffected.
 */
export function resolveRealFsPath(rawFsPath: string, realpath: (p: string) => string = realpathSync): string {
	try {
		return realpath(rawFsPath);
	} catch {
		return rawFsPath;
	}
}
