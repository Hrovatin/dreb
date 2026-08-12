/**
 * Single-slot session registry enforcing the "one live chat panel" invariant.
 *
 * The extension keeps exactly one {@link https://code.visualstudio.com/api | vscode}
 * webview panel + `SessionController` at a time. Reopening after `/quit` must
 * tear the dead session down and build a fresh one; revealing a live session
 * must not build a second. Both of those paths, plus panel-close teardown, race
 * against each other because VS Code does not serialize async command handlers.
 *
 * This module holds the vscode-free, unit-testable core of that lifecycle so the
 * concurrency rules can be pinned without a full webview mock. `extension.ts`
 * injects the vscode-specific operations via {@link SessionOps}.
 */

/** vscode-specific operations the registry performs on a session object. */
export interface SessionOps<S extends object> {
	/** Whether the session's controller has been torn down (e.g. via `/quit`). */
	isDisposed(session: S): boolean;
	/** Bring the session's panel to the foreground. */
	reveal(session: S): void;
	/** Release the session's resources (webview connection, controller, panel). */
	teardown(session: S): Promise<void>;
}

export class SessionRegistry<S extends object> {
	private current: S | undefined;
	/** Sessions already torn down, so a panel-close firing after an explicit
	 * teardown (or vice versa) doesn't double-release resources. */
	private readonly tornDown = new WeakSet<S>();

	constructor(private readonly ops: SessionOps<S>) {}

	/** The currently registered live session, if any (primarily for tests). */
	get active(): S | undefined {
		return this.current;
	}

	/**
	 * Reveal the live session, or build a fresh one via `create`.
	 *
	 * Reentrancy-safe: a disposed session is torn down first, and because
	 * `teardown` is awaited, a concurrent `open` may install a new session during
	 * that gap — in which case we defer to it rather than orphaning it. Crucially
	 * there is **no `await` between the final decision to build and the `current`
	 * assignment**, so two concurrent opens can never both construct a session.
	 *
	 * `create` is only ever invoked when a new session is actually needed, so it
	 * may perform expensive side effects (spawning the RPC child, creating the
	 * panel) without risk of an immediately-discarded construction.
	 */
	async open(create: () => S): Promise<void> {
		if (this.current !== undefined && !this.ops.isDisposed(this.current)) {
			this.ops.reveal(this.current);
			return;
		}
		if (this.current !== undefined) {
			// Stale session ended via `/quit` (disposed controller, panel left open
			// showing its "session ended" banner). Tear it down before rebuilding.
			await this.disposeSession(this.current);
			// The await above yielded: a concurrent open() may have installed a new
			// live session. Defer to it instead of building a duplicate/orphan.
			if (this.current !== undefined) {
				this.ops.reveal(this.current);
				return;
			}
		}
		this.current = create();
	}

	/**
	 * Tear down a specific session. Only clears `current` if it still points at
	 * this session, so closing an older/orphaned panel never disposes a newer
	 * live session. Idempotent: safe to call from both an explicit `/quit`-driven
	 * path and the panel's `onDidDispose`.
	 */
	async disposeSession(session: S): Promise<void> {
		if (this.tornDown.has(session)) return;
		this.tornDown.add(session);
		if (this.current === session) this.current = undefined;
		await this.ops.teardown(session);
	}

	/** Tear down the live session, if any (used on extension deactivate). */
	async disposeActive(): Promise<void> {
		if (this.current !== undefined) await this.disposeSession(this.current);
	}
}
