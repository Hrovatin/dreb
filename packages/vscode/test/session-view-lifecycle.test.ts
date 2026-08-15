import { describe, expect, it, vi } from "vitest";
import {
	revealOrReattach,
	type SleepableSession,
	SleepController,
	type SleepScheduler,
} from "../src/host/session-view-lifecycle.js";
import type { SessionRunState } from "../src/shared/session-list.js";

/** A deterministic fake clock: one-shot timers fired by advancing wall time. */
function fakeClock() {
	let nowMs = 0;
	let seq = 1;
	const timers = new Map<number, { fireAt: number; fn: () => void }>();
	const scheduler: SleepScheduler = {
		setTimer: (fn, ms) => {
			const id = seq++;
			timers.set(id, { fireAt: nowMs + ms, fn });
			return id;
		},
		clearTimer: (handle) => {
			timers.delete(handle as number);
		},
	};
	const advance = (ms: number) => {
		nowMs += ms;
		const due = [...timers.entries()].filter(([, t]) => t.fireAt <= nowMs).sort((a, b) => a[1].fireAt - b[1].fireAt);
		for (const [id, t] of due) {
			if (timers.delete(id)) t.fn();
		}
	};
	return { scheduler, advance, pending: () => timers.size };
}

/**
 * A controllable session + fake clock, so a test can drive run-state / view
 * attachment / user input and advance the two inactivity timers deterministically.
 */
function harness(opts?: { initial?: SessionRunState; idleMs?: number; capMs?: number }) {
	let state: SessionRunState = opts?.initial ?? "idle";
	let view = true;
	let sleepCalls = 0;
	const clock = fakeClock();
	const session: SleepableSession = {
		runState: () => state,
		hasView: () => view,
	};
	const sleep = new SleepController(
		session,
		{
			sleep: () => {
				sleepCalls += 1;
			},
		},
		{
			// Defaults chosen per-test; a `0` disables that timer.
			idleMs: opts?.idleMs ?? 60 * 60_000,
			capMs: opts?.capMs ?? 4 * 60 * 60_000,
			scheduler: clock.scheduler,
		},
	);

	return {
		sleep,
		advance: clock.advance,
		pending: clock.pending,
		sleepCalls: () => sleepCalls,
		setState: (s: SessionRunState) => {
			state = s;
		},
		setView: (v: boolean) => {
			view = v;
		},
	};
}

describe("SleepController — idle deactivation timer (detached + idle)", () => {
	it("sleeps a detached idle session after the idle period", () => {
		const h = harness({ idleMs: 60_000, capMs: 0 });
		h.setView(false);
		h.sleep.onDetach();
		h.advance(59_999);
		expect(h.sleepCalls()).toBe(0); // not yet
		h.advance(1);
		expect(h.sleepCalls()).toBe(1);
		expect(h.sleep.isSlept).toBe(true);
	});

	it("never sleeps a detached RUNNING session until it goes idle", () => {
		const h = harness({ initial: "running", idleMs: 60_000, capMs: 0 });
		h.setView(false);
		h.sleep.onDetach();
		h.advance(60_000);
		expect(h.sleepCalls()).toBe(0); // still working — never interrupted

		h.setState("idle");
		h.sleep.onUpdate();
		h.advance(60_000);
		expect(h.sleepCalls()).toBe(1);
	});

	it("never sleeps a detached NEEDS-INPUT session (idle timer) until it goes idle", () => {
		const h = harness({ initial: "needs-input", idleMs: 60_000, capMs: 0 });
		h.setView(false);
		h.sleep.onDetach();
		h.advance(60_000);
		expect(h.sleepCalls()).toBe(0); // awaiting input — kept alive by the idle timer

		h.setState("idle");
		h.sleep.onUpdate();
		h.advance(60_000);
		expect(h.sleepCalls()).toBe(1);
	});

	it("never sleeps while a view is attached", () => {
		const h = harness({ idleMs: 60_000, capMs: 0 }); // view attached (default)
		h.sleep.onUpdate();
		h.advance(60_000);
		expect(h.sleepCalls()).toBe(0);
		expect(h.sleep.isDetached).toBe(false);
	});

	it("reattaching a view cancels a pending idle sleep (reopen race)", () => {
		const h = harness({ idleMs: 60_000, capMs: 0 });
		h.setView(false);
		h.sleep.onDetach();
		h.advance(30_000);
		// Reopen arrives before the idle deadline.
		h.setView(true);
		h.sleep.onAttach();
		h.advance(60_000);
		expect(h.sleepCalls()).toBe(0);
		expect(h.sleep.isSlept).toBe(false);
	});

	it("a fresh turn before the deadline cancels the idle sleep, and idle again reschedules it", () => {
		const h = harness({ idleMs: 60_000, capMs: 0 });
		h.setView(false);
		h.sleep.onDetach();
		h.advance(30_000);
		// A new turn starts: run state leaves idle → pending sleep is cancelled.
		h.setState("running");
		h.sleep.onUpdate();
		h.advance(60_000);
		expect(h.sleepCalls()).toBe(0);

		// Turn finishes: eligible again, timer restarts from now.
		h.setState("idle");
		h.sleep.onUpdate();
		h.advance(59_999);
		expect(h.sleepCalls()).toBe(0);
		h.advance(1);
		expect(h.sleepCalls()).toBe(1);
	});

	it("does not restart the idle timer on each update while continuously detached + idle", () => {
		const h = harness({ idleMs: 60_000, capMs: 0 });
		h.setView(false);
		h.sleep.onDetach(); // schedules at t+60_000
		h.advance(30_000);
		h.sleep.onUpdate(); // still idle — must NOT reset the clock
		h.sleep.onUpdate();
		h.advance(30_000); // reaches the original deadline
		expect(h.sleepCalls()).toBe(1);
	});

	it("idleMs = 0 disables the idle timer", () => {
		const h = harness({ idleMs: 0, capMs: 0 });
		h.setView(false);
		h.sleep.onDetach();
		h.advance(24 * 60 * 60_000);
		expect(h.sleepCalls()).toBe(0);
	});
});

