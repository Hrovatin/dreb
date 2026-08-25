import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createExtensionRealDirState,
	resolveExtensionRealDir,
	tryResolveRealFsPath,
} from "../src/host/extension-paths.js";

describe("tryResolveRealFsPath", () => {
	it("returns the raw path unchanged for a plain (non-symlinked) real path (no-op)", () => {
		// A .vsix / F5 install is a real directory: realpath returns the same path.
		expect(tryResolveRealFsPath("/real/path", (p) => p)).toEqual({ path: "/real/path", resolved: true });
	});

	it("reports resolved:true with the real target on success (the npm run install-vscode case)", () => {
		const target = "/Users/me/Documents/code/dreb/packages/vscode";
		const fakeRealpath = (p: string) => (p === "/Users/me/.vscode/extensions/pub.name" ? target : p);
		expect(tryResolveRealFsPath("/Users/me/.vscode/extensions/pub.name", fakeRealpath)).toEqual({
			path: target,
			resolved: true,
		});
	});

	it("reports resolved:false with the raw path when realpath throws (dangling link / moved repo)", () => {
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
			expect(tryResolveRealFsPath(link)).toEqual({ path: link, resolved: false });
		});
	});
});

describe("resolveExtensionRealDir", () => {
	const RAW = "/Users/me/.vscode/extensions/pub.name";
	const TARGET = "/Users/me/Documents/code/dreb/packages/vscode";

	it("returns undefined when no raw path is available (pre-activation)", () => {
		const state = createExtensionRealDirState();
		expect(resolveExtensionRealDir(state, { rawFsPath: undefined, realpath: (p) => p })).toBeUndefined();
	});

	it("resolves and caches a successful resolution (does not re-resolve on the next call)", () => {
		const state = createExtensionRealDirState();
		const realpath = vi.fn((p: string) => (p === RAW ? TARGET : p));

		expect(resolveExtensionRealDir(state, { rawFsPath: RAW, realpath })).toBe(TARGET);
		expect(resolveExtensionRealDir(state, { rawFsPath: RAW, realpath })).toBe(TARGET);
		// Cached after the first success: realpath is not called again.
		expect(realpath).toHaveBeenCalledTimes(1);
	});

	it("does NOT cache a failed resolution, so a later call self-heals once realpath recovers", () => {
		const state = createExtensionRealDirState();
		const onError = vi.fn();
		let shouldThrow = true;
		const realpath = vi.fn((p: string) => {
			if (shouldThrow) throw new Error("EMFILE");
			return p === RAW ? TARGET : p;
		});

		// First call: transient failure -> returns raw fallback, NOT cached.
		expect(resolveExtensionRealDir(state, { rawFsPath: RAW, realpath, onError })).toBe(RAW);
		expect(state.cache).toBeUndefined();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith(RAW, expect.any(Error));

		// Filesystem recovers: a later call retries and resolves the real target.
		shouldThrow = false;
		expect(resolveExtensionRealDir(state, { rawFsPath: RAW, realpath, onError })).toBe(TARGET);
		expect(state.cache).toBe(TARGET);
		// The self-heal re-attempted realpath rather than returning the pinned fallback.
		expect(realpath).toHaveBeenCalledTimes(2);
	});
});
