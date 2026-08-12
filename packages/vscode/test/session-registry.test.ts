import { describe, expect, it } from "vitest";
import { type SessionOps, SessionRegistry } from "../src/host/session-registry.js";

/** A fake session with controllable disposed-state and an observable teardown
 * whose completion a test can gate to simulate slow/racing `/quit` reopen. */
class FakeSession {
	disposed = false;
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

/** Build a registry over FakeSession with observable ops. */
function makeRegistry() {
	const ops: SessionOps<FakeSession> = {
		isDisposed: (s) => s.disposed,
		reveal: (s) => {
			s.revealed += 1;
		},
		teardown: async (s) => {
			s.teardownCalls += 1;
			if (s.gate) await s.gate;
		},
	};
	return new SessionRegistry<FakeSession>(ops);
}

const flush = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("SessionRegistry", () => {
	it("builds a session on first open and reveals (not rebuilds) a live one", async () => {
		const registry = makeRegistry();
		let built = 0;
		const create = () => {
			built += 1;
			return new FakeSession(`s${built}`);
		};

		await registry.open(create);
		expect(built).toBe(1);
		const first = registry.active;
		expect(first?.id).toBe("s1");

		await registry.open(create);
		expect(built).toBe(1); // not rebuilt
		expect(registry.active).toBe(first); // same session
		expect(first?.revealed).toBe(1); // revealed instead
	});

	it("tears down a disposed session and builds a fresh one on reopen", async () => {
		const registry = makeRegistry();
		const sessions: FakeSession[] = [];
		const create = () => {
			const s = new FakeSession(`s${sessions.length + 1}`);
			sessions.push(s);
			return s;
		};

		await registry.open(create); // s1 live
		sessions[0].disposed = true; // ended via /quit

		await registry.open(create); // should tear down s1, build s2
		expect(sessions).toHaveLength(2);
		expect(sessions[0].teardownCalls).toBe(1); // dead panel torn down
		expect(registry.active).toBe(sessions[1]); // fresh session live
		expect(sessions[1].revealed).toBe(0); // brand new, not revealed
	});

	it("defers to a concurrent open() instead of orphaning it (reentrancy race)", async () => {
		const registry = makeRegistry();
		const sessions: FakeSession[] = [];
		const create = () => {
			const s = new FakeSession(`s${sessions.length + 1}`);
			sessions.push(s);
			return s;
		};

		await registry.open(create); // s1 live
		const s1 = sessions[0];
		s1.disposed = true; // ended via /quit
		s1.gateTeardown(); // hold s1's teardown mid-flight

		// Invocation A: sees s1 disposed, starts tearing it down, suspends on the gate.
		const createSpyBefore = sessions.length;
		const pA = registry.open(create);
		await flush();
		// s1's teardown is in flight; current has been cleared during the await.
		expect(s1.teardownCalls).toBe(1);
		expect(registry.active).toBeUndefined();
		// A has NOT yet built its session (it's suspended before the create call).
		expect(sessions.length).toBe(createSpyBefore);

		// Invocation B fires while A is suspended: current is undefined, so it
		// builds a brand-new live session (s2) and installs it.
		await registry.open(create); // resolves synchronously past the awaits
		const s2 = registry.active;
		expect(s2?.id).toBe("s2");

		// Release s1's teardown so A resumes. A must DEFER to s2, not orphan it.
		s1.releaseTeardown();
		await pA;
		await flush();

		expect(registry.active).toBe(s2); // s2 still the one-and-only live session
		expect(sessions).toHaveLength(2); // A never built a third (orphan) session
		expect(s2?.revealed).toBe(1); // A revealed the concurrent session instead
	});

	it("scopes teardown to its own session — closing an old panel never disposes the live one", async () => {
		const registry = makeRegistry();
		const live = new FakeSession("live");
		await registry.open(() => live); // live is current

		// An orphaned/older session's panel closes and fires disposeSession(old).
		const old = new FakeSession("old");
		await registry.disposeSession(old);

		expect(old.teardownCalls).toBe(1); // the old session IS torn down…
		expect(live.teardownCalls).toBe(0); // …but the live one is untouched
		expect(registry.active).toBe(live); // current not clobbered
	});

	it("disposeSession is idempotent (explicit /quit + panel onDidDispose)", async () => {
		const registry = makeRegistry();
		const s = new FakeSession("s");
		await registry.open(() => s);

		await registry.disposeSession(s);
		await registry.disposeSession(s); // e.g. panel.onDidDispose firing after
		expect(s.teardownCalls).toBe(1); // torn down exactly once
		expect(registry.active).toBeUndefined();
	});

	it("disposeActive tears down the live session, if any", async () => {
		const registry = makeRegistry();
		await registry.disposeActive(); // no-op when empty
		const s = new FakeSession("s");
		await registry.open(() => s);

		await registry.disposeActive();
		expect(s.teardownCalls).toBe(1);
		expect(registry.active).toBeUndefined();
	});
});
