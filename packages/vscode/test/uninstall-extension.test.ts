import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSymlink, linkName } from "../scripts/install-extension.mjs";

/**
 * End-to-end guard for the round-2 dangling-symlink uninstall fix (PR #91,
 * finding 2). The unit tests cover `isSymlink`/`removeExisting` in isolation, but
 * the composed guard in `uninstall-extension.mjs` `main()`
 * (`!isSymlink(linkPath) && !existsSync(linkPath)`) is only decisive at the
 * observable outcome: a dangling link must be REMOVED, not reported as "Nothing
 * to remove." A regression dropping the `isSymlink` term would pass every unit
 * test but silently leave the broken extension entry behind.
 */
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "uninstall-extension.mjs");

// The manifest the script reads to derive the link folder name.
const pkg = { publisher: "hrovatin", name: "dreb-vscode" };

function runUninstall(extDir: string): string {
	return execFileSync(process.execPath, [scriptPath, "--dir", extDir], { encoding: "utf8" });
}

describe("uninstall-extension.mjs main() — end-to-end (finding 2)", () => {
	let dir: string;
	let extDir: string;
	let linkPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "dreb-uninstall-"));
		extDir = join(dir, "extensions");
		mkdirSync(extDir, { recursive: true });
		linkPath = join(extDir, linkName(pkg));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("removes a DANGLING symlink instead of reporting 'Nothing to remove'", () => {
		// Install (symlink) then delete the target so the link dangles — the exact
		// state after a user moves or deletes their dreb repo.
		const target = join(dir, "repo");
		mkdirSync(target);
		symlinkSync(target, linkPath, "dir");
		rmSync(target, { recursive: true, force: true });

		expect(existsSync(linkPath)).toBe(false); // existsSync follows the dead link
		expect(isSymlink(linkPath)).toBe(true); // but the link itself is still there

		const out = runUninstall(extDir);
		expect(out).toContain("Removed");
		expect(out).not.toContain("Nothing to remove");
		expect(isSymlink(linkPath)).toBe(false); // the dangling link is gone
	});

	it("removes a valid (live-target) symlink", () => {
		const target = join(dir, "repo");
		mkdirSync(target);
		symlinkSync(target, linkPath, "dir");

		const out = runUninstall(extDir);
		expect(out).toContain("Removed");
		expect(isSymlink(linkPath)).toBe(false);
		expect(existsSync(target)).toBe(true); // real target untouched
	});

	it("reports 'Nothing to remove' when no link exists (guard's other arm)", () => {
		const out = runUninstall(extDir);
		expect(out).toContain("Nothing to remove");
	});
});

describe("uninstall-extension.mjs main() — end-to-end manifest cleanup (issue 92)", () => {
	let dir: string;
	let extDir: string;
	const pkg = { publisher: "hrovatin", name: "dreb-vscode" };

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "dreb-uninstall-manifest-"));
		extDir = join(dir, "extensions");
		mkdirSync(extDir, { recursive: true });
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("removes the symlink, versioned copy, and manifest entry via the real script", () => {
		const name = linkName(pkg);
		const target = join(dir, "repo");
		mkdirSync(target);
		symlinkSync(target, join(extDir, name), "dir");
		mkdirSync(join(extDir, `${name}-0.1.0`)); // stale versioned copy
		const manifest = join(extDir, "extensions.json");
		writeFileSync(manifest, JSON.stringify([{ identifier: { id: name } }, { identifier: { id: "keep.me" } }]));

		const out = execFileSync(
			process.execPath,
			[join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "uninstall-extension.mjs"), "--dir", extDir],
			{ encoding: "utf8" },
		);

		expect(out).toContain("Removed");
		expect(isSymlink(join(extDir, name))).toBe(false);
		expect(existsSync(join(extDir, `${name}-0.1.0`))).toBe(false);
		const entries = JSON.parse(readFileSync(manifest, "utf8"));
		expect(entries).toEqual([{ identifier: { id: "keep.me" } }]);
	});
});
