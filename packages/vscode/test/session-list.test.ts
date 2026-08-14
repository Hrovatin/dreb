import { describe, expect, it } from "vitest";
import {
	buildSessionList,
	type DiskSessionInput,
	deriveSessionStatus,
	type LiveSessionInput,
	type SessionFlags,
} from "../src/shared/session-list.js";

/** Simple flags stub: no path or unlisted path => all-false. */
function flagsFrom(map: Record<string, SessionFlags>): (path: string | undefined) => SessionFlags {
	return (path) => (path && map[path]) || { pinned: false, archived: false };
}

const noFlags = flagsFrom({});

function disk(overrides: Partial<DiskSessionInput> & { path: string }): DiskSessionInput {
	return {
		cwd: "/proj",
		firstMessage: "hello",
		modified: "2026-01-01T00:00:00.000Z",
		messageCount: 1,
		...overrides,
	};
}

function live(overrides: Partial<LiveSessionInput> & { key: string }): LiveSessionInput {
	return {
		cwd: "/proj",
		state: "running",
		...overrides,
	};
}

describe("deriveSessionStatus", () => {
	it("is running when streaming", () => {
		expect(deriveSessionStatus({ streaming: true, uiRequests: [] })).toBe("running");
	});
	it("is running when streaming even with pending requests", () => {
		expect(deriveSessionStatus({ streaming: true, uiRequests: [{}] })).toBe("running");
	});
	it("is needs-input when not streaming with pending requests", () => {
		expect(deriveSessionStatus({ streaming: false, uiRequests: [{}] })).toBe("needs-input");
	});
	it("is idle when not streaming with no requests", () => {
		expect(deriveSessionStatus({ streaming: false, uiRequests: [] })).toBe("idle");
	});
});

