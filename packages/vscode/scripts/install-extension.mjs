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

import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
	// Symlink (valid or broken) — unlink it; the real target is untouched.
	if (isSymlink(linkPath)) {
		rmSync(linkPath);
		return;
	}
	// Nothing there.
	if (!existsSync(linkPath)) return;
	// A real directory (e.g. a stale copied .vsix install) — remove with a warning.
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

/**
 * Core install logic, with every side effect injectable so it can be unit-tested
 * without touching the real filesystem or exiting the process. Verifies the build
 * prerequisites, is idempotent (no-op when already linked to the same target), and
 * otherwise (re)creates the symlink.
 */
export function runInstall({
	pkgRoot,
	pkg,
	extDir,
	fileExists = existsSync,
	makeDir = (d) => mkdirSync(d, { recursive: true }),
	isLink = isSymlink,
	readLink = safeReadlink,
	createSymlink = (target, link) => symlinkSync(target, link, "dir"),
	remove = removeExisting,
	log = console.log,
	error = console.error,
	exit = process.exit,
}) {
	// Prerequisites: both the extension host and the sibling CLI must be built.
	const hostEntry = join(pkgRoot, "dist", "host", "extension.js");
	const cliEntry = resolve(pkgRoot, "..", "coding-agent", "dist", "cli.js");
	const missing = [hostEntry, cliEntry].filter((p) => !fileExists(p));
	if (missing.length > 0) {
		error("dreb: build outputs missing — run `npm run build` at the repo root first.");
		for (const m of missing) error(`  missing: ${m}`);
		exit(1);
		return { ok: false, reason: "missing-build", missing };
	}

	makeDir(extDir);
	const { linkPath, targetPath } = installPlan({ extDir, pkg, target: pkgRoot });

	// Idempotent: if already linked to this target, nothing to do.
	if (isLink(linkPath) && readLink(linkPath) === targetPath) {
		log(`Already linked: ${linkPath} -> ${targetPath}`);
		log('Reload the editor ("Developer: Reload Window") to activate the extension.');
		return { ok: true, reason: "already-linked", linkPath, targetPath };
	}

	remove(linkPath);
	createSymlink(targetPath, linkPath);
	log(`Linked ${linkPath} -> ${targetPath}`);
	log('Reload the editor ("Developer: Reload Window") to activate the extension.');
	return { ok: true, reason: "linked", linkPath, targetPath };
}

function main() {
	const pkgRoot = pkgRootDir();
	const require = createRequire(import.meta.url);
	const pkg = require(join(pkgRoot, "package.json"));
	const args = parseArgs(process.argv.slice(2));
	const extDir = extensionsDir({ insiders: args.insiders, override: args.dir });
	runInstall({ pkgRoot, pkg, extDir });
}

/** Read a symlink target, or `undefined` if the path is not a readable symlink. */
export function safeReadlink(p) {
	try {
		return readlinkSync(p);
	} catch {
		return undefined;
	}
}

/**
 * True when this module is the process entry point (run directly, not imported).
 *
 * A naive `import.meta.url === \`file://${process.argv[1]}\`` breaks two ways:
 *   - `import.meta.url` is a percent-encoded file URL while `process.argv[1]` is a
 *     raw path, so any space or special char (e.g. `~/My Projects/dreb`) fails to
 *     match — the script then silently does nothing and exits 0; and
 *   - Node realpath-resolves `import.meta.url` but not `process.argv[1]`, so a
 *     symlinked path component (common: macOS `/tmp` -> `/private/tmp`) also fails.
 * Comparing canonical, realpath-resolved file URLs handles both.
 */
export function isDirectRun(importMetaUrl, argv1 = process.argv[1]) {
	if (!argv1) return false;
	try {
		if (importMetaUrl === pathToFileURL(realpathSync(argv1)).href) return true;
	} catch {
		// realpath can throw (e.g. argv1 no longer exists); fall back to the raw path.
	}
	return importMetaUrl === pathToFileURL(argv1).href;
}

if (isDirectRun(import.meta.url)) main();
