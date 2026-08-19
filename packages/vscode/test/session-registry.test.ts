import { describe, expect, it } from "vitest";
import { nextActiveKey, type SessionOps, SessionPool } from "../src/host/session-registry.js";

/** A fake session with controllable disposed-state and an observable teardown
 * whose completion a test can gate to simulate slow/racing `/quit` reopen. */
class FakeSession {
	disposed = false;
	/** Mirrors a *failed* controller (crashed child / failed start): the pool
	 * predicate treats it as not-reusable, exactly like the extension's
	 * `isDisposed() || hasFailed()` composite. */
	failed = false;
	revealed = 0;
	teardownCalls = 0;
	private teardownGate: Promise<void> | undefined;
	private teardownRelease: (() => void) | undefined;

	constructor(public readonly id: string) {}

	gateTeardown(): void {
		this.teardownGate = new Promise<void>((resolve) => {
			this.teardownRelease = resolve;
		});
	}
	releaseTeardown(): void {
		this.teardownRelease?.();
		this.teardownGate = undefined;
		this.teardownRelease = undefined;
	}
	get gate(): Promise<void> | undefined {
		return this.teardownGate;
	}
}

/** Build a pool over FakeSession with observable ops. */
function makePool() {
	const ops: SessionOps<FakeSession> = {
		isDisposed: (s) => s.disposed || s.failed,
		reveal: (s) => {
			s.revealed += 1;
		},
		teardown: async (s) => {
			s.teardownCalls += 1;
			if (s.gate) await s.gate;
		},
	};
	return new SessionPool<FakeSession>(ops);
}

