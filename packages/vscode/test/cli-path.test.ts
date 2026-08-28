import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultExtensionDir, repoRelativeCliPath, resolveCliPath } from "../src/host/cli-path.js";

describe("cli-path resolution", () => {
	it("prefers the configured setting when the file exists", () => {
		const result = resolveCliPath({
			configuredPath: "/opt/dreb/dist/cli.js",
			fileExists: (p) => p === "/opt/dreb/dist/cli.js",
		});
		expect(result).toEqual({ ok: true, path: "/opt/dreb/dist/cli.js", source: "setting" });
	});

	it("errors clearly when the configured setting points nowhere", () => {
		const result = resolveCliPath({
			configuredPath: "/nope/cli.js",
			fileExists: () => false,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("/nope/cli.js");
	});

	it("resolves the sibling CLI relative to the extension dir (repo-local install)", () => {
		const result = resolveCliPath({
			extensionDir: "/repo/packages/vscode",
			fileExists: (p) => p === "/repo/packages/coding-agent/dist/cli.js",
		});
		expect(result).toEqual({ ok: true, path: "/repo/packages/coding-agent/dist/cli.js", source: "repo" });
	});

	it("prefers the repo-relative CLI over dependency resolution", () => {
		const result = resolveCliPath({
			extensionDir: "/repo/packages/vscode",
			resolveCliDir: () => "/pkgs/coding-agent/dist",
			fileExists: () => true, // both candidates would exist
		});
		expect(result).toEqual({ ok: true, path: "/repo/packages/coding-agent/dist/cli.js", source: "repo" });
	});

	it("falls back to dependency resolution when no setting is present", () => {
		const result = resolveCliPath({
			configuredPath: "  ",
			extensionDir: "/repo/packages/vscode",
			resolveCliDir: () => "/pkgs/coding-agent/dist",
			fileExists: (p) => p === "/pkgs/coding-agent/dist/cli.js",
		});
		expect(result).toEqual({ ok: true, path: "/pkgs/coding-agent/dist/cli.js", source: "dependency" });
	});

	it("errors when dependency resolution yields nothing", () => {
		const result = resolveCliPath({
			extensionDir: undefined,
			resolveCliDir: () => undefined,
			fileExists: () => false,
		});
		expect(result.ok).toBe(false);
	});

	it("errors when neither the repo-relative nor the dependency dir has cli.js", () => {
		const result = resolveCliPath({
			extensionDir: "/repo/packages/vscode",
			resolveCliDir: () => "/pkgs/coding-agent/dist",
			fileExists: () => false,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("dreb folder");
	});
});

describe("repo-relative walk (the real un-injected mechanism)", () => {
	it("repoRelativeCliPath points at the sibling coding-agent package", () => {
		expect(repoRelativeCliPath("/repo/packages/vscode")).toBe("/repo/packages/coding-agent/dist/cli.js");
	});

	it("defaultExtensionDir walks up exactly to packages/vscode (load-bearing hop count)", () => {
		// This is the assumption the whole repo-local install rests on: three parent
		// hops from the module (`.../packages/vscode/<dist|src>/host/cli-path.<js|ts>`)
		// must land on `packages/vscode`. If the compiled layout ever changes, this
		// test fails instead of silently resolving the wrong directory.
		const dir = defaultExtensionDir();
		expect(dir).toBeDefined();
		expect(basename(dir as string)).toBe("vscode");
		expect(basename(dirname(dir as string))).toBe("packages");

		// And it matches a direct three-hop computation from this test's own module URL,
		// which lives one level deeper (test/ vs host/) — so hop from its parent.
		const hereDir = dirname(fileURLToPath(import.meta.url)); // .../packages/vscode/test
		expect(dir).toBe(dirname(hereDir)); // .../packages/vscode
	});

	it("the derived dir yields a real sibling cli.js candidate shape", () => {
		const dir = defaultExtensionDir() as string;
		expect(repoRelativeCliPath(dir)).toBe(join(dir, "..", "coding-agent", "dist", "cli.js"));
	});
});
