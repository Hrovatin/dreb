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

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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

// ---------------------------------------------------------------------------
// extensions.json manifest helpers (pure; unit-tested)
//
// Modern VS Code (verified on 1.134.0) treats `<extensionsDir>/extensions.json`
// as the authoritative list of user-installed extensions and no longer purely
// directory-scans, so a bare symlink is invisible unless it is also registered
// here. These helpers build/merge that manifest with no side effects.
// ---------------------------------------------------------------------------

/** Path to the editor's user-extensions control file. */
export function manifestPath(extDir) {
	return join(extDir, "extensions.json");
}

/** Parse the manifest's raw JSON into `{ entries, malformed }`.
 *
 * - absent (`undefined`) or empty/whitespace-only → `{ entries: [], malformed: false }`
 *   (nothing to preserve; safe to create fresh);
 * - a valid JSON array → `{ entries, malformed: false }`;
 * - present but non-array or unparseable → `{ entries: [], malformed: true }`.
 *
 * The `malformed` flag lets a caller refuse to overwrite a file it could not
 * understand — the manifest lists *every* installed extension, so blindly
 * rewriting an unreadable one would silently deregister the others. Never throws. */
export function parseManifest(raw) {
	if (raw === undefined || raw.trim() === "") return { entries: [], malformed: false };
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return { entries: parsed, malformed: false };
	} catch {
		// fall through to malformed
	}
	return { entries: [], malformed: true };
}

/** Parse the manifest's raw JSON into an array of entries. Tolerant: a missing
 * (`undefined`), empty, non-array, or malformed file yields `[]` — never throws.
 * Use this where a malformed manifest should be treated as empty (e.g. uninstall,
 * which then simply finds nothing to remove); prefer `parseManifest` when the
 * malformed case must be distinguished before overwriting the file. */
export function readManifest(raw) {
	return parseManifest(raw).entries;
}

/** Build the manifest entry VS Code expects for a symlinked (dev) extension. */
export function buildManifestEntry({ id, version, linkPath, now = Date.now() }) {
	return {
		identifier: { id },
		version: version ?? "0.0.0",
		location: {
			$mid: 1,
			fsPath: linkPath,
			external: pathToFileURL(linkPath).href,
			path: linkPath,
			scheme: "file",
		},
		relativeLocation: id,
		metadata: { installedTimestamp: now, pinned: true, source: "vsix" },
	};
}

