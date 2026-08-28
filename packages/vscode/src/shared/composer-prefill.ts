/** Pure merge logic for a host-driven composer pre-fill, shared by the webview
 * and its unit tests. Kept vscode-free so it can be tested in isolation.
 *
 * A pre-fill either `"replace"`s the composer (a user-message fork's re-ask
 * text — the user isn't mid-draft when they click a fork button), `"prepend"`s
 * (queued messages restored when a streaming turn is aborted), or
 * `"fill-if-empty"`s (accepting a `suggest_next` next-step command — fill only
 * when nothing is typed, so an in-progress draft is never touched).
 * Prepend inserts the incoming text before whatever the user has already typed
 * so an in-progress draft is never silently overwritten — the abort-restore
 * clobber flagged in review. `fill-if-empty` leaves a non-empty draft entirely
 * alone (returns it unchanged). When the current draft is empty (the common
 * Stop / no-draft case), all modes collapse to just the incoming text. */
export type ComposerPrefillMode = "replace" | "prepend" | "fill-if-empty";

export function mergeComposerPrefill(mode: ComposerPrefillMode, incoming: string, current: string): string {
	if (mode === "prepend" && current.trim().length > 0) return `${incoming}\n\n${current}`;
	if (mode === "fill-if-empty" && current.trim().length > 0) return current;
	return incoming;
}
