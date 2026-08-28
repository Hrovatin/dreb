/**
 * Resolve the absolute path to the dreb CLI entry point (`dist/cli.js`), which
 * `RpcClient` spawns as `node <cliPath> --mode rpc`. `RpcClient` defaults to a
 * cwd-relative `"dist/cli.js"`, so the host must always pass an absolute path.
 *
 * Precedence (repo-as-distribution: the extension is installed from within a
 * user's dreb monorepo, where a built `@dreb/coding-agent` already exists):
 *   1. the `dreb.cliPath` setting (explicit override);
 *   2. the CLI shipped in the same monorepo, resolved relative to this
 *      extension's own location (`packages/vscode` -> `../coding-agent/dist/cli.js`).
 *      This is deterministic and does not depend on `node_modules` layout, so a
 *      symlinked repo-local install "just works" with no setting;
 *   3. dependency resolution via `@dreb/coding-agent`'s package entry (dev fallback).
 *
 * All I/O is injectable so the precedence logic is unit-testable without a real
 * filesystem or a resolvable dependency.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CliPathSources {
	/** The `dreb.cliPath` setting value; empty/whitespace means unset. */
	configuredPath?: string;
	/** This extension's own directory (`packages/vscode`), used to resolve the
	 * sibling `packages/coding-agent/dist/cli.js` in the same monorepo. Defaults
	 * to a location derived from this module's URL. */
	extensionDir?: string;
	/** Directory that should contain `cli.js` (defaults to dependency resolution). */
	resolveCliDir?: () => string | undefined;
	/** Existence probe (defaults to `fs.existsSync`). */
	fileExists?: (path: string) => boolean;
}

export type CliPathResult =
	| { ok: true; path: string; source: "setting" | "repo" | "dependency" }
	| { ok: false; error: string };

export function resolveCliPath(sources: CliPathSources = {}): CliPathResult {
	const exists = sources.fileExists ?? existsSync;

	// 1. Explicit setting wins when it points at a real file.
	const configured = sources.configuredPath?.trim();
	if (configured) {
		if (exists(configured)) return { ok: true, path: configured, source: "setting" };
		return {
			ok: false,
			error: `The "dreb.cliPath" setting points to "${configured}", but no file exists there.`,
		};
	}

	// 2. Sibling CLI in the same monorepo, resolved relative to this extension.
	const extensionDir = sources.extensionDir ?? defaultExtensionDir();
	if (extensionDir) {
		const candidate = repoRelativeCliPath(extensionDir);
		if (exists(candidate)) return { ok: true, path: candidate, source: "repo" };
	}

	// 3. Dependency resolution (dev / non-monorepo fallback).
	const resolveCliDir = sources.resolveCliDir ?? defaultResolveCliDir;
	const dir = resolveCliDir();
	if (dir) {
		const candidate = join(dir, "cli.js");
		if (exists(candidate)) return { ok: true, path: candidate, source: "dependency" };
	}

	return {
		ok: false,
		error: 'Could not locate the dreb CLI. Install the extension from within your dreb folder (run the repo-local install), or set the "dreb.cliPath" setting to the absolute path of packages/coding-agent/dist/cli.js.',
	};
}

/** `packages/vscode` -> `packages/coding-agent/dist/cli.js` (sibling package). */
export function repoRelativeCliPath(extensionDir: string): string {
	return join(extensionDir, "..", "coding-agent", "dist", "cli.js");
}

/**
 * Derive this extension's directory from the compiled module location. At
 * runtime this file is `packages/vscode/dist/host/cli-path.js`, so three parent
 * hops land on `packages/vscode`. Under a symlinked repo-local install Node
 * resolves real paths, so this lands inside the actual repo.
 */
export function defaultExtensionDir(): string | undefined {
	try {
		const here = fileURLToPath(import.meta.url); // .../packages/vscode/dist/host/cli-path.js
		return dirname(dirname(dirname(here))); // .../packages/vscode
	} catch {
		return undefined;
	}
}

/**
 * Resolve the directory holding `@dreb/coding-agent`'s compiled entry point.
 * Uses `import.meta.resolve` (the package is ESM-only, so a CJS `require.resolve`
 * cannot reach it) — the same approach the dashboard's runtime pool uses.
 */
function defaultResolveCliDir(): string | undefined {
	try {
		const resolved = import.meta.resolve("@dreb/coding-agent");
		return dirname(fileURLToPath(resolved));
	} catch {
		return undefined;
	}
}
