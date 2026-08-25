import { describe, expect, it, vi } from "vitest";
import type { NodePathResult } from "../src/host/node-path.js";
import {
	createNodeRuntimeCacheState,
	electronVersionWarning,
	resolveNodeRuntimeCached,
} from "../src/host/node-runtime-cache.js";

const discovered: NodePathResult = { nodePath: "/usr/bin/node", source: "discovered", major: 22 };
const electronOld: NodePathResult = {
	nodePath: "/electron",
	env: { ELECTRON_RUN_AS_NODE: "1" },
	source: "electron",
	major: 20,
};

describe("resolveNodeRuntimeCached — caching (finding 2)", () => {
	it("resolves once and reuses the cache while the setting is unchanged", () => {
		const state = createNodeRuntimeCacheState();
		const resolve = vi.fn(() => discovered);

		const a = resolveNodeRuntimeCached(state, { configuredNodePath: "", resolve });
		const b = resolveNodeRuntimeCached(state, { configuredNodePath: "", resolve });

		expect(a).toBe(discovered);
		expect(b).toBe(discovered);
		// Only one probe — the second call is served from cache.
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it("re-resolves when the dreb.nodePath setting changes", () => {
		const state = createNodeRuntimeCacheState();
		const custom: NodePathResult = { nodePath: "/opt/node22/bin/node", source: "setting" };
		const resolve = vi.fn((opts: { configuredPath: string }) => (opts.configuredPath ? custom : discovered));

		expect(resolveNodeRuntimeCached(state, { configuredNodePath: "", resolve })).toBe(discovered);
		expect(resolveNodeRuntimeCached(state, { configuredNodePath: "/opt/node22/bin/node", resolve })).toBe(custom);
		expect(resolve).toHaveBeenCalledTimes(2);
		expect(resolve).toHaveBeenLastCalledWith({ configuredPath: "/opt/node22/bin/node" });

		// Reverting to the previous key re-resolves again (cache holds only the last).
		expect(resolveNodeRuntimeCached(state, { configuredNodePath: "", resolve })).toBe(discovered);
		expect(resolve).toHaveBeenCalledTimes(3);
	});
});

describe("resolveNodeRuntimeCached — one-time old-runtime warning (finding 3)", () => {
	it("warns exactly once when the editor runtime is older than the minimum", () => {
		const state = createNodeRuntimeCacheState();
		const warn = vi.fn();
		const resolve = () => electronOld;

		resolveNodeRuntimeCached(state, { configuredNodePath: "", resolve, warn });
		resolveNodeRuntimeCached(state, { configuredNodePath: "", resolve, warn });

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(electronVersionWarning(20));
	});

	it("does not warn when the editor runtime meets the minimum", () => {
		const state = createNodeRuntimeCacheState();
		const warn = vi.fn();
		resolveNodeRuntimeCached(state, {
			configuredNodePath: "",
			resolve: () => ({ nodePath: "/electron", source: "electron", major: 22 }),
			warn,
		});
		expect(warn).not.toHaveBeenCalled();
	});

	it("does not warn when the runtime version is unknown", () => {
		const state = createNodeRuntimeCacheState();
		const warn = vi.fn();
		resolveNodeRuntimeCached(state, {
			configuredNodePath: "",
			resolve: () => ({ nodePath: "/electron", source: "electron" }),
			warn,
		});
		expect(warn).not.toHaveBeenCalled();
	});

	it("does not warn for a discovered (non-electron) runtime", () => {
		const state = createNodeRuntimeCacheState();
		const warn = vi.fn();
		resolveNodeRuntimeCached(state, { configuredNodePath: "", resolve: () => discovered, warn });
		expect(warn).not.toHaveBeenCalled();
	});

	it("tolerates no warn callback", () => {
		const state = createNodeRuntimeCacheState();
		expect(() =>
			resolveNodeRuntimeCached(state, { configuredNodePath: "", resolve: () => electronOld }),
		).not.toThrow();
	});
});
