#!/usr/bin/env node
/**
 * Remove a repo-local install of the dreb VSCode extension (the symlink created
 * by `install-extension.mjs`).
 *
 * Usage (from the repo root):
 *   npm run uninstall-vscode
 *   node packages/vscode/scripts/uninstall-extension.mjs [--insiders] [--dir <path>]
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionsDir, installPlan, isDirectRun, isSymlink, parseArgs, removeExisting } from "./install-extension.mjs";

function main() {
	const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const require = createRequire(import.meta.url);
	const pkg = require(join(pkgRoot, "package.json"));

	const args = parseArgs(process.argv.slice(2));
	const extDir = extensionsDir({ insiders: args.insiders, override: args.dir });
	const { linkPath } = installPlan({ extDir, pkg, target: pkgRoot });

	// Check the link's own existence with `isSymlink` (lstat-based), not
	// `existsSync`, which follows the symlink: after the user moves or deletes
	// their dreb repo the link is dangling, and `existsSync` would report it as
	// gone — silently leaving the broken extension entry behind.
	if (!isSymlink(linkPath) && !existsSync(linkPath)) {
		console.log(`Nothing to remove: ${linkPath} does not exist.`);
		return;
	}
	removeExisting(linkPath);
	console.log(`Removed ${linkPath}`);
	console.log('Reload the editor ("Developer: Reload Window") to deactivate the extension.');
}

// Run only when executed directly (see isDirectRun in install-extension.mjs).
if (isDirectRun(import.meta.url)) main();
