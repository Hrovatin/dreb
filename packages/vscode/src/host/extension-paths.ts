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

/** Mutable cache for the extension's realpath-resolved install directory. */
export interface ExtensionRealDirState {
	/** Last SUCCESSFUL realpath resolution; unset until one succeeds so a
	 * transient failure never pins a fallback (see {@link resolveExtensionRealDir}). */
	cache?: string;
}

/** Fresh state for an extension activation. */
export function createExtensionRealDirState(): ExtensionRealDirState {
	return {};
}

export interface ResolveExtensionRealDirDeps {
	/** Raw extension install path (`context.extensionUri.fsPath`), or undefined
	 * before activation has set the context. */
	rawFsPath?: string;
	/** Realpath resolver (defaults to `realpathSync`); injectable for tests. */
	realpath?: (p: string) => string;
	/** Called with the raw path and error when realpath fails and the raw path is
	 * used as a fallback (never on success). */
	onError?: (rawFsPath: string, err: unknown) => void;
}

/**
 * Resolve the extension's own directory through symlinks, memoizing **only a
 * successful** resolution. On failure it returns the raw path **without** caching,
 * so a later call re-attempts realpath and self-heals once the filesystem
 * recovers — a transient failure must never pin the (possibly-symlinked) fallback
 * for the whole session, or the webview roots built from it would 404 (blank chat)
 * until a full window reload. Returns `undefined` when no raw path is available
 * (pre-activation). Mutates `state`.
 */
export function resolveExtensionRealDir(
	state: ExtensionRealDirState,
	deps: ResolveExtensionRealDirDeps,
): string | undefined {
	if (state.cache) return state.cache;
	const raw = deps.rawFsPath;
	if (!raw) return undefined;
	const { path, resolved } = tryResolveRealFsPath(raw, deps.realpath, (err) => deps.onError?.(raw, err));
	if (resolved) state.cache = path;
	return path;
}
