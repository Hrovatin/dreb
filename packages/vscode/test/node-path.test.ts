import { describe, expect, it } from "vitest";
import { MIN_NODE_MAJOR, resolveNodePath } from "../src/host/node-path.js";

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
		expect(result).toEqual({ nodePath: "/usr/bin/node", source: "discovered" });
	});

	it("returns the first candidate that is Node >= 22, honoring priority order", () => {
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
		expect(result).toEqual({ nodePath: "/b/node", source: "discovered" });
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

	it("rejects candidates below the minimum major version", () => {
		const result = resolveNodePath({
			configuredPath: "",
			fileExists: () => true,
			probeVersion: () => MIN_NODE_MAJOR - 1,
			candidatePaths: () => ["/old/node"],
			execPath: "/electron",
		});
		expect(result).toEqual({
			nodePath: "/electron",
			env: { ELECTRON_RUN_AS_NODE: "1" },
			source: "electron",
		});
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
	});

	it("falls back to the editor runtime as plain Node when nothing else qualifies", () => {
		const result = resolveNodePath({
			configuredPath: "",
			fileExists: () => false,
			candidatePaths: () => [],
			execPath: "/path/to/code-electron",
		});
		expect(result).toEqual({
			nodePath: "/path/to/code-electron",
			env: { ELECTRON_RUN_AS_NODE: "1" },
			source: "electron",
		});
	});
});
