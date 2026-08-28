#!/usr/bin/env node
/**
 * Verify that every declared workspace dependency is actually installed in
 * node_modules, and fail fast with an actionable message if not.
 *
 * This guards convenience flows like `install-vscode` (which runs the full
 * `npm run build`): when an update adds a new dependency and the user has not
 * re-run `npm install`, the bundler otherwise dies deep inside vite/rolldown
 * with a cryptic "failed to resolve import" trace. This preflight turns that
 * into a single "run `npm install`" instruction.
 *
 * Scope: the root package plus every workspace package. Only `dependencies` and
 * `devDependencies` are checked — `optionalDependencies` and `peerDependencies`
 * are deliberately skipped, because platform-specific optional packages (e.g.
 * `@rollup/rollup-linux-x64-gnu`, marked optional/peer in the lockfile) are
 * legitimately absent on any given machine and must not trip a false alarm.
 *
 * Exit code 1 if any required dependency is missing.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const rootPkg = JSON.parse(readFileSync("package.json", "utf-8"));
const workspaceEntries = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];

let foundReadOrParseError = false;
const missing = new Map();

function isEnoent(error) {
	return error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

/** All package.json paths to inspect: the root package plus every workspace. */
function packageJsonPaths() {
	const paths = ["package.json"];
	for (const workspaceEntry of workspaceEntries) {
		paths.push(...packageJsonPathsForWorkspace(workspaceEntry));
	}
	return paths;
}

function packageJsonPathsForWorkspace(workspaceEntry) {
	if (workspaceEntry.endsWith("/*")) {
		const workspaceRoot = workspaceEntry.slice(0, -2);
		let packageDirs;
		try {
			packageDirs = readdirSync(workspaceRoot);
		} catch (error) {
			if (isEnoent(error)) {
				return [];
			}

			const message = error instanceof Error ? error.message : String(error);
			console.error(`ERROR: failed to read workspace directory ${workspaceRoot}: ${message}`);
			foundReadOrParseError = true;
			return [];
		}

		return packageDirs.map((pkgDir) => join(workspaceRoot, pkgDir, "package.json"));
	}

	return [join(workspaceEntry, "package.json")];
}

/**
 * True when `name` is installed as seen from `fromDir`. Walks node_modules
 * directories from the package's own directory up to the repo root, mirroring
 * Node's resolution so a hoisted dependency in the root node_modules counts.
 * We probe for the package's package.json (present even for `@types/*` packages
 * that expose no runtime entry point) rather than resolving a main module, so
 * an `exports`-restricted package is never misreported as missing.
 */
function isInstalled(name, fromDir) {
	let dir = fromDir;
	while (true) {
		if (existsSync(join(dir, "node_modules", name, "package.json"))) {
			return true;
		}
		if (dir === "" || dir === ".") {
			break;
		}
		const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : ".";
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	return false;
}

function packageDir(pkgPath) {
	if (pkgPath === "package.json") {
		return ".";
	}
	return pkgPath.slice(0, pkgPath.length - "/package.json".length);
}

function checkPackage(pkgPath) {
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
	} catch (error) {
		if (isEnoent(error)) {
			return;
		}

		const message = error instanceof Error ? error.message : String(error);
		console.error(`ERROR: failed to read or parse ${pkgPath}: ${message}`);
		foundReadOrParseError = true;
		return;
	}

	const fromDir = packageDir(pkgPath);
	const required = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
	for (const name of Object.keys(required)) {
		if (!isInstalled(name, fromDir) && !missing.has(name)) {
			missing.set(name, pkgPath);
		}
	}
}

for (const pkgPath of packageJsonPaths()) {
	checkPackage(pkgPath);
}

if (foundReadOrParseError || missing.size > 0) {
	console.error("");
	if (foundReadOrParseError) {
		console.error("Fix: correct the invalid JSON syntax in the reported file(s).");
	}
	if (missing.size > 0) {
		const names = [...missing.keys()].sort().join(", ");
		console.error(`dreb: dependencies not installed (missing: ${names}).`);
		console.error("      Run `npm install` at the repo root, then retry.");
	}
	process.exit(1);
}

console.log("All workspace dependencies are installed.");
