import { execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	compareVersionDesc,
	defaultCandidatePaths,
	defaultProbeVersion,
	MIN_NODE_MAJOR,
	resolveNodePath,
} from "../src/host/node-path.js";

describe("resolveNodePath", () => {
	it("prefers the configured setting when the file exists", () => {
		const result = resolveNodePath({
			configuredPath: "/opt/node22/bin/node",
			fileExists: (p) => p === "/opt/node22/bin/node",
			candidatePaths: () => [],
			execPath: "/electron",
		});
		expect(result).toEqual({ nodePath: "/opt/node22/bin/node", source: "setting" });
	});

	it("ignores a configured setting that does not exist and falls through", () => {
		const result = resolveNodePath({
			configuredPath: "/nope/node",
			fileExists: (p) => p === "/usr/bin/node",
			probeVersion: () => 22,
			candidatePaths: () => ["/usr/bin/node"],
			execPath: "/electron",
		});
		expect(result).toEqual({ nodePath: "/usr/bin/node", source: "discovered", major: 22 });
	});

	it("returns the first candidate that is Node >=22, honoring priority order", () => {
		const versions: Record<string, number> = {
			"/a/node": 20,
			"/b/node": 24,
			"/c/node": 22,
		};
		const result = resolveNodePath({
			configuredPath: "",
			fileExists: () => true,
			probeVersion: (p) => versions[p],
			candidatePaths: () => ["/a/node", "/b/node", "/c/node"],
			execPath: "/electron",
		});
		// /a is too old (20); /b is the first >= 22 and wins even though /c is also valid.
		expect(result).toEqual({ nodePath: "/b/node", source: "discovered", major: 24 });
	});

	it("skips candidates that do not exist", () => {
		const result = resolveNodePath({
			configuredPath: "",
			fileExists: (p) => p === "/real/node",
			probeVersion: () => 22,
			candidatePaths: () => ["/ghost/node", "/real/node"],
			execPath: "/electron",
		});
		expect(result.nodePath).toBe("/real/node");
		expect(result.source).toBe("discovered");
	});

	it("rejects candidates below the minimum major version and reports the fallback's version", () => {
		const result = resolveNodePath({
			configuredPath: "",
			fileExists: () => true,
			// Every candidate (including the electron execPath probe) reports 21.
			probeVersion: () => MIN_NODE_MAJOR - 1,
			candidatePaths: () => ["/old/node"],
			execPath: "/electron",
		});
		expect(result).toEqual({
			nodePath: "/electron",
			env: { ELECTRON_RUN_AS_NODE: "1" },
			source: "electron",
			major: MIN_NODE_MAJOR - 1,
		});
	});

	it("probes the editor runtime with ELECTRON_RUN_AS_NODE so it reports Node's version", () => {
		const probedWith: Array<[string, Record<string, string> | undefined]> = [];
		const result = resolveNodePath({
			configuredPath: "",
			fileExists: () => false,
			candidatePaths: () => [],
			execPath: "/path/to/code",
			probeVersion: (p, env) => {
				probedWith.push([p, env]);
				return 20;
			},
		});
		expect(result).toEqual({
			nodePath: "/path/to/code",
			env: { ELECTRON_RUN_AS_NODE: "1" },
			source: "electron",
			major: 20,
		});
		// The electron runtime is probed with ELECTRON_RUN_AS_NODE=1.
		expect(probedWith).toEqual([["/path/to/code", { ELECTRON_RUN_AS_NODE: "1" }]]);
	});

	it("skips candidates whose version cannot be determined", () => {
		const result = resolveNodePath({
			configuredPath: "",
			fileExists: () => true,
			probeVersion: () => undefined,
			candidatePaths: () => ["/broken/node"],
			execPath: "/electron",
		});
		expect(result.source).toBe("electron");
		// No major when even the fallback runtime's version can't be parsed.
		expect(result.major).toBeUndefined();
	});

	it("falls back to the editor runtime as plain Node when nothing else qualifies", () => {
		const result = resolveNodePath({
			configuredPath: "",
			fileExists: () => false,
			candidatePaths: () => [],
			execPath: "/path/to/code-electron",
			// A bogus execPath cannot be probed → undefined, so no major is attached.
			probeVersion: () => undefined,
		});
		expect(result).toEqual({
			nodePath: "/path/to/code-electron",
			env: { ELECTRON_RUN_AS_NODE: "1" },
			source: "electron",
		});
	});
});

