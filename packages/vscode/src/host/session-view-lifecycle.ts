/**
 * Sleep-on-inactivity lifecycle core (vscode-free, unit-testable).
 *
 * Phase 7 decoupled a session's *controller* (its RPC child) from its *webview
 * view* (panel + bridge): closing a chat tab detaches the view but the still-
 * running controller keeps working in the background. Phase 9 replaces the
 * original "sleep almost immediately once detached + idle" policy with two
 * complementary, configurable timers; whichever fires first puts the session to
 * **sleep** — the controller is disposed and its RPC child released — leaving a
 * resumable on-disk row that reopening restores.
 *
 *   - **Idle timer (default 1h):** a *detached + idle* session (turn finished,
 *     nothing pending, view closed) sleeps after it has stayed detached-and-idle
 *     for the idle period. Reattaching a view (reopen), or the run-state moving
 *     away from idle (a new turn / a pending prompt), cancels the pending sleep.
 *     This preserves the Phase-7 rule "never interrupt the agent as it works":
 *     a detached session that is running or needs-input is kept alive by the
 *     idle timer.
 *   - **Inactivity cap (default 4h):** an independent timer reset on every
 *     **user input**. When it fires the session sleeps **regardless of attach
 *     state or run-state** — including a focused tab, a `needs-input` pending
 *     prompt, and a still-`running` turn. This is the abandonment / runaway
 *     backstop: neither an unanswered prompt nor a hung autonomous agent can
 *     hold an RPC child past the cap.
 *
 * Either period configured to `<= 0` disables that timer. Timers run off an
 * injected scheduler (defaulting to `setTimeout`/`clearTimeout`) so the state
 * machine can be pinned deterministically with fake timers. All vscode-specific
 * work (disposing the controller, rebuilding the panel) is injected via
 * {@link SleepHooks}; the matching vscode glue lives in
 * {@link file://./extension.ts}.
 */

import type { SessionRunState } from "../shared/session-list.js";

/** The minimal, vscode-free view of a session the sleeper observes. */
export interface SleepableSession {
	/** The session's current live run state. */
	runState(): SessionRunState;
	/** Whether a webview view (panel) is currently attached. */
	hasView(): boolean;
}

/** Side effects the sleeper performs; injected so the core stays vscode-free. */
export interface SleepHooks {
	/**
	 * Release the session's controller / RPC child, turning it back into a
	 * resumable on-disk row. Invoked at most once (guarded by the slept flag).
	 */
	sleep(): void | Promise<void>;
}

/** An opaque timer handle returned by {@link SleepScheduler.setTimer}. */
export type TimerHandle = unknown;

/** Timer scheduler seam so the two inactivity timers can be driven by fake
 * timers in tests; defaults to the host `setTimeout`/`clearTimeout`. */
export interface SleepScheduler {
	setTimer(fn: () => void, ms: number): TimerHandle;
	clearTimer(handle: TimerHandle): void;
}

