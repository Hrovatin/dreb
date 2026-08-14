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