const flush = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("SessionPool", () => {
	it("builds a session on first open(key) and reveals (not rebuilds) a live one", async () => {
		const pool = makePool();
		let built = 0;
		const create = () => {
			built += 1;
			return new FakeSession(`s${built}`);
		};

		const first = await pool.open("k", create);
		expect(built).toBe(1);
		expect(first.id).toBe("s1");
		expect(pool.get("k")).toBe(first);

		const again = await pool.open("k", create);
		expect(built).toBe(1); // not rebuilt
		expect(again).toBe(first); // same session returned
		expect(pool.get("k")).toBe(first); // same session stored
		expect(first.revealed).toBe(1); // revealed instead
	});

	it("tears down a disposed session and builds a fresh one on reopen(key)", async () => {
		const pool = makePool();
		const sessions: FakeSession[] = [];
		const create = () => {
			const s = new FakeSession(`s${sessions.length + 1}`);
			sessions.push(s);
			return s;
		};

		await pool.open("k", create); // s1 live
		sessions[0].disposed = true; // ended via /quit

		const fresh = await pool.open("k", create); // tear down s1, build s2
		expect(sessions).toHaveLength(2);
		expect(sessions[0].teardownCalls).toBe(1); // dead panel torn down
		expect(fresh).toBe(sessions[1]);
		expect(pool.get("k")).toBe(sessions[1]); // fresh session live
		expect(sessions[1].revealed).toBe(0); // brand new, not revealed
	});

	it("tears down a FAILED (crashed) session and rebuilds on reopen(key)", async () => {
		// Mirrors Phase 9 Item 1: a crashed session (child exited, controller not
		// disposed) is treated as not-reusable by the composite predicate, so
		// reopening rebuilds a fresh session rather than revealing the dead one.
		const pool = makePool();
		const sessions: FakeSession[] = [];
		const create = () => {
			const s = new FakeSession(`s${sessions.length + 1}`);
			sessions.push(s);
			return s;
		};

		await pool.open("k", create); // s1 live
		sessions[0].failed = true; // RPC child crashed (but NOT disposed)

		const fresh = await pool.open("k", create); // tear down s1, build s2
		expect(sessions).toHaveLength(2);
		expect(sessions[0].teardownCalls).toBe(1); // dead session torn down
		expect(fresh).toBe(sessions[1]);
		expect(pool.get("k")).toBe(sessions[1]); // fresh session live
		expect(sessions[1].revealed).toBe(0); // rebuilt, not revealed
	});

	it("defers to a concurrent open() for the SAME key instead of orphaning it (reentrancy race)", async () => {
		const pool = makePool();
		const sessions: FakeSession[] = [];
		const create = () => {
			const s = new FakeSession(`s${sessions.length + 1}`);
			sessions.push(s);
			return s;
		};

		await pool.open("k", create); // s1 live
		const s1 = sessions[0];
		s1.disposed = true; // ended via /quit
		s1.gateTeardown(); // hold s1's teardown mid-flight

		// Invocation A: sees s1 disposed, starts tearing it down, suspends on the gate.
		const createSpyBefore = sessions.length;
		const pA = pool.open("k", create);
		await flush();
		// s1's teardown is in flight; the key has been cleared during the await.
		expect(s1.teardownCalls).toBe(1);
		expect(pool.get("k")).toBeUndefined();
		// A has NOT yet built its session (it's suspended before the create call).
		expect(sessions.length).toBe(createSpyBefore);

		// Invocation B fires while A is suspended: the key is empty, so it builds a
		// brand-new live session (s2) and installs it under the same key.
		const s2 = await pool.open("k", create); // resolves synchronously past the awaits
		expect(s2.id).toBe("s2");
		expect(pool.get("k")).toBe(s2);

		// Release s1's teardown so A resumes. A must DEFER to s2, not orphan it.
		s1.releaseTeardown();
		const aResult = await pA;
		await flush();

		expect(aResult).toBe(s2); // A deferred to s2 and returned it
		expect(pool.get("k")).toBe(s2); // s2 still the one-and-only live session for k
		expect(sessions).toHaveLength(2); // A never built a third (orphan) session
		expect(s2.revealed).toBe(1); // A revealed the concurrent session instead
	});

	it("scopes teardown to its own session — closing an old session never disposes a newer live one under the same key", async () => {
		const pool = makePool();
		const old = new FakeSession("old");
		await pool.open("k", () => old); // old is live under k
		old.disposed = true;

		// Reopen k: tears down old, installs a fresh live session under the same key.
		const live = new FakeSession("live");
		await pool.open("k", () => live);
		expect(pool.get("k")).toBe(live);

		// A late panel-close for the OLD session fires. It must not clobber `live`.
		await pool.disposeSession(old);
		expect(old.teardownCalls).toBe(1); // old torn down exactly once
		expect(live.teardownCalls).toBe(0); // live one untouched
		expect(pool.get("k")).toBe(live); // key not clobbered
	});

	it("disposeSession is idempotent (explicit /quit + panel onDidDispose)", async () => {
		const pool = makePool();
		const s = new FakeSession("s");
		await pool.open("k", () => s);

		await pool.disposeSession(s);
		await pool.disposeSession(s); // e.g. panel.onDidDispose firing after
		expect(s.teardownCalls).toBe(1); // torn down exactly once
		expect(pool.get("k")).toBeUndefined();
	});

	it("keeps multiple keyed sessions alive concurrently", async () => {
		const pool = makePool();
		const a = new FakeSession("a");
		const b = new FakeSession("b");

		const ra = await pool.open("a", () => a);
		const rb = await pool.open("b", () => b);
		expect(ra).toBe(a);
		expect(rb).toBe(b);
		expect(pool.size).toBe(2);
		expect(pool.get("a")).toBe(a);
		expect(pool.get("b")).toBe(b);
		expect(pool.has("a")).toBe(true);
		expect(pool.has("b")).toBe(true);
		expect(pool.list()).toEqual([a, b]); // insertion order
	});

	it("tracks the active key via setActive/active", async () => {
		const pool = makePool();
		const a = new FakeSession("a");
		const b = new FakeSession("b");
		await pool.open("a", () => a);
		await pool.open("b", () => b);

		expect(pool.active).toBeUndefined(); // nothing focused yet

		pool.setActive("a");
		expect(pool.active).toBe(a);

		pool.setActive("b");
		expect(pool.active).toBe(b);

		pool.setActive("nope"); // absent key -> no-op, focus unchanged
		expect(pool.active).toBe(b);

		pool.setActive(undefined); // clears focus
		expect(pool.active).toBeUndefined();
	});

	it("clears active when the active session is disposed", async () => {
		const pool = makePool();
		const a = new FakeSession("a");
		const b = new FakeSession("b");
		await pool.open("a", () => a);
		await pool.open("b", () => b);
		pool.setActive("a");
		expect(pool.active).toBe(a);

		await pool.disposeSession(a);
		expect(pool.active).toBeUndefined(); // active cleared
		expect(pool.get("a")).toBeUndefined();
		expect(pool.get("b")).toBe(b); // other session untouched
	});

	it("retains lastActive when focus is cleared (blur to a non-dreb window)", async () => {
		const pool = makePool();
		const a = new FakeSession("a");
		await pool.open("a", () => a);

		expect(pool.lastActive).toBeUndefined(); // nothing focused yet

		pool.setActive("a");
		expect(pool.active).toBe(a);
		expect(pool.lastActive).toBe(a);

		pool.setActive(undefined); // focus leaves for a code editor
		expect(pool.active).toBeUndefined(); // focus cleared
		expect(pool.lastActive).toBe(a); // last-active retained
	});

	it("lastActive follows the most recently focused session", async () => {
		const pool = makePool();
		const a = new FakeSession("a");
		const b = new FakeSession("b");
		await pool.open("a", () => a);
		await pool.open("b", () => b);

		pool.setActive("a");
		expect(pool.lastActive).toBe(a);

		pool.setActive("b");
		expect(pool.lastActive).toBe(b); // switched chats

		pool.setActive("nope"); // absent key -> no-op
		expect(pool.lastActive).toBe(b); // unchanged

		pool.setActive(undefined); // blur
		expect(pool.lastActive).toBe(b); // still the last real focus
	});

	it("clears lastActive when the last-active session is disposed (falls back to new)", async () => {
		const pool = makePool();
		const a = new FakeSession("a");
		const b = new FakeSession("b");
		await pool.open("a", () => a);
		await pool.open("b", () => b);
		pool.setActive("a");
		pool.setActive(undefined); // focus gone, but a is still last-active
		expect(pool.lastActive).toBe(a);

		await pool.disposeSession(a);
		expect(pool.lastActive).toBeUndefined(); // cleared on teardown
		expect(pool.get("b")).toBe(b); // other session untouched
	});

	it("disposeAll clears lastActive", async () => {
		const pool = makePool();
		const a = new FakeSession("a");
		await pool.open("a", () => a);
		pool.setActive("a");
		pool.setActive(undefined);
		expect(pool.lastActive).toBe(a);

		await pool.disposeAll();
		expect(pool.lastActive).toBeUndefined();
	});

	it("disposeKey tears down the session under a key", async () => {
		const pool = makePool();
		const a = new FakeSession("a");
		await pool.open("a", () => a);

		await pool.disposeKey("missing"); // no-op when absent
		await pool.disposeKey("a");
		expect(a.teardownCalls).toBe(1);
		expect(pool.get("a")).toBeUndefined();
		expect(pool.size).toBe(0);
	});

	it("disposeAll tears down every session and empties the pool", async () => {
		const pool = makePool();
		const a = new FakeSession("a");
		const b = new FakeSession("b");
		await pool.open("a", () => a);
		await pool.open("b", () => b);
		pool.setActive("a");

		await pool.disposeAll();
		expect(a.teardownCalls).toBe(1);
		expect(b.teardownCalls).toBe(1);
		expect(pool.size).toBe(0);
		expect(pool.list()).toEqual([]);
		expect(pool.active).toBeUndefined();
	});
});