const defaultScheduler: SleepScheduler = {
	setTimer: (fn, ms) => setTimeout(fn, ms),
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Default inactivity periods (ms). Mirrors the extension's config defaults. */
const DEFAULT_IDLE_MS = 60 * 60_000; // 1 hour
const DEFAULT_CAP_MS = 4 * 60 * 60_000; // 4 hours

export interface SleepControllerOptions {
	/** Idle-deactivation period in ms (detached + idle). `<= 0` disables it. */
	idleMs?: number;
	/** No-user-input cap in ms (sleeps regardless of state). `<= 0` disables it. */
	capMs?: number;
	/** Timer scheduler (tests inject a fake clock). */
	scheduler?: SleepScheduler;
}

/**
 * Drives sleep-on-inactivity for a single session via two timers.
 *
 * The extension calls {@link onDetach} when the panel closes without an explicit
 * teardown, {@link onAttach} when a view is (re)attached, {@link onUpdate} on
 * every controller update (run-state may have changed), and {@link onUserInput}
 * whenever the user drives the session (submit / answer a prompt). Sleep is run
 * through the injected scheduler and re-checked at fire time so a reopen racing
 * the idle transition cancels it.
 */
export class SleepController {
	private detached = false;
	private slept = false;
	private idleHandle: TimerHandle | undefined;
	private capHandle: TimerHandle | undefined;
	private readonly idleMs: number;
	private readonly capMs: number;
	private readonly scheduler: SleepScheduler;

	constructor(
		private readonly session: SleepableSession,
		private readonly hooks: SleepHooks,
		options: SleepControllerOptions = {},
	) {
		this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
		this.capMs = options.capMs ?? DEFAULT_CAP_MS;
		this.scheduler = options.scheduler ?? defaultScheduler;
		// The inactivity cap counts from session creation: if the user never
		// interacts, the session sleeps capMs later regardless of state.
		this.scheduleCap();
	}

	/** Whether this session has been put to sleep. */
	get isSlept(): boolean {
		return this.slept;
	}

	/** Whether the session is currently detached (no view) and not yet slept. */
	get isDetached(): boolean {
		return this.detached && !this.slept;
	}

	/** The panel was closed without an explicit teardown — background the session
	 * and start (or re-evaluate) the idle timer. */
	onDetach(): void {
		if (this.slept) return;
		this.detached = true;
		this.evaluateIdle();
	}

	/** A view was (re)attached — the session is live again; cancel a pending idle
	 * sleep. The inactivity cap is unaffected (it runs regardless of attach). */
	onAttach(): void {
		this.detached = false;
		this.clearIdle();
	}

	/** A controller update arrived; the run state may now (not) be idle. */
	onUpdate(): void {
		this.evaluateIdle();
	}

	/** The user drove the session (submit / answer a prompt) — reset the cap. */
	onUserInput(): void {
		if (this.slept) return;
		this.scheduleCap();
	}

	/** (Re)evaluate the idle timer against the current detached + view + run
	 * state: schedule when eligible, cancel when not. */
	private evaluateIdle(): void {
		if (this.slept || this.idleMs <= 0) return;
		const eligible = this.detached && !this.session.hasView() && this.session.runState() === "idle";
		if (!eligible) {
			this.clearIdle();
			return;
		}
		if (this.idleHandle !== undefined) return; // already scheduled
		this.idleHandle = this.scheduler.setTimer(() => {
			this.idleHandle = undefined;
			// Re-check at fire time: a reopen (onAttach) or a fresh turn may have
			// intervened between scheduling and firing.
			if (this.slept) return;
			if (!this.detached || this.session.hasView() || this.session.runState() !== "idle") return;
			this.doSleep();
		}, this.idleMs);
	}

	/** (Re)start the inactivity cap timer. Fires regardless of attach/run state. */
	private scheduleCap(): void {
		if (this.slept || this.capMs <= 0) return;
		this.clearCap();
		this.capHandle = this.scheduler.setTimer(() => {
			this.capHandle = undefined;
			if (this.slept) return;
			this.doSleep();
		}, this.capMs);
	}

	private clearIdle(): void {
		if (this.idleHandle !== undefined) {
			this.scheduler.clearTimer(this.idleHandle);
			this.idleHandle = undefined;
		}
	}

	private clearCap(): void {
		if (this.capHandle !== undefined) {
			this.scheduler.clearTimer(this.capHandle);
			this.capHandle = undefined;
		}
	}

	private doSleep(): void {
		if (this.slept) return;
		this.slept = true;
		this.clearIdle();
		this.clearCap();
		void this.hooks.sleep();
	}
}

/** The vscode-free view of a session being (re)opened, for {@link revealOrReattach}. */
export interface RevealTarget {
	/** Whether the session still has a live webview panel. */
	hasPanel(): boolean;
	/** Whether the extension is active (a context exists to rebuild a panel). */
	hasContext(): boolean;
}

/** Injected side effects for {@link revealOrReattach} (vscode work lives here). */
export interface RevealActions {
	/** Bring the session's existing panel to the foreground. */
	reveal(): void;
	/** Rebuild a fresh panel + bridge for a backgrounded session (`attachView`). */
	rebuild(): void;
}

/** What {@link revealOrReattach} did, for observability and tests. */
export type RevealOutcome = "revealed" | "rebuilt" | "skipped";

/**
 * Decide how to surface a (re)opened session:
 *
 *   - a live panel still exists → **reveal** it (bring the tab to the front);
 *   - the session was backgrounded (panel closed, controller still alive) but the
 *     extension is active → **rebuild** a fresh view (`attachView`) over the
 *     surviving controller — the headline Phase 7 reopen flow;
 *   - the extension is shutting down (no context) → **skip** (do not create a
 *     panel after deactivation).
 *
 * Kept vscode-free so the branch that distinguishes reveal-vs-rebuild — the one
 * that makes reopening a backgrounded session actually work — is unit-testable
 * without a webview mock.
 */
export function revealOrReattach(target: RevealTarget, actions: RevealActions): RevealOutcome {
	if (target.hasPanel()) {
		actions.reveal();
		return "revealed";
	}
	if (target.hasContext()) {
		actions.rebuild();
		return "rebuilt";
	}
	return "skipped";
}
