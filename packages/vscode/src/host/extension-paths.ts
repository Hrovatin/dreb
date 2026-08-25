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

/** Outcome of a realpath resolution attempt. */
export interface RealFsPathResolution {
	/** The resolved real path on success, or the raw input path on fallback. */
	path: string;
	/** True when `realpath` succeeded; false when the raw path was used as a fallback. */
	resolved: boolean;
}

/**
 * Resolve a filesystem path through symlinks, reporting whether resolution
 * actually succeeded. On failure (e.g. a dangling link after the repo was
 * moved/deleted) it returns the raw path with `resolved: false` and invokes the
 * optional `onError` hook — callers use the flag to avoid permanently caching a
 * fallback so a transient failure can self-heal on a later call.
 *
 * `realpath` and `onError` are injectable so the fallback branch is unit-testable
 * without a real filesystem. For a plain (non-symlinked) path this is effectively
 * a no-op — `realpathSync` returns the same canonical path — so `.vsix` and F5
 * installs are unaffected.
 */
export function tryResolveRealFsPath(
	rawFsPath: string,
	realpath: (p: string) => string = realpathSync,
	onError?: (err: unknown) => void,
): RealFsPathResolution {
	try {
		return { path: realpath(rawFsPath), resolved: true };
	} catch (err) {
		onError?.(err);
		return { path: rawFsPath, resolved: false };
	}
}

/**
 * Convenience wrapper around {@link tryResolveRealFsPath} that returns just the
 * resolved (or fallback) path, discarding the success flag.
 */
export function resolveRealFsPath(rawFsPath: string, realpath: (p: string) => string = realpathSync): string {
	return tryResolveRealFsPath(rawFsPath, realpath).path;
}
