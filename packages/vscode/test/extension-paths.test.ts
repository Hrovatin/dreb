import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRealFsPath, tryResolveRealFsPath } from "../src/host/extension-paths.js";

describe("resolveRealFsPath", () => {
	it("returns the raw path unchanged for a plain (non-symlinked) real path (no-op)", () => {
		// A .vsix / F5 install is a real directory: realpath returns the same path.
		expect(resolveRealFsPath("/real/path", (p) => p)).toBe("/real/path");
	});

	it("resolves a symlink to its real target (the npm run install-vscode case)", () => {
		const target = "/Users/me/Documents/code/dreb/packages/vscode";
		const fakeRealpath = (p: string) => (p === "/Users/me/.vscode/extensions/pub.name" ? target : p);
		expect(resolveRealFsPath("/Users/me/.vscode/extensions/pub.name", fakeRealpath)).toBe(target);
	});

	it("falls back to the raw path when realpath throws (dangling link / moved repo)", () => {
		const raw = "/Users/me/.vscode/extensions/pub.name";
		const throwing = () => {
			throw new Error("ENOENT");
		};
		expect(resolveRealFsPath(raw, throwing)).toBe(raw);
	});

	describe("against the real filesystem", () => {
		let dir: string;
		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "dreb-extpaths-"));
		});
		afterEach(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		it("uses the default realpathSync and falls back when a symlink target is missing", () => {
			const real = join(dir, "real-ext");
			const link = join(dir, "linked-ext");
			// Symlink whose target does not exist -> realpathSync throws -> raw fallback.
			symlinkSync(real, link, "dir");
			expect(resolveRealFsPath(link)).toBe(link);
		});
	});
});

describe("tryResolveRealFsPath", () => {
	it("reports resolved:true with the real target on success", () => {
		const target = "/Users/me/Documents/code/dreb/packages/vscode";
		const result = tryResolveRealFsPath("/Users/me/.vscode/extensions/pub.name", () => target);
		expect(result).toEqual({ path: target, resolved: true });
	});

	it("reports resolved:false with the raw path when realpath throws", () => {
		const raw = "/Users/me/.vscode/extensions/pub.name";
		const result = tryResolveRealFsPath(raw, () => {
			throw new Error("ENOENT");
		});
		// resolved:false is what lets the caller avoid caching the fallback and retry.
		expect(result).toEqual({ path: raw, resolved: false });
	});

	it("invokes onError with the thrown error on fallback, and not on success", () => {
		const onError = vi.fn();
		const err = new Error("EMFILE");

		tryResolveRealFsPath(
			"/raw",
			() => {
				throw err;
			},
			onError,
		);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith(err);

		onError.mockClear();
		tryResolveRealFsPath("/raw", (p) => p, onError);
		expect(onError).not.toHaveBeenCalled();
	});
});
