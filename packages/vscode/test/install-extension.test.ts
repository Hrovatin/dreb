import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
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
	buildManifestEntry,
	extensionsDir,
	installPlan,
	isDirectRun,
	isSymlink,
	linkName,
	manifestPath,
	parseArgs,
	parseManifest,
	readManifest,
	removeEntry,
	removeExisting,
	runInstall,
	runUninstall,
	safeReadlink,
	sameId,
	staleInstallNames,
	upsertEntry,
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
	const pkg = { publisher: "hrovatin", name: "dreb-vscode", version: "0.1.0" };
	// Manifest deps that keep the abstract tests off the real filesystem.
	const noFs = () => ({
		readDir: () => [] as string[],
		readManifestFile: () => undefined as string | undefined,
		writeManifestFile: () => {},
		now: () => 12345,
	});

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
		expect(result.ok === false && result.reason === "missing-build" && result.missing).toEqual([
			"/repo/packages/vscode/dist/host/extension.js",
			"/repo/packages/coding-agent/dist/cli.js",
		]);
		expect(errors.join("\n")).toContain("npm run build");
		// No filesystem mutation occurred.
		expect(made).toBe(false);
		expect(linked).toBe(false);
	});

	it("is a no-op (symlink) but still registers the manifest when already linked", () => {
		let symlinkCalls = 0;
		let removeCalls = 0;
		const logs: string[] = [];
		const writes: Array<[string, string]> = [];
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
			...noFs(),
			writeManifestFile: (p: string, d: string) => writes.push([p, d]),
			log: (m: string) => logs.push(m),
			error: () => {},
			exit: () => {},
		});
		expect(result).toMatchObject({ ok: true, reason: "already-linked" });
		expect(symlinkCalls).toBe(0);
		expect(removeCalls).toBe(0);
		expect(logs.join("\n")).toContain("Already linked");
		// Self-heals a missing manifest entry even when the symlink already exists.
		expect(writes).toHaveLength(1);
		expect(writes[0][0]).toBe("/ext/extensions.json");
		expect(JSON.parse(writes[0][1])[0].identifier.id).toBe("hrovatin.dreb-vscode");
	});

	it("removes any existing entry and creates the symlink when not yet linked", () => {
		const symlinks: Array<[string, string]> = [];
		const removed: string[] = [];
		const writes: Array<[string, string]> = [];
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
			...noFs(),
			writeManifestFile: (p: string, d: string) => writes.push([p, d]),
			log: () => {},
			error: () => {},
			exit: () => {},
		});
		expect(result).toMatchObject({ ok: true, reason: "linked" });
		expect(removed).toEqual(["/ext/hrovatin.dreb-vscode"]);
		expect(symlinks).toEqual([["/repo/packages/vscode", "/ext/hrovatin.dreb-vscode"]]);
		// A well-formed manifest entry pointing at the symlink is written.
		const entry = JSON.parse(writes[0][1])[0];
		expect(entry).toMatchObject({
			identifier: { id: "hrovatin.dreb-vscode" },
			version: "0.1.0",
			relativeLocation: "hrovatin.dreb-vscode",
		});
		expect(entry.location.path).toBe("/ext/hrovatin.dreb-vscode");
	});

	it("reconciles a stale versioned-copy folder and dedupes an existing manifest entry", () => {
		const removed: string[] = [];
		const writes: Array<[string, string]> = [];
		// Prior state: a copied `.vsix`-style folder and a stale manifest entry.
		const prior = JSON.stringify([
			{ identifier: { id: "hrovatin.dreb-vscode" }, version: "0.0.9" },
			{ identifier: { id: "other.ext" }, version: "1.0.0" },
		]);
		runInstall({
			pkgRoot: "/repo/packages/vscode",
			pkg,
			extDir: "/ext",
			fileExists: () => true,
			makeDir: () => {},
			isLink: () => false,
			readLink: () => undefined,
			remove: (p: string) => removed.push(p),
			createSymlink: () => {},
			readDir: () => ["hrovatin.dreb-vscode", "hrovatin.dreb-vscode-0.1.0", "unrelated.ext"],
			readManifestFile: () => prior,
			writeManifestFile: (p: string, d: string) => writes.push([p, d]),
			now: () => 12345,
			log: () => {},
			error: () => {},
			exit: () => {},
		});
		// The canonical link is (re)removed; the versioned copy is cleaned; the
		// unrelated extension is left alone.
		expect(removed).toContain("/ext/hrovatin.dreb-vscode-0.1.0");
		expect(removed).not.toContain("/ext/unrelated.ext");
		const entries = JSON.parse(writes[0][1]);
		// Exactly one dreb entry (deduped), and it is the freshly-built entry —
		// the stale `version: "0.0.9"` is replaced, not merely kept alongside.
		const drebEntries = entries.filter(
			(e: { identifier: { id: string } }) => e.identifier.id === "hrovatin.dreb-vscode",
		);
		expect(drebEntries).toHaveLength(1);
		expect(drebEntries[0].version).toBe(pkg.version);
		expect(drebEntries[0].location.path).toBe("/ext/hrovatin.dreb-vscode");
		expect(drebEntries[0].metadata.installedTimestamp).toBe(12345);
		expect(entries.some((e: { identifier: { id: string } }) => e.identifier.id === "other.ext")).toBe(true);
	});

	it("aborts without overwriting when extensions.json is present but malformed (finding 1)", () => {
		const writes: Array<[string, string]> = [];
		const errors: string[] = [];
		let exitCode: number | undefined;
		const result = runInstall({
			pkgRoot: "/repo/packages/vscode",
			pkg,
			extDir: "/ext",
			fileExists: () => true,
			makeDir: () => {},
			isLink: () => false,
			readLink: () => undefined,
			remove: () => {},
			createSymlink: () => {},
			readDir: () => [],
			// A truncated/hand-broken manifest that still lists the user's other extensions.
			readManifestFile: () => '[{"identifier":{"id":"other.ext"}',
			writeManifestFile: (p: string, d: string) => writes.push([p, d]),
			now: () => 12345,
			log: () => {},
			error: (m: string) => errors.push(m),
			exit: (c: number) => {
				exitCode = c;
			},
		});
		expect(result).toMatchObject({ ok: false, reason: "manifest-malformed" });
		expect(exitCode).toBe(1);
		// Crucially: the manifest is NOT rewritten, so other extensions survive.
		expect(writes).toEqual([]);
		expect(errors.join("\n")).toContain("not a valid JSON array");
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
			...noFs(),
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

			// Idempotent against the manifest too: the second (already-linked) run
			// re-registers via upsert, so the entry is refreshed but never duplicated.
			const manifest = JSON.parse(readFileSync(join(extDir, "extensions.json"), "utf8"));
			expect(
				manifest.filter((e: { identifier: { id: string } }) => e.identifier.id === "hrovatin.dreb-vscode"),
			).toHaveLength(1);
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

describe("isSymlink (uninstall guard for dangling links — finding 1)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "dreb-symlink-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("detects a symlink whose target still exists", () => {
		const target = join(dir, "target");
		const link = join(dir, "link");
		writeFileSync(target, "");
		symlinkSync(target, link);
		expect(isSymlink(link)).toBe(true);
	});

	it("detects a DANGLING symlink where existsSync would report false", () => {
		// Reproduces the uninstall scenario: the dreb repo (the link target) is
		// moved/deleted, so the extension link dangles. existsSync follows the
		// link and returns false; isSymlink (lstat-based) still returns true, so
		// uninstall proceeds to remove it instead of silently no-op'ing.
		const target = join(dir, "gone");
		const link = join(dir, "link");
		writeFileSync(target, "");
		symlinkSync(target, link);
		rmSync(target); // target now gone → link dangles
		expect(existsSync(link)).toBe(false);
		expect(isSymlink(link)).toBe(true);
		// removeExisting cleans a dangling link (this is what the guard now reaches).
		removeExisting(link, () => {});
		expect(isSymlink(link)).toBe(false);
	});

	it("returns false for a non-existent path", () => {
		expect(isSymlink(join(dir, "nope"))).toBe(false);
	});
});

describe("extensions.json manifest helpers (issue 92)", () => {
	describe("manifestPath", () => {
		it("resolves to <extDir>/extensions.json", () => {
			expect(manifestPath("/home/u/.vscode/extensions")).toBe("/home/u/.vscode/extensions/extensions.json");
		});
	});

	describe("readManifest", () => {
		it("parses a JSON array of entries", () => {
			expect(readManifest('[{"identifier":{"id":"a.b"}}]')).toEqual([{ identifier: { id: "a.b" } }]);
		});
		it("returns [] for undefined (missing file)", () => {
			expect(readManifest(undefined)).toEqual([]);
		});
		it("returns [] for an empty string", () => {
			expect(readManifest("")).toEqual([]);
		});
		it("returns [] for malformed JSON", () => {
			expect(readManifest("{not json")).toEqual([]);
		});
		it("returns [] when the JSON is not an array", () => {
			expect(readManifest('{"identifier":{"id":"a.b"}}')).toEqual([]);
		});
	});

	describe("parseManifest (distinguishes absent from malformed — finding 1)", () => {
		it("treats a missing file as empty, not malformed", () => {
			expect(parseManifest(undefined)).toEqual({ entries: [], malformed: false });
		});
		it("treats an empty / whitespace-only file as empty, not malformed", () => {
			expect(parseManifest("")).toEqual({ entries: [], malformed: false });
			expect(parseManifest("  \n")).toEqual({ entries: [], malformed: false });
		});
		it("returns the entries for a valid JSON array", () => {
			expect(parseManifest('[{"identifier":{"id":"a.b"}}]')).toEqual({
				entries: [{ identifier: { id: "a.b" } }],
				malformed: false,
			});
		});
		it("flags a present-but-unparseable file as malformed", () => {
			expect(parseManifest("{not json")).toEqual({ entries: [], malformed: true });
		});
		it("flags a present non-array file as malformed", () => {
			expect(parseManifest('{"identifier":{"id":"a.b"}}')).toEqual({ entries: [], malformed: true });
		});
	});

	describe("buildManifestEntry", () => {
		it("builds the VS Code entry shape with a file:// location and metadata", () => {
			const entry = buildManifestEntry({
				id: "hrovatin.dreb-vscode",
				version: "0.1.0",
				linkPath: "/ext/hrovatin.dreb-vscode",
				now: 999,
			});
			expect(entry).toEqual({
				identifier: { id: "hrovatin.dreb-vscode" },
				version: "0.1.0",
				location: {
					$mid: 1,
					fsPath: "/ext/hrovatin.dreb-vscode",
					external: "file:///ext/hrovatin.dreb-vscode",
					path: "/ext/hrovatin.dreb-vscode",
					scheme: "file",
				},
				relativeLocation: "hrovatin.dreb-vscode",
				metadata: { installedTimestamp: 999, pinned: true, source: "vsix" },
			});
		});
		it("percent-encodes spaces in the external file URL", () => {
			const entry = buildManifestEntry({ id: "x.y", version: "1.0.0", linkPath: "/My Ext/x.y", now: 1 });
			expect(entry.location.external).toContain("%20");
		});
		it("falls back to 0.0.0 when version is missing", () => {
			expect(buildManifestEntry({ id: "x.y", linkPath: "/e/x.y", now: 1 }).version).toBe("0.0.0");
		});
	});

	describe("sameId", () => {
		it("matches case-insensitively", () => {
			expect(sameId("Hrovatin.Dreb-VSCode", "hrovatin.dreb-vscode")).toBe(true);
			expect(sameId("a.b", "a.c")).toBe(false);
		});
	});

	describe("upsertEntry", () => {
		it("adds to an empty manifest", () => {
			const e = buildManifestEntry({ id: "a.b", version: "1.0.0", linkPath: "/e/a.b", now: 1 });
			expect(upsertEntry([], e)).toEqual([e]);
		});
		it("replaces an existing entry with the same id (no duplicate)", () => {
			const old = { identifier: { id: "a.b" }, version: "0.0.9" };
			const e = buildManifestEntry({ id: "a.b", version: "1.0.0", linkPath: "/e/a.b", now: 1 });
			const out = upsertEntry([old, { identifier: { id: "c.d" } }], e);
			expect(out).toHaveLength(2);
			expect(out.filter((x) => x.identifier.id === "a.b")).toEqual([e]);
			expect(out.some((x) => x.identifier.id === "c.d")).toBe(true);
		});
		it("treats ids case-insensitively when replacing", () => {
			const old = { identifier: { id: "A.B" }, version: "0.0.9" };
			const e = buildManifestEntry({ id: "a.b", version: "1.0.0", linkPath: "/e/a.b", now: 1 });
			expect(upsertEntry([old], e)).toEqual([e]);
		});
	});

	describe("removeEntry", () => {
		it("removes the matching id and preserves others", () => {
			const entries = [{ identifier: { id: "a.b" } }, { identifier: { id: "c.d" } }];
			expect(removeEntry(entries, "a.b")).toEqual([{ identifier: { id: "c.d" } }]);
		});
		it("is case-insensitive and a no-op when absent", () => {
			const entries = [{ identifier: { id: "A.B" } }];
			expect(removeEntry(entries, "a.b")).toEqual([]);
			expect(removeEntry(entries, "z.z")).toEqual(entries);
		});
	});

	describe("staleInstallNames", () => {
		it("matches versioned-copy variants but not the canonical link or others", () => {
			const names = [
				"hrovatin.dreb-vscode",
				"hrovatin.dreb-vscode-0.1.0",
				"hrovatin.dreb-vscode-0.2.0",
				"other.ext",
			];
			expect(staleInstallNames(names, "hrovatin.dreb-vscode")).toEqual([
				"hrovatin.dreb-vscode-0.1.0",
				"hrovatin.dreb-vscode-0.2.0",
			]);
		});
		it("returns [] when only the canonical link is present", () => {
			expect(staleInstallNames(["hrovatin.dreb-vscode"], "hrovatin.dreb-vscode")).toEqual([]);
		});
		it("ignores a sibling extension that only shares the id prefix (finding 3)", () => {
			// `<id>-extras` is a different extension, not a versioned copy of `<id>` —
			// only a version-shaped suffix (`-` + digit) counts, so it is never deleted.
			const names = ["hrovatin.dreb-vscode-0.1.0", "hrovatin.dreb-vscode-extras", "hrovatin.dreb-vscode-beta"];
			expect(staleInstallNames(names, "hrovatin.dreb-vscode")).toEqual(["hrovatin.dreb-vscode-0.1.0"]);
		});
	});
});

describe("runUninstall (side-effecting uninstall core — issue 92)", () => {
	const pkg = { publisher: "hrovatin", name: "dreb-vscode" };

	it("removes the symlink and deregisters the manifest entry (keeps unrelated)", () => {
		const removed: string[] = [];
		const writes: Array<[string, string]> = [];
		const result = runUninstall({
			extDir: "/ext",
			pkg,
			isLink: () => true,
			fileExists: () => true,
			readDir: () => ["hrovatin.dreb-vscode"],
			readManifestFile: () =>
				JSON.stringify([{ identifier: { id: "hrovatin.dreb-vscode" } }, { identifier: { id: "other.ext" } }]),
			remove: (p: string) => removed.push(p),
			writeManifestFile: (p: string, d: string) => writes.push([p, d]),
			log: () => {},
		});
		expect(result).toMatchObject({ reason: "removed" });
		expect(removed).toEqual(["/ext/hrovatin.dreb-vscode"]);
		expect(JSON.parse(writes[0][1])).toEqual([{ identifier: { id: "other.ext" } }]);
	});

	it("removes leftover versioned-copy folders alongside the symlink", () => {
		const removed: string[] = [];
		runUninstall({
			extDir: "/ext",
			pkg,
			isLink: () => true,
			fileExists: () => true,
			readDir: () => ["hrovatin.dreb-vscode", "hrovatin.dreb-vscode-0.1.0", "unrelated.ext"],
			readManifestFile: () => undefined,
			remove: (p: string) => removed.push(p),
			writeManifestFile: () => {},
			log: () => {},
		});
		expect(removed).toContain("/ext/hrovatin.dreb-vscode");
		expect(removed).toContain("/ext/hrovatin.dreb-vscode-0.1.0");
		expect(removed).not.toContain("/ext/unrelated.ext");
	});

	it("clears a stale manifest entry even when no symlink is present", () => {
		const removed: string[] = [];
		const writes: Array<[string, string]> = [];
		const result = runUninstall({
			extDir: "/ext",
			pkg,
			isLink: () => false,
			fileExists: () => false,
			readDir: () => [],
			readManifestFile: () => JSON.stringify([{ identifier: { id: "hrovatin.dreb-vscode" } }]),
			remove: (p: string) => removed.push(p),
			writeManifestFile: (p: string, d: string) => writes.push([p, d]),
			log: () => {},
		});
		expect(result).toMatchObject({ reason: "removed" });
		expect(removed).toEqual([]); // nothing on disk to unlink
		expect(JSON.parse(writes[0][1])).toEqual([]);
	});

	it("reports 'nothing' and writes nothing when clean", () => {
		const removed: string[] = [];
		const writes: Array<[string, string]> = [];
		const logs: string[] = [];
		const result = runUninstall({
			extDir: "/ext",
			pkg,
			isLink: () => false,
			fileExists: () => false,
			readDir: () => [],
			readManifestFile: () => undefined,
			remove: (p: string) => removed.push(p),
			writeManifestFile: (p: string, d: string) => writes.push([p, d]),
			log: (m: string) => logs.push(m),
		});
		expect(result).toMatchObject({ reason: "nothing" });
		expect(removed).toEqual([]);
		expect(writes).toEqual([]);
		expect(logs.join("\n")).toContain("Nothing to remove");
	});

	it("tolerates a malformed manifest (treats as empty, no rewrite)", () => {
		const writes: Array<[string, string]> = [];
		const result = runUninstall({
			extDir: "/ext",
			pkg,
			isLink: () => false,
			fileExists: () => false,
			readDir: () => [],
			readManifestFile: () => "{not json",
			remove: () => {},
			writeManifestFile: (p: string, d: string) => writes.push([p, d]),
			log: () => {},
		});
		// Malformed => parsed as [], removal is a no-op, so nothing is rewritten.
		expect(result).toMatchObject({ reason: "nothing" });
		expect(writes).toEqual([]);
	});
});
