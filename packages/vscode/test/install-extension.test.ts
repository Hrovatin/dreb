import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	extensionsDir,
	installPlan,
	isDirectRun,
	linkName,
	parseArgs,
	removeExisting,
	runInstall,
	safeReadlink,
} from "../scripts/install-extension.mjs";

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

describe("runInstall (side-effecting install core)", () => {
	const pkg = { publisher: "hrovatin", name: "dreb-vscode" };

	it("exits(1) and reports missing build outputs without touching the filesystem", () => {
		const codes: number[] = [];
		const errors: string[] = [];
		let made = false;
		let linked = false;
		const result = runInstall({
			pkgRoot: "/repo/packages/vscode",
			pkg,
			extDir: "/ext",
			fileExists: () => false, // nothing is built
			makeDir: () => {
				made = true;
			},
			createSymlink: () => {
				linked = true;
			},
			log: () => {},
			error: (m: string) => errors.push(m),
			exit: (c: number) => codes.push(c),
		});
		expect(codes).toEqual([1]);
		expect(result).toMatchObject({ ok: false, reason: "missing-build" });
		expect(result.ok === false && result.missing).toEqual([
			"/repo/packages/vscode/dist/host/extension.js",
			"/repo/packages/coding-agent/dist/cli.js",
		]);
		expect(errors.join("\n")).toContain("npm run build");
		// No filesystem mutation occurred.
		expect(made).toBe(false);
		expect(linked).toBe(false);
	});

	it("is a no-op when already linked to the same target", () => {
		let symlinkCalls = 0;
		let removeCalls = 0;
		const logs: string[] = [];
		const result = runInstall({
			pkgRoot: "/repo/packages/vscode",
			pkg,
			extDir: "/ext",
			fileExists: () => true, // build present
			makeDir: () => {},
			isLink: () => true,
			readLink: () => "/repo/packages/vscode", // already points at the target
			createSymlink: () => {
				symlinkCalls++;
			},
			remove: () => {
				removeCalls++;
			},
			log: (m: string) => logs.push(m),
			error: () => {},
			exit: () => {},
		});
		expect(result).toMatchObject({ ok: true, reason: "already-linked" });
		expect(symlinkCalls).toBe(0);
		expect(removeCalls).toBe(0);
		expect(logs.join("\n")).toContain("Already linked");
	});

	it("removes any existing entry and creates the symlink when not yet linked", () => {
		const symlinks: Array<[string, string]> = [];
		const removed: string[] = [];
		const result = runInstall({
			pkgRoot: "/repo/packages/vscode",
			pkg,
			extDir: "/ext",
			fileExists: () => true,
			makeDir: () => {},
			isLink: () => false,
			readLink: () => undefined,
			remove: (p: string) => removed.push(p),
			createSymlink: (target: string, link: string) => symlinks.push([target, link]),
			log: () => {},
			error: () => {},
			exit: () => {},
		});
		expect(result).toMatchObject({ ok: true, reason: "linked" });
		expect(removed).toEqual(["/ext/hrovatin.dreb-vscode"]);
		expect(symlinks).toEqual([["/repo/packages/vscode", "/ext/hrovatin.dreb-vscode"]]);
	});

	it("re-links when an existing symlink points at a different target", () => {
		const symlinks: Array<[string, string]> = [];
		const removed: string[] = [];
		const result = runInstall({
			pkgRoot: "/repo/packages/vscode",
			pkg,
			extDir: "/ext",
			fileExists: () => true,
			makeDir: () => {},
			isLink: () => true,
			readLink: () => "/some/OTHER/old/checkout", // stale target
			remove: (p: string) => removed.push(p),
			createSymlink: (target: string, link: string) => symlinks.push([target, link]),
			log: () => {},
			error: () => {},
			exit: () => {},
		});
		expect(result).toMatchObject({ ok: true, reason: "linked" });
		expect(removed).toEqual(["/ext/hrovatin.dreb-vscode"]);
		expect(symlinks).toEqual([["/repo/packages/vscode", "/ext/hrovatin.dreb-vscode"]]);
	});

	describe("against a real temp filesystem", () => {
		let dir: string;
		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "dreb-runinstall-"));
		});
		afterEach(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		it("creates a real symlink and is idempotent on a second run", () => {
			// Fake a built repo layout the prereq check will accept.
			const pkgRoot = join(dir, "packages", "vscode");
			mkdirSync(join(pkgRoot, "dist", "host"), { recursive: true });
			writeFileSync(join(pkgRoot, "dist", "host", "extension.js"), "");
			mkdirSync(join(dir, "packages", "coding-agent", "dist"), { recursive: true });
			writeFileSync(join(dir, "packages", "coding-agent", "dist", "cli.js"), "");
			const extDir = join(dir, "ext");

			const first = runInstall({ pkgRoot, pkg, extDir, log: () => {}, error: () => {}, exit: () => {} });
			expect(first).toMatchObject({ ok: true, reason: "linked" });
			const linkPath = join(extDir, "hrovatin.dreb-vscode");
			expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
			expect(readlinkSync(linkPath)).toBe(pkgRoot);

			const second = runInstall({ pkgRoot, pkg, extDir, log: () => {}, error: () => {}, exit: () => {} });
			expect(second).toMatchObject({ ok: true, reason: "already-linked" });
			expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
		});
	});

	it("safeReadlink returns undefined for a non-symlink path", () => {
		expect(safeReadlink("/definitely/not/a/link")).toBeUndefined();
	});
});

describe("isDirectRun (entrypoint guard — finding 1)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "dreb-directrun-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("is true when argv[1] is the module's own path", () => {
		const file = join(dir, "script.mjs");
		writeFileSync(file, "");
		const url = pathToFileURL(file).href;
		expect(isDirectRun(url, file)).toBe(true);
	});

	it("is true when the path contains spaces (the regressed case)", () => {
		const spaced = join(dir, "My Scripts");
		mkdirSync(spaced);
		const file = join(spaced, "script.mjs");
		writeFileSync(file, "");
		// import.meta.url is percent-encoded; the raw argv path is not.
		const url = pathToFileURL(file).href;
		expect(url).toContain("%20"); // sanity: the space really is encoded
		expect(isDirectRun(url, file)).toBe(true);
	});

	it("is true when argv[1] reaches the module through a symlink", () => {
		const real = join(dir, "real.mjs");
		writeFileSync(real, "");
		const link = join(dir, "link.mjs");
		symlinkSync(real, link);
		// Node realpath-resolves import.meta.url to the real file; argv[1] is the symlink.
		const url = pathToFileURL(realpathSync(real)).href;
		expect(isDirectRun(url, link)).toBe(true);
	});

	it("is false when imported rather than run directly (argv[1] is another file)", () => {
		const module = join(dir, "lib.mjs");
		const entry = join(dir, "main.mjs");
		writeFileSync(module, "");
		writeFileSync(entry, "");
		expect(isDirectRun(pathToFileURL(module).href, entry)).toBe(false);
	});

	it("is false when there is no argv[1]", () => {
		expect(isDirectRun("file:///whatever.mjs", undefined)).toBe(false);
	});
});
