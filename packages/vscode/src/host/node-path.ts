/**
 * Resolve an absolute Node.js executable to spawn the dreb RPC child with.
 *
 * `RpcClient` otherwise runs the bare command `"node"`, relying on `PATH`. A
 * GUI-launched editor (macOS Dock/Finder, Windows Explorer) does NOT inherit the
 * shell `PATH`, so `spawn("node")` fails with `ENOENT` and the child never
 * starts. This resolver finds a real Node >=22 the child can actually run.
 *
 * Precedence:
 *   1. the `dreb.nodePath` setting (explicit override) when the file exists;
 *   2. the first Node >=22 among discovered candidates (PATH entries first, then
 *      common install locations — Homebrew, /usr/local/bin, nvm versions);
 *   3. the editor's own runtime (`process.execPath`) run as Node via
 *      `ELECTRON_RUN_AS_NODE=1` — always available, so resolution never fails.
 *
 * All I/O (existence, version probe, candidate list, editor runtime) is
 * injectable so the precedence logic is unit-testable without a real filesystem
 * or spawning processes.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Minimum Node major version (`engines.node: "22.x"` in coding-agent). */
export const MIN_NODE_MAJOR = 22;

export interface NodePathSources {
	/** The `dreb.nodePath` setting value; empty/whitespace means unset. */
	configuredPath?: string;
	/** Existence probe (defaults to `fs.existsSync`). */
	fileExists?: (path: string) => boolean;
	/** Return the major version of a Node executable, or `undefined` if it cannot
	 * be run / parsed (defaults to executing `<nodePath> --version`). An optional
	 * env is merged for the probe (used to pass `ELECTRON_RUN_AS_NODE=1`). */
	probeVersion?: (nodePath: string, extraEnv?: Record<string, string>) => number | undefined;
	/** Ordered, highest-priority-first list of candidate Node executables
	 * (defaults to PATH entries then common install locations). */
	candidatePaths?: () => string[];
	/** The editor's own runtime, used as the final fallback (defaults to
	 * `process.execPath`). */
	execPath?: string;
	/** Platform, used to pick the executable name (defaults to `process.platform`). */
	platform?: NodeJS.Platform;
}

export type NodePathResult = {
	/** Absolute path (or bare `"node"`) to spawn the CLI child with. */
	nodePath: string;
	/** Extra environment to merge for the child (set only for the Electron
	 * fallback, which needs `ELECTRON_RUN_AS_NODE=1` to behave as plain Node). */
	env?: Record<string, string>;
	/** Which rung of the precedence ladder produced the result. */
	source: "setting" | "discovered" | "electron";
	/** The resolved runtime's major version, when it could be determined. For the
	 * Electron fallback this lets the host warn when the editor runtime is older
	 * than {@link MIN_NODE_MAJOR} (it is not version-gated, since it is the
	 * last-resort rung that must always produce a runnable executable). */
	major?: number;
};

export function resolveNodePath(sources: NodePathSources = {}): NodePathResult {
	const exists = sources.fileExists ?? existsSync;
	const probe = sources.probeVersion ?? defaultProbeVersion;

	// 1. Explicit setting wins when it points at a real file.
	const configured = sources.configuredPath?.trim();
	if (configured && exists(configured)) {
		return { nodePath: configured, source: "setting" };
	}

	// 2. First candidate that both exists and reports Node >=22. Candidates are
	// already in priority order (the user's PATH first), so we honor that order
	// rather than globally preferring the highest version.
	const candidates = (sources.candidatePaths ?? (() => defaultCandidatePaths(sources.platform)))();
	for (const candidate of candidates) {
		if (!exists(candidate)) continue;
		const major = probe(candidate);
		if (major != null && major >= MIN_NODE_MAJOR) {
			return { nodePath: candidate, source: "discovered", major };
		}
	}

	// 3. Editor runtime as plain Node — always present, so resolution never fails.
	// Probe its version (via ELECTRON_RUN_AS_NODE so the Electron binary reports
	// Node's version instead of launching a GUI) so the host can warn if it is
	// older than MIN_NODE_MAJOR. This rung is intentionally NOT version-gated.
	const execPath = sources.execPath ?? process.execPath;
	const electronEnv = { ELECTRON_RUN_AS_NODE: "1" };
	const major = probe(execPath, electronEnv);
	return {
		nodePath: execPath,
		env: electronEnv,
		source: "electron",
		...(major != null ? { major } : {}),
	};
}

/** Run `<nodePath> --version` and parse the major version (e.g. `v22.3.1` -> 22).
 * `extraEnv` is merged into the child (used to pass `ELECTRON_RUN_AS_NODE=1` when
 * probing the editor's own Electron binary). */
export function defaultProbeVersion(nodePath: string, extraEnv?: Record<string, string>): number | undefined {
	try {
		const out = execFileSync(nodePath, ["--version"], {
			encoding: "utf8",
			timeout: 3000,
			...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
		}).trim();
		const match = /^v?(\d+)\./.exec(out);
		return match ? Number(match[1]) : undefined;
	} catch {
		return undefined;
	}
}

/** Injectable dependencies for {@link defaultCandidatePaths} (for testing). */
export interface CandidatePathDeps {
	/** The raw `PATH` string (defaults to `process.env.PATH`). */
	pathEnv?: string;
	/** Home directory used to locate nvm versions (defaults to `os.homedir()`). */
	homeDir?: string;
	/** Directory lister used for nvm expansion (defaults to `fs.readdirSync`). */
	readdir?: (dir: string) => string[];
}

/** Build the ordered candidate list: PATH entries first, then common install
 * locations (Homebrew, /usr/local/bin, nvm versions — newest first). */
export function defaultCandidatePaths(
	platform: NodeJS.Platform = process.platform,
	deps: CandidatePathDeps = {},
): string[] {
	const pathEnv = deps.pathEnv ?? process.env.PATH ?? "";
	const homeDir = deps.homeDir ?? homedir();
	const readdir = deps.readdir ?? readdirSync;
	const exe = platform === "win32" ? "node.exe" : "node";
	const seen = new Set<string>();
	const out: string[] = [];
	const add = (p: string) => {
		if (p && !seen.has(p)) {
			seen.add(p);
			out.push(p);
		}
	};

	// PATH entries (the user's chosen Node, when the process inherited a PATH).
	for (const dir of pathEnv.split(delimiter)) {
		if (dir) add(join(dir, exe));
	}

	// Common install locations for GUI launches that lack a shell PATH.
	if (platform !== "win32") {
		add(join("/opt/homebrew/bin", exe)); // Apple-silicon Homebrew
		add(join("/usr/local/bin", exe)); // Intel Homebrew / manual installs
	}
	for (const p of nvmNodePaths(exe, homeDir, readdir)) add(p);

	return out;
}

/** Expand `~/.nvm/versions/node/<version>/bin/<exe>`, newest version first. */
function nvmNodePaths(exe: string, homeDir: string, readdir: (dir: string) => string[]): string[] {
	const base = join(homeDir, ".nvm", "versions", "node");
	try {
		return readdir(base)
			.sort(compareVersionDesc)
			.map((v) => join(base, v, "bin", exe));
	} catch {
		return [];
	}
}

/** Descending semver-ish compare on directory names like `v22.3.1`. */
export function compareVersionDesc(a: string, b: string): number {
	const parse = (s: string) => s.replace(/^v/, "").split(".").map(Number);
	const [a0 = 0, a1 = 0, a2 = 0] = parse(a);
	const [b0 = 0, b1 = 0, b2 = 0] = parse(b);
	return b0 - a0 || b1 - a1 || b2 - a2;
}
