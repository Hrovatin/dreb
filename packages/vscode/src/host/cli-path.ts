/**
 * Resolve the absolute path to the dreb CLI entry point (`dist/cli.js`), which
 * `RpcClient` spawns as `node <cliPath> --mode rpc`. `RpcClient` defaults to a
 * cwd-relative `"dist/cli.js"`, so the host must always pass an absolute path.
 *
 * Precedence (mirrors the plan's layered resolution):
 *   1. the `dreb.cliPath` setting (explicit override, required for packaged
 *      `.vsix` installs that do not ship the CLI on disk);
 *   2. dependency resolution via `@dreb/coding-agent`'s package entry.
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
	/** Directory that should contain `cli.js` (defaults to dependency resolution). */
	resolveCliDir?: () => string | undefined;
	/** Existence probe (defaults to `fs.existsSync`). */
	fileExists?: (path: string) => boolean;
}

export type CliPathResult = { ok: true; path: string; source: "setting" | "dependency" } | { ok: false; error: string };

export function resolveCliPath(sources: CliPathSources = {}): CliPathResult {
	const exists = sources.fileExists ?? existsSync;

	const configured = sources.configuredPath?.trim();
	if (configured) {
		if (exists(configured)) return { ok: true, path: configured, source: "setting" };
		return {
			ok: false,
			error: `The "dreb.cliPath" setting points to "${configured}", but no file exists there.`,
		};
	}

	const resolveCliDir = sources.resolveCliDir ?? defaultResolveCliDir;
	const dir = resolveCliDir();
	if (dir) {
		const candidate = join(dir, "cli.js");
		if (exists(candidate)) return { ok: true, path: candidate, source: "dependency" };
	}

	return {
		ok: false,
		error: 'Could not locate the dreb CLI. Ensure @dreb/coding-agent is installed, or set the "dreb.cliPath" setting to the absolute path of its dist/cli.js.',
	};
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
