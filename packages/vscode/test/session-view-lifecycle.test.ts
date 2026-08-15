import { describe, expect, it } from "vitest";
import { type Deferrer, type SleepableSession, SleepController } from "../src/host/session-view-lifecycle.js";
import type { SessionRunState } from "../src/shared/session-list.js";

/**
 * A controllable session + a manual deferrer, so a test can drive run-state and
 * view attachment and then flush the scheduled sleep deterministically.
 */
function harness(initial: SessionRunState = "idle") {
	let state: SessionRunState = initial;
	let view = true;
	let sleepCalls = 0;
	const queue: Array<() => void> = [];
	const defer: Deferrer = (fn) => queue.push(fn);
	const flush = () => {
		const jobs = queue.splice(0);
		for (const job of jobs) job();
	};

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
		defer,
	);

	return {
		sleep,
		flush,
		queued: () => queue.length,
		sleepCalls: () => sleepCalls,
		setState: (s: SessionRunState) => {
			state = s;
		},
		setView: (v: boolean) => {
			view = v;
		},
	};
}

describe("SleepController (sleep-on-idle)", () => {
	it("sleeps a detached idle session (after the deferred fire)", () => {
		const h = harness("idle");
		h.setView(false);
		h.sleep.onDetach();
		expect(h.sleepCalls()).toBe(0); // deferred, not synchronous
		h.flush();
		expect(h.sleepCalls()).toBe(1);
		expect(h.sleep.isSlept).toBe(true);
	});

	it("never sleeps a detached RUNNING session until it goes idle", () => {
		const h = harness("running");
		h.setView(false);
		h.sleep.onDetach();
		h.flush();
		expect(h.sleepCalls()).toBe(0); // still working — never interrupted

		// Turn finishes: run state flips to idle and a controller update arrives.
		h.setState("idle");
		h.sleep.onUpdate();
		h.flush();
		expect(h.sleepCalls()).toBe(1);
	});

	it("never sleeps a detached NEEDS-INPUT session until it goes idle", () => {
		const h = harness("needs-input");
		h.setView(false);
		h.sleep.onDetach();
		h.flush();
		expect(h.sleepCalls()).toBe(0); // awaiting input — kept alive, surfaced instead

		// Still needs-input on a later update — still no sleep.
		h.sleep.onUpdate();
		h.flush();
		expect(h.sleepCalls()).toBe(0);

		// Resolved and idle now.
		h.setState("idle");
		h.sleep.onUpdate();
		h.flush();
		expect(h.sleepCalls()).toBe(1);
	});

	it("never sleeps while a view is attached (idle updates are ignored)", () => {
		const h = harness("idle"); // view attached (default)
		h.sleep.onUpdate();
		h.flush();
		expect(h.sleepCalls()).toBe(0);
		expect(h.sleep.isDetached).toBe(false);
	});

	it("reattaching a view cancels a scheduled sleep (reopen race)", () => {
		const h = harness("idle");
		h.setView(false);
		h.sleep.onDetach(); // schedules a sleep
		expect(h.queued()).toBe(1);

		// Reopen arrives before the deferred sleep fires.
		h.setView(true);
		h.sleep.onAttach();
		h.flush();
		expect(h.sleepCalls()).toBe(0); // re-check at fire time bailed
		expect(h.sleep.isSlept).toBe(false);
	});

	it("re-checks run state at fire time — a fresh turn between schedule and fire cancels sleep", () => {
		const h = harness("idle");
		h.setView(false);
		h.sleep.onDetach(); // schedules
		// A new turn starts before the deferred sleep runs.
		h.setState("running");
		h.flush();
		expect(h.sleepCalls()).toBe(0);
		expect(h.sleep.isSlept).toBe(false);
	});

	it("coalesces multiple idle updates into a single scheduled sleep", () => {
		const h = harness("idle");
		h.setView(false);
		h.sleep.onDetach();
		h.sleep.onUpdate();
		h.sleep.onUpdate();
		expect(h.queued()).toBe(1); // scheduled once
		h.flush();
		expect(h.sleepCalls()).toBe(1);
	});

	it("sleeps at most once and ignores further signals", () => {
		const h = harness("idle");
		h.setView(false);
		h.sleep.onDetach();
		h.flush();
		expect(h.sleepCalls()).toBe(1);

		h.sleep.onDetach();
		h.sleep.onUpdate();
		h.flush();
		expect(h.sleepCalls()).toBe(1); // no second sleep
	});

	it("does not sleep on onUpdate before any detach (still attached)", () => {
		const h = harness("idle");
		h.sleep.onUpdate();
		h.sleep.onUpdate();
		h.flush();
		expect(h.sleepCalls()).toBe(0);
	});
});