describe("buildSessionList", () => {
	it("(a) maps disk-only rows and groups by current vs project cwd", () => {
		const list = buildSessionList({
			currentCwd: "/proj",
			disk: [
				disk({ path: "/proj/a.jsonl", name: "Alpha" }),
				disk({ path: "/other/b.jsonl", cwd: "/other", firstMessage: "beta talk" }),
			],
			live: [],
			flags: noFlags,
		});

		expect(list.currentCwd).toBe("/proj");
		expect(list.groups.map((g) => g.kind)).toEqual(["current", "project"]);

		const current = list.groups[0];
		expect(current.label).toBe("This workspace");
		expect(current.cwd).toBe("/proj");
		expect(current.sessions).toHaveLength(1);
		const row = current.sessions[0];
		expect(row.key).toBe("/proj/a.jsonl");
		expect(row.path).toBe("/proj/a.jsonl");
		expect(row.title).toBe("Alpha");
		expect(row.state).toBe("idle");
		expect(row.live).toBe(false);

		const project = list.groups[1];
		expect(project.kind).toBe("project");
		expect(project.label).toBe("other");
		expect(project.cwd).toBe("/other");
		expect(project.sessions[0].title).toBe("beta talk");
	});

	it("falls back title to firstMessage then to (untitled session)", () => {
		const list = buildSessionList({
			currentCwd: "/proj",
			disk: [disk({ path: "/proj/x.jsonl", name: "  ", firstMessage: "  " })],
			live: [],
			flags: noFlags,
		});
		expect(list.groups[0].sessions[0].title).toBe("(untitled session)");
	});

	it("(b) merges a live session onto the matching disk row without duplicating", () => {
		const list = buildSessionList({
			currentCwd: "/proj",
			disk: [disk({ path: "/proj/a.jsonl", name: "Alpha", messageCount: 3 })],
			live: [live({ key: "pool-1", path: "/proj/a.jsonl", state: "needs-input", messageCount: 5 })],
			flags: noFlags,
		});

		const rows = list.groups[0].sessions;
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row.live).toBe(true);
		expect(row.state).toBe("needs-input");
		expect(row.key).toBe("pool-1"); // pool key wins so open/dispose round-trips
		expect(row.path).toBe("/proj/a.jsonl");
		expect(row.title).toBe("Alpha"); // no live title override provided
		expect(row.messageCount).toBe(5);
	});

	it("(c) appends a pathless live session as a New session in the current group", () => {
		const list = buildSessionList({
			currentCwd: "/proj",
			disk: [disk({ path: "/proj/a.jsonl", name: "Alpha" })],
			live: [live({ key: "pool-new", state: "running" })],
			flags: noFlags,
		});

		const current = list.groups[0];
		expect(current.sessions).toHaveLength(2);
		const fresh = current.sessions.find((s) => s.key === "pool-new");
		expect(fresh).toBeDefined();
		expect(fresh?.title).toBe("New session");
		expect(fresh?.path).toBeUndefined();
		expect(fresh?.live).toBe(true);
		expect(fresh?.state).toBe("running");
	});

	it("(d) sorts pinned rows before unpinned, then by modified desc", () => {
		const list = buildSessionList({
			currentCwd: "/proj",
			disk: [
				disk({ path: "/proj/old.jsonl", name: "Old", modified: "2026-01-01T00:00:00.000Z" }),
				disk({ path: "/proj/new.jsonl", name: "New", modified: "2026-06-01T00:00:00.000Z" }),
				disk({ path: "/proj/pinned.jsonl", name: "Pinned", modified: "2020-01-01T00:00:00.000Z" }),
			],
			live: [],
			flags: flagsFrom({ "/proj/pinned.jsonl": { pinned: true, archived: false } }),
		});

		const titles = list.groups[0].sessions.map((s) => s.title);
		// Pinned first despite being oldest; then modified DESC among unpinned.
		expect(titles).toEqual(["Pinned", "New", "Old"]);
	});

	it("(e) moves archived rows to the Archived group regardless of cwd", () => {
		const list = buildSessionList({
			currentCwd: "/proj",
			disk: [
				disk({ path: "/proj/a.jsonl", name: "Alpha" }),
				disk({ path: "/other/b.jsonl", cwd: "/other", name: "Beta" }),
			],
			live: [],
			flags: flagsFrom({
				"/proj/a.jsonl": { pinned: false, archived: true },
				"/other/b.jsonl": { pinned: false, archived: true },
			}),
		});

		const archived = list.groups.find((g) => g.kind === "archived");
		expect(archived).toBeDefined();
		expect(archived?.cwd).toBe("");
		expect(archived?.label).toBe("Archived");
		expect(archived?.sessions.map((s) => s.title).sort()).toEqual(["Alpha", "Beta"]);
		// No current/project group survives since both rows archived.
		expect(list.groups.map((g) => g.kind)).toEqual(["archived"]);
	});

	it("(f) orders groups current -> project(sorted by cwd) -> archived", () => {
		const list = buildSessionList({
			currentCwd: "/proj",
			disk: [
				disk({ path: "/proj/a.jsonl", name: "Cur" }),
				disk({ path: "/zeta/z.jsonl", cwd: "/zeta", name: "Z" }),
				disk({ path: "/alpha/a.jsonl", cwd: "/alpha", name: "A" }),
				disk({ path: "/proj/arch.jsonl", name: "Arch" }),
			],
			live: [],
			flags: flagsFrom({ "/proj/arch.jsonl": { pinned: false, archived: true } }),
		});

		expect(list.groups.map((g) => [g.kind, g.cwd])).toEqual([
			["current", "/proj"],
			["project", "/alpha"],
			["project", "/zeta"],
			["archived", ""],
		]);
	});

	it("(g) run-state change does not reorder rows", () => {
		const base = {
			currentCwd: "/proj",
			disk: [
				disk({ path: "/proj/a.jsonl", name: "A", modified: "2026-01-02T00:00:00.000Z" }),
				disk({ path: "/proj/b.jsonl", name: "B", modified: "2026-01-01T00:00:00.000Z" }),
			],
			flags: noFlags,
		};

		const idle = buildSessionList({ ...base, live: [] });
		const running = buildSessionList({
			...base,
			// B is now live+running but older; must NOT jump ahead of A.
			live: [live({ key: "pool-b", path: "/proj/b.jsonl", state: "running" })],
		});

		const order = (l: ReturnType<typeof buildSessionList>) => l.groups[0].sessions.map((s) => s.title);
		expect(order(idle)).toEqual(["A", "B"]);
		expect(order(running)).toEqual(["A", "B"]);
		expect(running.groups[0].sessions[1].state).toBe("running");
	});

	it("(h) each group carries a stable, unique key (for webview reconcile)", () => {
		const list = buildSessionList({
			currentCwd: "/proj",
			disk: [
				disk({ path: "/proj/a.jsonl", cwd: "/proj", name: "A" }),
				disk({ path: "/alpha/x.jsonl", cwd: "/alpha", name: "X" }),
				disk({ path: "/proj/z.jsonl", cwd: "/proj", name: "Z", modified: "2020-01-01T00:00:00.000Z" }),
			],
			live: [],
			flags: (p) => ({ pinned: false, archived: p === "/proj/z.jsonl" }),
		});

		const keys = list.groups.map((g) => g.key);
		// current + one project + archived, each with the "<kind>:<cwd>" convention.
		expect(keys).toEqual(["current:/proj", "project:/alpha", "archived:"]);
		// keys are unique.
		expect(new Set(keys).size).toBe(keys.length);

		// A rebuild with an added live session produces identical group keys, so the
		// webview reconcile matches groups by identity instead of remounting them.
		const rebuilt = buildSessionList({
			currentCwd: "/proj",
			disk: [
				disk({ path: "/proj/a.jsonl", cwd: "/proj", name: "A" }),
				disk({ path: "/alpha/x.jsonl", cwd: "/alpha", name: "X" }),
				disk({ path: "/proj/z.jsonl", cwd: "/proj", name: "Z", modified: "2020-01-01T00:00:00.000Z" }),
			],
			live: [live({ key: "/proj/a.jsonl", path: "/proj/a.jsonl", cwd: "/proj", state: "running" })],
			flags: (p) => ({ pinned: false, archived: p === "/proj/z.jsonl" }),
		});
		expect(rebuilt.groups.map((g) => g.key)).toEqual(keys);
	});
});
