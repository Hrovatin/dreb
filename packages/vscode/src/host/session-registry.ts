/**
 * Multi-session pool enforcing the "one live chat panel PER SESSION KEY" invariant.
 *
 * The extension may keep several {@link https://code.visualstudio.com/api | vscode}
 * webview panels + `SessionController`s alive at once, one per session key.
 * Within a single key the same lifecycle rules as the old single-slot registry
 * apply: reopening a key after `/quit` must tear the dead session down and build
 * a fresh one; revealing a live session under a key must not build a second
 * (reveal-not-rebuild per key). Panel-close teardown, `/quit` reopen, and reveal
 * all race against each other because VS Code does not serialize async command
 * handlers, so every path is reentrancy-safe per key.
 *
 * Distinct keys are independent: opening, revealing, or disposing one key never
 * affects another. Teardown is scoped and idempotent — a panel-close firing
 * after an explicit teardown (or a stale session under a key that has since been
 * replaced) never double-releases resources or clobbers a newer live session.
 *
 * This module holds the vscode-free, unit-testable core of that lifecycle so the
 * concurrency rules can be pinned without a full webview mock. `extension.ts`
 * injects the vscode-specific operations via {@link SessionOps}.
 */

/** vscode-specific operations the pool performs on a session object. */
export interface SessionOps<S extends object> {
	/** Whether the session's controller has been torn down (e.g. via `/quit`). */
	isDisposed(session: S): boolean;
	/** Bring the session's panel to the foreground. */
	reveal(session: S): void;
	/** Release the session's resources (webview connection, controller, panel). */
	teardown(session: S): Promise<void>;
}

export class SessionPool<S extends object> {
	/** Live sessions keyed by session id, in insertion order. */
	private readonly sessions = new Map<string, S>();
	/** Sessions already torn down, so a panel-close firing after an explicit
	 * teardown (or vice versa) doesn't double-release resources. */
	private readonly tornDown = new WeakSet<S>();
	/** Key of the currently focused session, if any. */
	private activeKey: string | undefined;
	/**
	 * Key of the *most recently focused* session — retained even after focus
	 * leaves the webview for a non-dreb window (e.g. a code editor), unlike
	 * {@link activeKey} which clears on blur. This is the target for actions
	 * invoked from the editor (e.g. "Add Selection to Chat"), which run precisely
	 * when no dreb panel is focused. Only cleared when the session it points at is
	 * torn down.
	 */
	private lastActiveKey: string | undefined;

	constructor(private readonly ops: SessionOps<S>) {}

	/** Number of live sessions in the pool. */
	get size(): number {
		return this.sessions.size;
	}

	/** All live sessions, in Map insertion order. */
	list(): S[] {
		return [...this.sessions.values()];
	}

	/** The live session stored under `key`, if any. */
	get(key: string): S | undefined {
		return this.sessions.get(key);
	}

	/** Whether a live session is stored under `key`. */
	has(key: string): boolean {
		return this.sessions.has(key);
	}

	/** The currently focused live session, if any. */
	get active(): S | undefined {
		return this.activeKey === undefined ? undefined : this.sessions.get(this.activeKey);
	}

	/**
	 * The most recently focused live session, if any. Retained across focus loss
	 * to a non-dreb window (unlike {@link active}); returns `undefined` only when
	 * no session has ever been focused or the last-focused one has been torn down.
	 */
	get lastActive(): S | undefined {
		return this.lastActiveKey === undefined ? undefined : this.sessions.get(this.lastActiveKey);
	}

	/**
	 * Set the focused session key. `undefined` clears the focus; a key that is
	 * not present in the pool is ignored (no-op). A defined, present key is also
	 * recorded as the {@link lastActive} target, which — unlike the focus — is
	 * *not* cleared when focus later leaves for a non-dreb window.
	 */
	setActive(key: string | undefined): void {
		if (key === undefined) {
			this.activeKey = undefined;
			return;
		}
		if (this.sessions.has(key)) {
			this.activeKey = key;
			this.lastActiveKey = key;
		}
	}

