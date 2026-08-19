import { beforeEach, describe, expect, it } from "vitest";
import { type OrderMemento, SessionOrderStore } from "../src/host/session-order.js";

/** In-memory {@link OrderMemento} backed by a Map, exposing raw storage for asserts. */
class FakeMemento implements OrderMemento {
	readonly store = new Map<string, unknown>();

	get<T>(key: string): T | undefined {
		return this.store.get(key) as T | undefined;
	}

	async update(key: string, value: unknown): Promise<void> {
		this.store.set(key, value);
	}

	/** Convenience: the persisted order record (or undefined if never written). */
	record(): Record<string, number> | undefined {
		return this.store.get("dreb.sessionOrder") as Record<string, number> | undefined;
	}
}

describe("SessionOrderStore", () => {
	let memento: FakeMemento;
	let store: SessionOrderStore;

	beforeEach(() => {
		memento = new FakeMemento();
		store = new SessionOrderStore(memento);
	});

	it("returns undefined for an unranked or undefined path", () => {
		expect(store.get("/s/a.jsonl")).toBeUndefined();
		expect(store.get(undefined)).toBeUndefined();
	});

	it("setGroupOrder assigns descending ranks so first row sorts first", async () => {
		await store.setGroupOrder(["/s/a.jsonl", "/s/b.jsonl", "/s/c.jsonl"]);
		// First -> largest rank (n), last -> 1.
		expect(store.get("/s/a.jsonl")).toBe(3);
		expect(store.get("/s/b.jsonl")).toBe(2);
		expect(store.get("/s/c.jsonl")).toBe(1);
		expect(memento.record()).toEqual({ "/s/a.jsonl": 3, "/s/b.jsonl": 2, "/s/c.jsonl": 1 });
	});

	it("ranks are small integers that stay below creation-epoch values", async () => {
		await store.setGroupOrder(["/s/a.jsonl", "/s/b.jsonl"]);
		const epochNow = Date.now();
		expect(store.get("/s/a.jsonl")).toBeLessThan(epochNow);
		expect(store.get("/s/b.jsonl")).toBeLessThan(epochNow);
	});

	it("setGroupOrder leaves ranks for paths outside the group untouched", async () => {
		await store.setGroupOrder(["/s/x.jsonl", "/s/y.jsonl"]);
		await store.setGroupOrder(["/s/a.jsonl", "/s/b.jsonl"]);
		expect(memento.record()).toEqual({
			"/s/x.jsonl": 2,
			"/s/y.jsonl": 1,
			"/s/a.jsonl": 2,
			"/s/b.jsonl": 1,
		});
	});

	it("re-ordering the same group overwrites its ranks", async () => {
		await store.setGroupOrder(["/s/a.jsonl", "/s/b.jsonl"]);
		await store.setGroupOrder(["/s/b.jsonl", "/s/a.jsonl"]);
		expect(store.get("/s/b.jsonl")).toBe(2);
		expect(store.get("/s/a.jsonl")).toBe(1);
	});

	it("clear removes a path's stored rank and no-ops when absent", async () => {
		await store.setGroupOrder(["/s/a.jsonl", "/s/b.jsonl"]);
		await store.clear("/s/a.jsonl");
		expect(store.get("/s/a.jsonl")).toBeUndefined();
		expect(store.get("/s/b.jsonl")).toBe(1);
		// Clearing an unranked path is a harmless no-op.
		await store.clear("/s/missing.jsonl");
		expect(memento.record()).toEqual({ "/s/b.jsonl": 1 });
	});
});
