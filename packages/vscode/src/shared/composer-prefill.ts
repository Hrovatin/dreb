/** Pure merge logic for a host-driven composer pre-fill, shared by the webview
 * and its unit tests. Kept vscode-free so it can be tested in isolation.
 *
 * A pre-fill either `"replace"`s the composer (a user-message fork's re-ask
 * text — the user isn't mid-draft when they click a fork button) or
 * `"prepend"`s (queued messages restored when a streaming turn is aborted).
 * Prepend inserts the incoming text before whatever the user has already typed
 * so an in-progress draft is never silently overwritten — the abort-restore
 * clobber flagged in review. When the current draft is empty (the common Stop
 * case), both modes collapse to just the incoming text. */
export type ComposerPrefillMode = "replace" | "prepend";

export function mergeComposerPrefill(mode: ComposerPrefillMode, incoming: string, current: string): string {
	if (mode === "prepend" && current.trim().length > 0) return `${incoming}\n\n${current}`;
	return incoming;
}