describe("SleepController — inactivity cap (no user input, any state)", () => {
	it("schedules the cap from construction", () => {
		const h = harness({ idleMs: 0, capMs: 1000 });
		expect(h.pending()).toBe(1); // the cap timer
	});

	it("sleeps an ATTACHED, RUNNING session at the cap (regardless of state)", () => {
		const h = harness({ initial: "running", idleMs: 0, capMs: 4 * 60 * 60_000 });
		// View stays attached (default) and the turn keeps running — the cap still fires.
		h.advance(4 * 60 * 60_000 - 1);
		expect(h.sleepCalls()).toBe(0);
		h.advance(1);
		expect(h.sleepCalls()).toBe(1);
		expect(h.sleep.isSlept).toBe(true);
	});

	it("sleeps a focused NEEDS-INPUT session at the cap (abandoned pending prompt)", () => {
		const h = harness({ initial: "needs-input", idleMs: 0, capMs: 1000 });
		h.advance(1000);
		expect(h.sleepCalls()).toBe(1);
	});

	it("resets the cap on user input", () => {
		const h = harness({ idleMs: 0, capMs: 1000 });
		h.advance(900);
		h.sleep.onUserInput(); // reset → new deadline at 900 + 1000
		h.advance(900);
		expect(h.sleepCalls()).toBe(0); // would have fired at 1000 without the reset
		h.advance(100);
		expect(h.sleepCalls()).toBe(1);
	});

	it("capMs = 0 disables the cap (no timer scheduled at all)", () => {
		const h = harness({ idleMs: 0, capMs: 0 });
		expect(h.pending()).toBe(0);
		h.advance(24 * 60 * 60_000);
		expect(h.sleepCalls()).toBe(0);
	});
});

describe("SleepController — both timers together", () => {
	it("whichever fires first wins (cap before idle)", () => {
		const h = harness({ idleMs: 5000, capMs: 1000 });
		h.setView(false);
		h.sleep.onDetach();
		h.advance(1000); // cap fires first
		expect(h.sleepCalls()).toBe(1);
		h.advance(5000); // idle deadline passes — slept guard prevents a second call
		expect(h.sleepCalls()).toBe(1);
	});

	it("sleeps at most once and ignores further signals (idle fires first)", () => {
		const h = harness({ idleMs: 1000, capMs: 5000 });
		h.setView(false);
		h.sleep.onDetach();
		h.advance(1000); // idle fires
		expect(h.sleepCalls()).toBe(1);

		// Post-sleep signals are no-ops; the cap never fires a second sleep.
		h.sleep.onDetach();
		h.sleep.onUpdate();
		h.sleep.onUserInput();
		h.advance(60 * 60_000);
		expect(h.sleepCalls()).toBe(1);
	});
});

describe("revealOrReattach", () => {
	it("reveals an existing panel and never rebuilds", () => {
		const reveal = vi.fn();
		const rebuild = vi.fn();
		const outcome = revealOrReattach({ hasPanel: () => true, hasContext: () => true }, { reveal, rebuild });
		expect(outcome).toBe("revealed");
		expect(reveal).toHaveBeenCalledTimes(1);
		expect(rebuild).not.toHaveBeenCalled();
	});

	it("rebuilds a backgrounded (panel-less) session when the extension is active", () => {
		// The headline reopen flow: controller alive, panel closed → a fresh view
		// is rebuilt. A regression that mixed up this branch would make clicking a
		// backgrounded session silently do nothing.
		const reveal = vi.fn();
		const rebuild = vi.fn();
		const outcome = revealOrReattach({ hasPanel: () => false, hasContext: () => true }, { reveal, rebuild });
		expect(outcome).toBe("rebuilt");
		expect(rebuild).toHaveBeenCalledTimes(1);
		expect(reveal).not.toHaveBeenCalled();
	});

	it("skips (no reveal, no rebuild) when the extension is shutting down", () => {
		// No context after deactivate() → do not create a panel post-shutdown.
		const reveal = vi.fn();
		const rebuild = vi.fn();
		const outcome = revealOrReattach({ hasPanel: () => false, hasContext: () => false }, { reveal, rebuild });
		expect(outcome).toBe("skipped");
		expect(reveal).not.toHaveBeenCalled();
		expect(rebuild).not.toHaveBeenCalled();
	});

	it("prefers revealing an existing panel even if a context is also available", () => {
		const reveal = vi.fn();
		const rebuild = vi.fn();
		const outcome = revealOrReattach({ hasPanel: () => true, hasContext: () => false }, { reveal, rebuild });
		expect(outcome).toBe("revealed");
		expect(reveal).toHaveBeenCalledTimes(1);
		expect(rebuild).not.toHaveBeenCalled();
	});
});
