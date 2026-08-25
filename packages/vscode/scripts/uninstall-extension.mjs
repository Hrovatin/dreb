#!/usr/bin/env node
/**
 * Remove a repo-local install of the dreb VSCode extension.
 *
 * Undoes everything `install-extension.mjs` creates: the symlink, any leftover
 * versioned-copy folders, and the `extensions.json` registration entry — so no
 * dangling reference is left behind for VS Code to trip over.
 *
 * The core logic lives in `install-extension.mjs` (`runUninstall`, unit-tested
 * there); this file is the thin CLI wrapper. Keeping the testable core in the
 * install module also avoids importing this file in-process from tests, which
 * would trip its `isDirectRun` entrypoint guard under some runners.
 *
 * Usage (from the repo root):
 *   npm run uninstall-vscode
 *   node packages/vscode/scripts/uninstall-extension.mjs [--insiders] [--dir <path>]
 */

import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionsDir, isDirectRun, parseArgs, runUninstall } from "./install-extension.mjs";

function main() {
	const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const require = createRequire(import.meta.url);
	const pkg = require(join(pkgRoot, "package.json"));

	const args = parseArgs(process.argv.slice(2));
	const extDir = extensionsDir({ insiders: args.insiders, override: args.dir });
	runUninstall({ extDir, pkg });
}

// Run only when executed directly (see isDirectRun in install-extension.mjs).
if (isDirectRun(import.meta.url)) main();
