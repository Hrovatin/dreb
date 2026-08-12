import { describe, expect, it } from "vitest";
import { resolveCliPath } from "../src/host/cli-path.js";

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

	it("falls back to dependency resolution when no setting is present", () => {
		const result = resolveCliPath({
			configuredPath: "  ",
			resolveCliDir: () => "/pkgs/coding-agent/dist",
			fileExists: (p) => p === "/pkgs/coding-agent/dist/cli.js",
		});
		expect(result).toEqual({ ok: true, path: "/pkgs/coding-agent/dist/cli.js", source: "dependency" });
	});

	it("errors when dependency resolution yields nothing", () => {
		const result = resolveCliPath({
			resolveCliDir: () => undefined,
			fileExists: () => false,
		});
		expect(result.ok).toBe(false);
	});

	it("errors when the resolved dependency dir has no cli.js", () => {
		const result = resolveCliPath({
			resolveCliDir: () => "/pkgs/coding-agent/dist",
			fileExists: () => false,
		});
		expect(result.ok).toBe(false);
	});
});
