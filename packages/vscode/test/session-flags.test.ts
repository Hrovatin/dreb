import { beforeEach, describe, expect, it } from "vitest";
import { type FlagMemento, SessionFlagsStore } from "../src/host/session-flags.js";

/** In-memory {@link FlagMemento} backed by a Map, exposing raw storage for asserts. */
class FakeMemento implements FlagMemento {
	readonly store = new Map<string, unknown>();

	get<T>(key: string): T | undefined {
		return this.store.get(key) as T | undefined;
	}

	async update(key: string, value: unknown): Promise<void> {
		this.store.set(key, value);
	}

	/** Convenience: the persisted flag record (or undefined if never written). */
	record(): Record<string, { pinned?: boolean; archived?: boolean }> | undefined {
		return this.store.get("dreb.sessionFlags") as
			| Record<string, { pinned?: boolean; archived?: boolean }>
			| undefined;
	}
}

describe("SessionFlagsStore", () => {
	let memento: FakeMemento;
	let store: SessionFlagsStore;
	const PATH = "/sessions/abc.jsonl";

	beforeEach(() => {
		memento = new FakeMemento();
		store = new SessionFlagsStore(memento);
	});

	it("defaults to unpinned/unarchived for an unknown path", () => {
		expect(store.get(PATH)).toEqual({ pinned: false, archived: false });
	});

	it("returns false/false for an undefined path", () => {
		expect(store.get(undefined)).toEqual({ pinned: false, archived: false });
	});

	it("persists a pinned flag and reflects it on get", async () => {
		await store.setPinned(PATH, true);
		expect(store.get(PATH)).toEqual({ pinned: true, archived: false });
		expect(memento.record()).toEqual({ [PATH]: { pinned: true } });
	});

	it("removes the entry once both flags return to false", async () => {
		await store.setArchived(PATH, true);
		await store.setPinned(PATH, false);
		// archived still true -> entry retained (pinned stored as false)
		expect(memento.record()).toEqual({ [PATH]: { pinned: false, archived: true } });
		expect(store.get(PATH)).toEqual({ pinned: false, archived: true });

		await store.setArchived(PATH, false);
		// both false now -> path key removed entirely
		expect(memento.record()).toEqual({});
		expect(store.get(PATH)).toEqual({ pinned: false, archived: false });
	});

	it("clear() removes a path's stored flags", async () => {
		await store.setPinned(PATH, true);
		await store.setArchived(PATH, true);
		expect(memento.record()).toEqual({ [PATH]: { pinned: true, archived: true } });

		await store.clear(PATH);
		expect(memento.record()).toEqual({});
		expect(store.get(PATH)).toEqual({ pinned: false, archived: false });
	});

	it("keeps flags for different paths independent", async () => {
		const other = "/sessions/def.jsonl";
		await store.setPinned(PATH, true);
		await store.setArchived(other, true);

		expect(store.get(PATH)).toEqual({ pinned: true, archived: false });
		expect(store.get(other)).toEqual({ pinned: false, archived: true });
		expect(memento.record()).toEqual({
			[PATH]: { pinned: true },
			[other]: { archived: true },
		});
	});
});