	/**
	 * Reveal the live session under `key`, or build a fresh one via `create`.
	 *
	 * Reentrancy-safe per key: a disposed session is torn down first, and because
	 * `teardown` is awaited, a concurrent `open(key)` may install a new session
	 * during that gap — in which case we defer to it rather than orphaning it.
	 * Crucially there is **no `await` between the final decision to build and the
	 * Map assignment**, so two concurrent opens for the same key can never both
	 * construct a session.
	 *
	 * `create` is only ever invoked when a new session is actually needed, so it
	 * may perform expensive side effects (spawning the RPC child, creating the
	 * panel) without risk of an immediately-discarded construction.
	 */
	async open(key: string, create: () => S): Promise<S> {
		const existing = this.sessions.get(key);
		if (existing !== undefined && !this.ops.isDisposed(existing)) {
			this.ops.reveal(existing);
			return existing;
		}
		if (existing !== undefined) {
			// Stale session ended via `/quit` (disposed controller, panel left open
			// showing its "session ended" banner). Tear it down before rebuilding.
			await this.disposeSession(existing);
			// The await above yielded: a concurrent open(key) may have installed a
			// new live session. Defer to it instead of building a duplicate/orphan.
			const concurrent = this.sessions.get(key);
			if (concurrent !== undefined) {
				this.ops.reveal(concurrent);
				return concurrent;
			}
		}
		const s = create();
		this.sessions.set(key, s);
		return s;
	}

	/** Tear down the session stored under `key`, if any. */
	async disposeKey(key: string): Promise<void> {
		const session = this.sessions.get(key);
		if (session !== undefined) await this.disposeSession(session);
	}

	/**
	 * Tear down a specific session. Only removes the map entry (and clears the
	 * active key) if it still points at this session, so closing an older/orphaned
	 * panel never disposes a newer live session under the same key. Idempotent:
	 * safe to call from both an explicit `/quit`-driven path and the panel's
	 * `onDidDispose`.
	 */
	async disposeSession(session: S): Promise<void> {
		if (this.tornDown.has(session)) return;
		this.tornDown.add(session);
		// Find the key that still points at THIS exact session (a newer session
		// installed under the same key must survive).
		let foundKey: string | undefined;
		for (const [k, v] of this.sessions) {
			if (v === session) {
				foundKey = k;
				break;
			}
		}
		if (foundKey !== undefined && this.sessions.get(foundKey) === session) {
			this.sessions.delete(foundKey);
			if (foundKey === this.activeKey) this.activeKey = undefined;
			if (foundKey === this.lastActiveKey) this.lastActiveKey = undefined;
		}
		await this.ops.teardown(session);
	}

	/** Tear down every live session (used on extension deactivate). */
	async disposeAll(): Promise<void> {
		const snapshot = this.list();
		for (const session of snapshot) await this.disposeSession(session);
		this.activeKey = undefined;
		this.lastActiveKey = undefined;
	}
}

/**
 * Pure decision for which session key should be "active" (its sidebar row
 * highlighted) after a chat panel's focus state changes.
 *
 * VS Code fires panel view-state events as deactivate(old) + activate(new) in
 * either order, so the logic must be order-independent:
 * - the panel just became focused → it is now the active session;
 * - the panel just lost focus and *was* the recorded active one → clear (focus
 *   left for a non-dreb editor, or another chat's activate hasn't fired yet);
 * - otherwise (another chat is active) → leave the active key unchanged.
 *
 * Also used on panel dispose (a closed tab counts as "not active"): if the
 * closed tab was active the highlight clears, else it is untouched.
 */
export function nextActiveKey(
	currentActive: string | undefined,
	thisKey: string,
	isActive: boolean,
): string | undefined {
	if (isActive) return thisKey;
	if (currentActive === thisKey) return undefined;
	return currentActive;
}