describe("defaultProbeVersion (real child process)", () => {
	it("returns the running Node's major version for the current executable", () => {
		const expectedMajor = Number(process.versions.node.split(".")[0]);
		expect(defaultProbeVersion(process.execPath)).toBe(expectedMajor);
	});

	it("returns undefined for a non-existent executable instead of throwing", () => {
		expect(defaultProbeVersion("/definitely/not/a/real/node/binary")).toBeUndefined();
	});

	it("parses the same version the executable prints", () => {
		const printed = execFileSync(process.execPath, ["--version"], { encoding: "utf8" }).trim();
		const printedMajor = Number(printed.replace(/^v/, "").split(".")[0]);
		expect(defaultProbeVersion(process.execPath)).toBe(printedMajor);
	});
});

describe("compareVersionDesc", () => {
	it("orders versions newest-first, not lexically", () => {
		const sorted = ["v9.0.0", "v22.3.1", "v20.11.0", "v22.10.0", "v18.0.0"].sort(compareVersionDesc);
		expect(sorted).toEqual(["v22.10.0", "v22.3.1", "v20.11.0", "v18.0.0", "v9.0.0"]);
	});

	it("compares minor and patch when majors tie", () => {
		expect(["v22.1.0", "v22.1.5", "v22.0.9"].sort(compareVersionDesc)).toEqual(["v22.1.5", "v22.1.0", "v22.0.9"]);
	});
});

describe("defaultCandidatePaths", () => {
	it("lists PATH entries first, in order, then common install locations", () => {
		const pathEnv = ["/usr/bin", "/home/me/.local/bin"].join(delimiter);
		const out = defaultCandidatePaths("linux", { pathEnv, homeDir: "/home/me", readdir: () => [] });
		expect(out.slice(0, 2)).toEqual([join("/usr/bin", "node"), join("/home/me/.local/bin", "node")]);
		// Homebrew + /usr/local/bin appended after PATH.
		expect(out).toContain(join("/opt/homebrew/bin", "node"));
		expect(out).toContain(join("/usr/local/bin", "node"));
	});

	it("deduplicates repeated PATH/common entries", () => {
		const pathEnv = ["/usr/local/bin", "/usr/local/bin"].join(delimiter);
		const out = defaultCandidatePaths("linux", { pathEnv, homeDir: "/home/me", readdir: () => [] });
		const usrLocal = out.filter((p) => p === join("/usr/local/bin", "node"));
		expect(usrLocal).toHaveLength(1);
	});

	it("expands nvm versions newest-first", () => {
		const out = defaultCandidatePaths("linux", {
			pathEnv: "",
			homeDir: "/home/me",
			readdir: () => ["v18.20.0", "v22.3.1", "v20.11.0"],
		});
		const nvm = out.filter((p) => p.includes(join(".nvm", "versions", "node")));
		expect(nvm).toEqual([
			join("/home/me/.nvm/versions/node", "v22.3.1", "bin", "node"),
			join("/home/me/.nvm/versions/node", "v20.11.0", "bin", "node"),
			join("/home/me/.nvm/versions/node", "v18.20.0", "bin", "node"),
		]);
	});

	it("uses node.exe and skips the POSIX common dirs on Windows", () => {
		// Note: path.delimiter is host-based, so avoid embedding it in pathEnv here;
		// drive the exe-name assertion via the nvm expansion instead.
		const out = defaultCandidatePaths("win32", {
			pathEnv: "",
			homeDir: "C:\\Users\\me",
			readdir: () => ["v22.3.1"],
		});
		expect(out.length).toBeGreaterThan(0);
		expect(out.every((p) => p.endsWith("node.exe"))).toBe(true);
		expect(out.some((p) => p.startsWith("/opt/homebrew"))).toBe(false);
		expect(out.some((p) => p.startsWith("/usr/local/bin"))).toBe(false);
	});

	it("tolerates a missing nvm directory (readdir throws)", () => {
		const out = defaultCandidatePaths("linux", {
			pathEnv: "/usr/bin",
			homeDir: "/home/me",
			readdir: () => {
				throw new Error("ENOENT");
			},
		});
		expect(out).toEqual([
			join("/usr/bin", "node"),
			join("/opt/homebrew/bin", "node"),
			join("/usr/local/bin", "node"),
		]);
	});
});
