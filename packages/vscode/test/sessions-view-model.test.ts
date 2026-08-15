import { describe, expect, it, vi } from "vitest";
import { type FlagMemento, SessionFlagsStore } from "../src/host/session-flags.js";
import type { DiskSession, SessionInventory } from "../src/host/session-inventory.js";
import { type SessionsViewDeps, SessionsViewModel } from "../src/host/sessions-view-model.js";
import type { LiveSessionInput } from "../src/shared/session-list.js";
import type { HostToSidebar } from "../src/shared/sidebar-protocol.js";

/** In-memory Memento for the flags store. */
class FakeMemento implements FlagMemento {
	private readonly map = new Map<string, unknown>();
	get<T>(key: string): T | undefined {
		return this.map.get(key) as T | undefined;
	}
	async update(key: string, value: unknown): Promise<void> {
		this.map.set(key, value);
	}
}

function disk(path: string, cwd: string, over: Partial<DiskSession> = {}): DiskSession {
	return {
		path,
		id: path,
		cwd,
		created: "2020-01-01T00:00:00.000Z",
		modified: "2020-01-01T00:00:00.000Z",
		messageCount: 1,
		firstMessage: "hi",
		...over,
	};
}

function makeModel(over: Partial<SessionsViewDeps> = {}) {
	const posted: HostToSidebar[] = [];
	const diskSessions: DiskSession[] = over.inventory ? [] : [disk("/p/a.jsonl", "/p")];
	const inventory: SessionInventory = {
		listAll: async () => diskSessions,
		listForCwd: async (cwd) => diskSessions.filter((s) => s.cwd === cwd),
		deleteSession: async () => ({ ok: true, method: "trash" }),
	};
	const flags = new SessionFlagsStore(new FakeMemento());
	let live: LiveSessionInput[] = [];
	const deps: SessionsViewDeps = {
		inventory,
		flags,
		currentCwd: () => "/p",
		liveSessions: () => live,
		pathForKey: (key) => (key.startsWith("new:") ? undefined : key),
		post: (m) => posted.push(m),
		openSession: vi.fn(async () => {}),
		newSession: vi.fn(async () => {}),
		renameSession: vi.fn(async () => {}),
		deleteSession: vi.fn(async () => {}),
		stopSession: vi.fn(async () => {}),
		...over,
	};
	const model = new SessionsViewModel(deps);
	return {
		model,
		deps,
		posted,
		flags,
		setLive: (l: LiveSessionInput[]) => {
			live = l;
		},
	};
}

const lastList = (posted: HostToSidebar[]) => {
	const msg = [...posted].reverse().find((m) => m.type === "list");
	if (!msg || msg.type !== "list") throw new Error("no list posted");
	return msg.list;
};

describe("SessionsViewModel", () => {
	it("posts a built list on ready and on refresh", async () => {
		const { model, posted } = makeModel();
		await model.handle({ type: "ready" });
		const list = lastList(posted);
		expect(list.currentCwd).toBe("/p");
		expect(list.groups[0]?.sessions[0]?.path).toBe("/p/a.jsonl");
	});

	it("merges a live session onto its disk row (no duplicate) with live state", async () => {
		const { model, posted, setLive } = makeModel();
		setLive([{ key: "/p/a.jsonl", cwd: "/p", path: "/p/a.jsonl", state: "running" }]);
		await model.handle({ type: "refresh" });
		const rows = lastList(posted).groups.flatMap((g) => g.sessions);
		expect(rows).toHaveLength(1);
		expect(rows[0].live).toBe(true);
		expect(rows[0].state).toBe("running");
	});

	it("open delegates to openSession and does not post a list itself", async () => {
		const { model, deps, posted } = makeModel();
		await model.handle({ type: "open", key: "/p/a.jsonl" });
		expect(deps.openSession).toHaveBeenCalledWith("/p/a.jsonl");
		expect(posted.some((m) => m.type === "list")).toBe(false);
	});

	it("new delegates to newSession", async () => {
		const { model, deps } = makeModel();
		await model.handle({ type: "new" });
		expect(deps.newSession).toHaveBeenCalledOnce();
	});

	it("rename delegates then refreshes", async () => {
		const { model, deps, posted } = makeModel();
		await model.handle({ type: "rename", key: "/p/a.jsonl", name: "renamed" });
		expect(deps.renameSession).toHaveBeenCalledWith("/p/a.jsonl", "renamed");
		expect(posted.some((m) => m.type === "list")).toBe(true);
	});

	it("pin persists via flags (keyed by path) and refreshes", async () => {
		const { model, posted, flags } = makeModel();
		await model.handle({ type: "pin", key: "/p/a.jsonl", pinned: true });
		expect(flags.get("/p/a.jsonl").pinned).toBe(true);
		expect(lastList(posted).groups[0].sessions[0].pinned).toBe(true);
	});

	it("archive moves the row into the Archived group", async () => {
		const { model, posted } = makeModel();
		await model.handle({ type: "archive", key: "/p/a.jsonl", archived: true });
		const list = lastList(posted);
		expect(list.groups.some((g) => g.kind === "archived")).toBe(true);
		expect(list.groups.find((g) => g.kind === "current")).toBeUndefined();
	});

	it("pin/archive on a not-yet-persisted key (no path) is a no-op", async () => {
		const { model, deps, posted } = makeModel();
		const spy = vi.spyOn(deps.flags, "setPinned");
		await model.handle({ type: "pin", key: "new:abc", pinned: true });
		expect(spy).not.toHaveBeenCalled();
		expect(posted.some((m) => m.type === "list")).toBe(false);
	});

	it("delete delegates then refreshes", async () => {
		const { model, deps, posted } = makeModel();
		await model.handle({ type: "delete", key: "/p/a.jsonl" });
		expect(deps.deleteSession).toHaveBeenCalledWith("/p/a.jsonl");
		expect(posted.some((m) => m.type === "list")).toBe(true);
	});

	it("stop delegates to stopSession then refreshes", async () => {
		const { model, deps, posted } = makeModel();
		await model.handle({ type: "stop", key: "/p/a.jsonl" });
		expect(deps.stopSession).toHaveBeenCalledWith("/p/a.jsonl");
		expect(posted.some((m) => m.type === "list")).toBe(true);
	});

	it("swallows inventory errors without throwing", async () => {
		const inventory: SessionInventory = {
			listAll: async () => {
				throw new Error("disk boom");
			},
			listForCwd: async () => [],
			deleteSession: async () => ({ ok: true, method: "trash" }),
		};
		const logs: string[] = [];
		const { model, posted } = makeModel({ inventory, logger: (l) => logs.push(l) });
		await model.handle({ type: "refresh" });
		expect(posted.some((m) => m.type === "list")).toBe(false);
		expect(logs.some((l) => l.includes("disk boom"))).toBe(true);
	});
});
