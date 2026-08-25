import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getShellEnv } from "../src/utils/shell.js";

/**
 * Regression guard for the ELECTRON_RUN_AS_NODE leak (PR #91, finding 3).
 *
 * When the VS Code extension can't find a real Node >=22, it spawns the dreb CLI
 * via the editor's own Electron binary with ELECTRON_RUN_AS_NODE=1. That flag must
 * NOT propagate to shell tool commands: otherwise a command like `code .` would run
 * the Electron binary headless as Node instead of opening an editor window.
 */
describe("getShellEnv — ELECTRON_RUN_AS_NODE isolation", () => {
	const original = process.env.ELECTRON_RUN_AS_NODE;

	beforeEach(() => {
		process.env.ELECTRON_RUN_AS_NODE = "1";
	});

	afterEach(() => {
		if (original === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
		else process.env.ELECTRON_RUN_AS_NODE = original;
	});

	it("strips ELECTRON_RUN_AS_NODE from the shell environment", () => {
		const env = getShellEnv();
		expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
		expect("ELECTRON_RUN_AS_NODE" in env).toBe(false);
	});

	it("does not mutate the parent process.env", () => {
		getShellEnv();
		expect(process.env.ELECTRON_RUN_AS_NODE).toBe("1");
	});

	it("still returns a usable PATH", () => {
		const env = getShellEnv();
		const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path");
		expect(pathKey).toBeDefined();
		expect(env[pathKey as string]).toBeTruthy();
	});
});