/** True when two extension ids match. VS Code compares ids case-insensitively. */
export function sameId(a, b) {
	return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

/** Return a new array with every existing entry for `entry.identifier.id`
 * dropped and `entry` appended — so re-installs never duplicate the extension. */
export function upsertEntry(entries, entry) {
	const id = entry.identifier?.id;
	return [...entries.filter((e) => !sameId(e?.identifier?.id, id)), entry];
}

/** Return a new array with every entry for `id` removed. */
export function removeEntry(entries, id) {
	return entries.filter((e) => !sameId(e?.identifier?.id, id));
}

/** Stale on-disk install folders belonging to this extension: versioned-copy
 * variants like `<id>-0.1.0` (a prior `.vsix`-style install). The canonical
 * `<id>` link itself is excluded — install (re)creates it, uninstall removes it
 * via the normal link path. Only a *version-shaped* suffix (`-` followed by a
 * digit) counts, so a genuinely different sibling extension that merely shares
 * the id prefix (e.g. `<id>-extras`) is never matched and never deleted. */
export function staleInstallNames(names, name) {
	const prefix = `${name}-`;
	return names.filter((n) => n !== name && n.startsWith(prefix) && /^\d/.test(n.slice(prefix.length)));
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

/** True when `p` is a symlink (broken or not). Uses `lstat`, so — unlike
 * `existsSync` — it does not follow the link and correctly detects a dangling
 * symlink whose target no longer exists. */
export function isSymlink(p) {
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

/** Remove every stale versioned-copy folder in `staleNames`, logging each. Shared
 * by install and uninstall so their cleanup wording/semantics can't drift apart. */
function removeStaleInstalls(staleNames, extDir, remove, log) {
	for (const n of staleNames) {
		const stalePath = join(extDir, n);
		remove(stalePath, log);
		log(`Removed stale install: ${stalePath}`);
	}
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
	readDir = safeReaddir,
	readManifestFile = safeReadFile,
	writeManifestFile = (p, data) => writeFileSync(p, data),
	now = Date.now,
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
	const name = linkName(pkg);
	const { linkPath, targetPath } = installPlan({ extDir, pkg, target: pkgRoot });

	// (Re)establish the canonical symlink. Idempotent: leave it in place when it
	// already points at this target, otherwise remove-and-relink.
	let reason;
	if (isLink(linkPath) && readLink(linkPath) === targetPath) {
		reason = "already-linked";
		log(`Already linked: ${linkPath} -> ${targetPath}`);
	} else {
		remove(linkPath);
		createSymlink(targetPath, linkPath);
		reason = "linked";
		log(`Linked ${linkPath} -> ${targetPath}`);
	}

	// Reconcile any prior install state: remove leftover versioned-copy folders
	// (e.g. a stale `.vsix`-style `<id>-0.1.0`) so the editor sees exactly one.
	removeStaleInstalls(staleInstallNames(readDir(extDir), name), extDir, remove, log);

	// Register (or refresh) the extensions.json entry. Runs on both paths so a
	// pre-existing symlink with a missing/stale manifest entry self-heals —
	// without this, modern VS Code silently never loads the extension.
	//
	// The manifest lists *every* installed extension. If the file is present but
	// unparseable (truncated by a concurrent editor write, hand-edited, etc.),
	// refuse to overwrite it — collapsing it to `[]` and rewriting would silently
	// deregister all the user's other extensions. `runUninstall` guards the same
	// way. An absent/empty file is fine to create fresh.
	const manifestFile = manifestPath(extDir);
	const { entries: existing, malformed } = parseManifest(readManifestFile(manifestFile));
	if (malformed) {
		error(`dreb: ${manifestFile} exists but is not a valid JSON array — refusing to overwrite it.`);
		error("  Fix or remove that file, then re-run — otherwise your other extensions would be deregistered.");
		exit(1);
		return { ok: false, reason: "manifest-malformed", linkPath, targetPath };
	}
	const entry = buildManifestEntry({ id: name, version: pkg.version, linkPath, now: now() });
	writeManifestFile(manifestFile, JSON.stringify(upsertEntry(existing, entry), null, 0));
	log(`Registered ${name} in ${manifestFile}`);

	log('Reload the editor ("Developer: Reload Window") to activate the extension.');
	return { ok: true, reason, linkPath, targetPath };
}

/**
 * Core uninstall logic (paired with `runInstall`), with every side effect
 * injectable so it can be unit-tested without touching the real filesystem.
 * Removes the symlink, any stale versioned-copy folders, and this extension's
 * `extensions.json` entry. Safe when nothing is installed and when the manifest
 * is absent/malformed. The `uninstall-extension.mjs` CLI is a thin wrapper.
 */
export function runUninstall({
	extDir,
	pkg,
	isLink = isSymlink,
	fileExists = existsSync,
	remove = removeExisting,
	readDir = safeReaddir,
	readManifestFile = safeReadFile,
	writeManifestFile = (p, data) => writeFileSync(p, data),
	log = console.log,
}) {
	const name = linkName(pkg);
	const linkPath = join(extDir, name);

	// The link itself: check with `isSymlink` (lstat-based), not `existsSync`,
	// which follows the link — after the user moves/deletes their dreb repo the
	// link dangles and `existsSync` would report it gone, silently leaving the
	// broken extension entry behind.
	const linkPresent = isLink(linkPath) || fileExists(linkPath);

	// Leftover versioned-copy folders from a prior `.vsix`-style install.
	const stale = staleInstallNames(readDir(extDir), name);

	// The manifest entry (only rewrite when it actually changes / exists).
	const manifestFile = manifestPath(extDir);
	const raw = readManifestFile(manifestFile);
	const before = readManifest(raw);
	const after = removeEntry(before, name);
	const manifestChanged = raw !== undefined && after.length !== before.length;

	if (!linkPresent && stale.length === 0 && !manifestChanged) {
		log(`Nothing to remove: ${linkPath} does not exist.`);
		return { ok: true, reason: "nothing" };
	}

	if (linkPresent) {
		remove(linkPath);
		log(`Removed ${linkPath}`);
	}
	removeStaleInstalls(stale, extDir, remove, log);
	if (manifestChanged) {
		writeManifestFile(manifestFile, JSON.stringify(after, null, 0));
		log(`Deregistered ${name} from ${manifestFile}`);
	}

	log('Reload the editor ("Developer: Reload Window") to deactivate the extension.');
	return { ok: true, reason: "removed" };
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

/** Read a file as UTF-8, or `undefined` if it does not exist / is unreadable. */
export function safeReadFile(p) {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return undefined;
	}
}

/** List a directory's entries, or `[]` if it does not exist / is unreadable. */
export function safeReaddir(d) {
	try {
		return readdirSync(d);
	} catch {
		return [];
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
