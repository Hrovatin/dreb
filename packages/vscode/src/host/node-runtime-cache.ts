/**
 * Cache + one-time-warning glue around {@link resolveNodePath}.
 *
 * Resolving a Node runtime spawns a synchronous `node --version` probe per
 * candidate, so the result is memoized (keyed by the `dreb.nodePath` setting) to
 * avoid re-probing — and stalling the extension host — on every session
 * create/rename. The cache is invalidated when the setting value changes.
 *
 * The Electron fallback rung is intentionally not version-gated (it must always
 * yield a runnable executable), but the CLI targets Node >=22, so we warn once
 * when the editor's own runtime is older than {@link MIN_NODE_MAJOR}.
 *
 * All of this is pure and injectable (no `vscode` import) so it is unit-testable
 * without loading the extension host.
 */

import { MIN_NODE_MAJOR, type NodePathResult, resolveNodePath } from "./node-path.js";

/** Mutable state carried across `resolveNodeRuntimeCached` calls. */
export interface NodeRuntimeCacheState {
	/** Last resolution, keyed by the `dreb.nodePath` setting it was resolved for. */
	cache?: { key: string; result: NodePathResult };
	/** Whether the older-editor-runtime warning has already been shown. */
	warnedElectronVersion: boolean;
}

/** Fresh state for a session/extension activation. */
export function createNodeRuntimeCacheState(): NodeRuntimeCacheState {
	return { warnedElectronVersion: false };
}

export interface ResolveNodeRuntimeDeps {
	/** The current `dreb.nodePath` setting value (empty string when unset). */
	configuredNodePath: string;
	/** Resolver (defaults to {@link resolveNodePath}); injectable for tests. */
	resolve?: (opts: { configuredPath: string }) => NodePathResult;
	/** Called at most once with the warning message when the editor's own Node
	 * runtime is older than {@link MIN_NODE_MAJOR}. */
	warn?: (message: string) => void;
}

/** The message shown when falling back to an editor runtime older than required. */
export function electronVersionWarning(major: number): string {
	return `dreb: no Node ${MIN_NODE_MAJOR}+ found on PATH; falling back to the editor's Node ${major} runtime, which is older than dreb requires. Set "dreb.nodePath" to a Node ${MIN_NODE_MAJOR}+ executable if you hit runtime errors.`;
}

/**
 * Resolve the Node runtime, reusing the cached result when the `dreb.nodePath`
 * setting is unchanged and warning once when the editor runtime is too old.
 * Mutates `state`.
 */
export function resolveNodeRuntimeCached(state: NodeRuntimeCacheState, deps: ResolveNodeRuntimeDeps): NodePathResult {
	const configuredNode = deps.configuredNodePath;
	const resolve = deps.resolve ?? resolveNodePath;

	if (state.cache?.key !== configuredNode) {
		state.cache = { key: configuredNode, result: resolve({ configuredPath: configuredNode }) };
	}
	const node = state.cache.result;

	if (
		node.source === "electron" &&
		node.major != null &&
		node.major < MIN_NODE_MAJOR &&
		!state.warnedElectronVersion
	) {
		state.warnedElectronVersion = true;
		deps.warn?.(electronVersionWarning(node.major));
	}

	return node;
}
