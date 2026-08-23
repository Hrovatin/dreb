#!/usr/bin/env node
/**
 * Repo-local install for the dreb VSCode extension.
 *
 * Distribution model: the repo itself, not a shipped `.vsix`. This **symlinks**
 * `packages/vscode` into the editor's extensions directory so the extension runs
 * from inside the monorepo — Node then resolves `@dreb/coding-agent` (the CLI +
 * in-process `RpcClient`/`SessionManager`) straight from the workspace, with no
 * copy, no global install, and no network.
 *
 * Usage (from the repo root):
 *   npm run install-vscode            # build the repo, then link into ~/.vscode
 *   node packages/vscode/scripts/install-extension.mjs [--insiders] [--dir <path>]
 *
 * The pure helpers are exported for unit tests; `main()` runs only when the file
 * is executed directly.
 */

import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; no side effects)
// ---------------------------------------------------------------------------

/** The editor's extensions directory. Stable/VS Code Insiders, or an override. */
export function extensionsDir({ home = homedir(), insiders = false, override } = {}) {
	if (override) return override;
	return join(home, insiders ? ".vscode-insiders" : ".vscode", "extensions");
}

/** Stable link folder name derived from the manifest (`<publisher>.<name>`). */
export function linkName(pkg) {
	const publisher = pkg.publisher ?? "unknown";
	return `${publisher}.${pkg.name}`;
}

/** Absolute link path + symlink target for an install. */
export function installPlan({ extDir, pkg, target }) {
	return { linkPath: join(extDir, linkName(pkg)), targetPath: target };
}

/** Parse the supported flags: `--insiders` and `--dir <path>`. */
export function parseArgs(argv) {
	const out = { insiders: false, dir: undefined };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--insiders") out.insiders = true;
		else if (argv[i] === "--dir") out.dir = argv[++i];
	}
	return out;
}

// ---------------------------------------------------------------------------
// Side-effecting install
// ---------------------------------------------------------------------------

/** Remove an existing link/dir at `linkPath`. Symlinks are unlinked; a real
 * directory (e.g. a stale copied `.vsix` install) is removed with a warning. */
export function removeExisting(linkPath, log = console.log) {
	if (!existsSync(linkPath) && !isSymlink(linkPath)) return;
	if (isSymlink(linkPath)) {
		rmSync(linkPath);
		return;
	}
	log(`Replacing existing non-symlink install at ${linkPath}`);
	rmSync(linkPath, { recursive: true, force: true });
}

function isSymlink(p) {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

function pkgRootDir() {
	// scripts/ -> packages/vscode
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function main() {
	const pkgRoot = pkgRootDir();
	const require = createRequire(import.meta.url);
	const pkg = require(join(pkgRoot, "package.json"));

	// Prerequisites: both the extension host and the sibling CLI must be built.
	const hostEntry = join(pkgRoot, "dist", "host", "extension.js");
	const cliEntry = resolve(pkgRoot, "..", "coding-agent", "dist", "cli.js");
	const missing = [hostEntry, cliEntry].filter((p) => !existsSync(p));
	if (missing.length > 0) {
		console.error("dreb: build outputs missing — run `npm run build` at the repo root first.");
		for (const m of missing) console.error(`  missing: ${m}`);
		process.exit(1);
	}

	const args = parseArgs(process.argv.slice(2));
	const extDir = extensionsDir({ insiders: args.insiders, override: args.dir });
	mkdirSync(extDir, { recursive: true });

	const { linkPath, targetPath } = installPlan({ extDir, pkg, target: pkgRoot });

	// Idempotent: if already linked to this target, nothing to do.
	if (isSymlink(linkPath) && safeReadlink(linkPath) === targetPath) {
		console.log(`Already linked: ${linkPath} -> ${targetPath}`);
	} else {
		removeExisting(linkPath);
		symlinkSync(targetPath, linkPath, "dir");
		console.log(`Linked ${linkPath} -> ${targetPath}`);
	}
	console.log('Reload the editor ("Developer: Reload Window") to activate the extension.');
}

function safeReadlink(p) {
	try {
		return readlinkSync(p);
	} catch {
		return undefined;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) main();
