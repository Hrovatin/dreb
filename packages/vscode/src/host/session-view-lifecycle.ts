/**
 * Sleep-on-idle lifecycle core (vscode-free, unit-testable).
 *
 * Phase 7 decouples a session's *controller* (its RPC child) from its *webview
 * view* (panel + bridge). Closing a chat tab no longer kills the agent: instead
 * the view detaches and the still-running controller keeps working in the
 * background. Once a detached session goes **idle** (its turn finished with
 * nothing pending) it is put to **sleep** — the controller is disposed and its
 * RPC child released — leaving a resumable on-disk row that reopening restores.
 *
 * The policy here is deliberately conservative, mirroring the user requirement
 * "never interrupt the agent as it works":
 *
 *   - A detached session that is **running** or **needs-input** is kept alive.
 *     Running would lose in-flight work; needs-input has a pending prompt that a
 *     resumed transcript may not re-raise, so it is surfaced (sidebar + tab
 *     title) rather than slept.
 *   - Sleep only fires when the session is simultaneously detached, view-less,
 *     and idle. Reattaching a view (reopen) cancels any pending sleep.
 *
 * All vscode-specific work (disposing the controller, rebuilding the panel) is
 * injected, so the state machine can be pinned without a webview mock. The
 * matching vscode glue lives in {@link file://./extension.ts}.
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
	 * resumable on-disk row. Invoked at most once, and only while the session is
	 * detached, view-less, and idle.
	 */
	sleep(): void | Promise<void>;
}

/** Schedule a callback to run after the current synchronous work. */
export type Deferrer = (fn: () => void) => void;

/**
 * Drives sleep-on-idle for a single detached session.
 *
 * The extension calls {@link onDetach} when the panel closes without an explicit
 * teardown, {@link onUpdate} on every controller update (run-state may have
 * changed), and {@link onAttach} when a view is (re)attached. The actual
 * {@link SleepHooks.sleep} is deferred (default: microtask) so it never runs
 * from inside a controller's own event emission, and is re-checked at fire time
 * so a reopen racing the idle transition cancels it.
 */
export class SleepController {
	private detached = false;
	private slept = false;
	private scheduled = false;

	constructor(
		private readonly session: SleepableSession,
		private readonly hooks: SleepHooks,
		private readonly defer: Deferrer = queueMicrotask,
	) {}

	/** Whether this session has been put to sleep. */
	get isSlept(): boolean {
		return this.slept;
	}

	/** Whether the session is currently detached (no view) and not yet slept. */
	get isDetached(): boolean {
		return this.detached && !this.slept;
	}

	/** The panel was closed without an explicit teardown — background the session. */
	onDetach(): void {
		if (this.slept) return;
		this.detached = true;
		this.maybeSleep();
	}

	/** A controller update arrived; the run state may now be idle. */
	onUpdate(): void {
		if (this.detached) this.maybeSleep();
	}

	/** A view was (re)attached — the session is live again; cancel pending sleep. */
	onAttach(): void {
		this.detached = false;
	}

	private maybeSleep(): void {
		if (this.slept || this.scheduled || !this.detached) return;
		if (this.session.hasView() || this.session.runState() !== "idle") return;
		this.scheduled = true;
		this.defer(() => {
			this.scheduled = false;
			// Re-check at fire time: a reopen (onAttach) or a fresh turn may have
			// intervened between scheduling and firing.
			if (this.slept || !this.detached) return;
			if (this.session.hasView() || this.session.runState() !== "idle") return;
			this.slept = true;
			void this.hooks.sleep();
		});
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
