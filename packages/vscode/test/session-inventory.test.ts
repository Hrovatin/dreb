import { describe, expect, it } from "vitest";
import {
	inventoryFrom,
	type RawSessionInfo,
	type SessionManagerLike,
	toDiskSession,
} from "../src/host/session-inventory.js";

const dateRaw: RawSessionInfo = {
	path: "/proj/.dreb/sessions/a.jsonl",
	id: "a",
	cwd: "/proj",
	name: "Alpha",
	created: new Date("2026-01-01T00:00:00.000Z"),
	modified: new Date("2026-01-02T12:30:00.000Z"),
	messageCount: 3,
	firstMessage: "hello",
};

const stringRaw: RawSessionInfo = {
	path: "/proj/.dreb/sessions/b.jsonl",
	id: "b",
	cwd: "/proj",
	// name intentionally undefined
	created: "2026-02-01T00:00:00.000Z",
	modified: "2026-02-03T08:00:00.000Z",
	messageCount: 7,
	firstMessage: "second",
};

function fakeManager(): SessionManagerLike {
	return {
		list: async (cwd: string) => (cwd === "/proj" ? [dateRaw, stringRaw] : []),
		listAll: async () => [dateRaw, stringRaw],
		deleteSession: async () => ({ ok: true, method: "trash" }),
	};
}

describe("toDiskSession", () => {
	it("maps Date timestamps to ISO strings and preserves scalar fields", () => {
		const disk = toDiskSession(dateRaw);
		expect(disk).toEqual({
			path: "/proj/.dreb/sessions/a.jsonl",
			id: "a",
			cwd: "/proj",
			name: "Alpha",
			created: "2026-01-01T00:00:00.000Z",
			modified: "2026-01-02T12:30:00.000Z",
			messageCount: 3,
			firstMessage: "hello",
		});
	});

	it("maps string timestamps to ISO strings and omits an undefined name", () => {
		const disk = toDiskSession(stringRaw);
		expect(disk.created).toBe("2026-02-01T00:00:00.000Z");
		expect(disk.modified).toBe("2026-02-03T08:00:00.000Z");
		expect("name" in disk).toBe(false);
		expect(disk).toMatchObject({
			path: "/proj/.dreb/sessions/b.jsonl",
			id: "b",
			cwd: "/proj",
			messageCount: 7,
			firstMessage: "second",
		});
	});
});

describe("inventoryFrom", () => {
	it("listForCwd delegates to manager.list(cwd) and maps to DiskSession", async () => {
		let seenCwd: string | undefined;
		const manager: SessionManagerLike = {
			list: async (cwd: string) => {
				seenCwd = cwd;
				return [dateRaw, stringRaw];
			},
			listAll: async () => [],
			deleteSession: async () => ({ ok: true, method: "trash" }),
		};
		const inventory = inventoryFrom(manager);
		const result = await inventory.listForCwd("/proj");

		expect(seenCwd).toBe("/proj");
		expect(result).toEqual([toDiskSession(dateRaw), toDiskSession(stringRaw)]);
	});

	it("listAll delegates to manager.listAll() and maps to DiskSession", async () => {
		let called = false;
		const manager: SessionManagerLike = {
			list: async () => [],
			listAll: async () => {
				called = true;
				return [dateRaw, stringRaw];
			},
			deleteSession: async () => ({ ok: true, method: "trash" }),
		};
		const inventory = inventoryFrom(manager);
		const result = await inventory.listAll();

		expect(called).toBe(true);
		expect(result).toEqual([toDiskSession(dateRaw), toDiskSession(stringRaw)]);
	});

	it("returns empty for an unknown cwd", async () => {
		const inventory = inventoryFrom(fakeManager());
		expect(await inventory.listForCwd("/other")).toEqual([]);
	});
});

describe("inventoryFrom.deleteSession", () => {
	it("delegates path + opts to manager.deleteSession and returns its result", async () => {
		let seen: { path?: string; opts?: { activeSessionPath?: string } } = {};
		const manager: SessionManagerLike = {
			list: async () => [],
			listAll: async () => [],
			deleteSession: async (path, opts) => {
				seen = { path, opts };
				return { ok: true, method: "trash" };
			},
		};
		const inventory = inventoryFrom(manager);
		const result = await inventory.deleteSession("/proj/.dreb/sessions/a.jsonl", {
			activeSessionPath: "/proj/.dreb/sessions/b.jsonl",
		});

		expect(seen.path).toBe("/proj/.dreb/sessions/a.jsonl");
		expect(seen.opts).toEqual({ activeSessionPath: "/proj/.dreb/sessions/b.jsonl" });
		expect(result).toEqual({ ok: true, method: "trash" });
	});

	it("propagates a failure result (ok:false with an error) rather than throwing", async () => {
		const manager: SessionManagerLike = {
			list: async () => [],
			listAll: async () => [],
			deleteSession: async () => ({
				ok: false,
				method: "unlink",
				error: "Cannot delete the currently active session",
			}),
		};
		const inventory = inventoryFrom(manager);
		const result = await inventory.deleteSession("/proj/.dreb/sessions/a.jsonl");

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/active session/);
	});
});
