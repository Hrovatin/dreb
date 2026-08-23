import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extensionsDir, installPlan, linkName, parseArgs, removeExisting } from "../scripts/install-extension.mjs";

describe("install-extension helpers", () => {
	describe("extensionsDir", () => {
		it("defaults to ~/.vscode/extensions", () => {
			expect(extensionsDir({ home: "/home/u" })).toBe("/home/u/.vscode/extensions");
		});

		it("uses the Insiders dir when requested", () => {
			expect(extensionsDir({ home: "/home/u", insiders: true })).toBe("/home/u/.vscode-insiders/extensions");
		});

		it("honors an explicit override", () => {
			expect(extensionsDir({ home: "/home/u", override: "/custom/ext" })).toBe("/custom/ext");
		});
	});

	describe("linkName", () => {
		it("combines publisher and name", () => {
			expect(linkName({ publisher: "hrovatin", name: "dreb-vscode" })).toBe("hrovatin.dreb-vscode");
		});

		it("falls back to 'unknown' when publisher is missing", () => {
			expect(linkName({ name: "dreb-vscode" })).toBe("unknown.dreb-vscode");
		});
	});

	describe("installPlan", () => {
		it("computes the link path and target", () => {
			const plan = installPlan({
				extDir: "/home/u/.vscode/extensions",
				pkg: { publisher: "hrovatin", name: "dreb-vscode" },
				target: "/repo/packages/vscode",
			});
			expect(plan).toEqual({
				linkPath: "/home/u/.vscode/extensions/hrovatin.dreb-vscode",
				targetPath: "/repo/packages/vscode",
			});
		});
	});

	describe("parseArgs", () => {
		it("parses --insiders and --dir", () => {
			expect(parseArgs(["--insiders", "--dir", "/x"])).toEqual({ insiders: true, dir: "/x" });
		});

		it("defaults to stable dir and no override", () => {
			expect(parseArgs([])).toEqual({ insiders: false, dir: undefined });
		});
	});

	describe("removeExisting", () => {
		let dir: string;
		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "dreb-install-"));
		});
		afterEach(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		it("no-ops when nothing exists", () => {
			const link = join(dir, "link");
			expect(() => removeExisting(link, () => {})).not.toThrow();
			expect(existsSync(link)).toBe(false);
		});

		it("unlinks an existing symlink", () => {
			const target = join(dir, "target");
			mkdirSync(target);
			const link = join(dir, "link");
			symlinkSync(target, link, "dir");
			expect(lstatSync(link).isSymbolicLink()).toBe(true);

			removeExisting(link, () => {});

			expect(existsSync(link)).toBe(false);
			// The real target is untouched.
			expect(existsSync(target)).toBe(true);
		});

		it("removes a stale non-symlink directory (with a warning)", () => {
			const link = join(dir, "copied-install");
			mkdirSync(link);
			writeFileSync(join(link, "package.json"), "{}");
			const warnings: string[] = [];

			removeExisting(link, (m: string) => warnings.push(m));

			expect(existsSync(link)).toBe(false);
			expect(warnings.join("\n")).toContain("non-symlink");
		});
	});
});