describe("nextActiveKey (view-state focus decision)", () => {
	it("makes a newly-focused panel the active session", () => {
		expect(nextActiveKey(undefined, "b", true)).toBe("b");
		// Even if another session was active, focusing this one takes over.
		expect(nextActiveKey("a", "b", true)).toBe("b");
	});

	it("clears when the recorded-active panel loses focus (blur to non-dreb)", () => {
		expect(nextActiveKey("a", "a", false)).toBeUndefined();
	});

	it("leaves the active key unchanged when a non-active panel blurs", () => {
		// deactivate(old) can fire AFTER activate(new): old blurring must not
		// wipe the newly-active session.
		expect(nextActiveKey("b", "a", false)).toBe("b");
	});

	it("is order-independent for a switch from a to b", () => {
		// activate(b) then deactivate(a):
		let active: string | undefined = "a";
		active = nextActiveKey(active, "b", true); // activate(b)
		active = nextActiveKey(active, "a", false); // deactivate(a)
		expect(active).toBe("b");

		// deactivate(a) then activate(b):
		active = "a";
		active = nextActiveKey(active, "a", false); // deactivate(a)
		active = nextActiveKey(active, "b", true); // activate(b)
		expect(active).toBe("b");
	});

	it("on dispose (not active), clears only if the closed tab was active", () => {
		expect(nextActiveKey("a", "a", false)).toBeUndefined(); // closed active tab
		expect(nextActiveKey("a", "b", false)).toBe("a"); // closed a background tab
	});
});
