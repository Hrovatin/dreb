/**
 * Orchestration for the `dreb.tagSelectionToChat` command (Phase 4), factored
 * out of `extension.ts` so it can be unit tested without the `vscode` module.
 *
 * The vscode-specific bits (reading the active editor, opening the panel,
 * showing notices) are injected via {@link TagSelectionDeps}; the branching this
 * function owns — empty-selection guard, capture-before-`await` ordering,
 * open-if-none, cwd threading, tag, reveal — is the tested logic.
 */

import type { TaggedContextDto } from "../shared/protocol.js";
import { buildTaggedContext } from "../shared/tagged-context.js";

/** A selection captured synchronously from the active editor (1-based lines). */
export interface SelectionSnapshot {
	fsPath: string;
	startLine: number;
	endLine: number;
	language: string;
	text: string;
}

/** The chat session a tagged selection is delivered into. */
export interface TagTarget {
	/** Working directory used to relativize the selection's path. */
	cwd: string;
	/** Deliver the context to the composer (as a removable chip). */
	tagContext: (context: TaggedContextDto) => void;
	/** Bring the chat panel to the foreground. */
	reveal: () => void;
}

export interface TagSelectionDeps {
	/** Snapshot the active selection synchronously, or return undefined when
	 * there is no editor or the selection is empty. Called before any `await` so
	 * opening/revealing the panel can't shift focus out from under the capture. */
	captureSelection: () => SelectionSnapshot | undefined;
	/** Open (or reveal) the chat and return the live target, or undefined when
	 * opening failed (the dep is responsible for surfacing that error). */
	openTarget: () => Promise<TagTarget | undefined>;
	/** Surface "nothing selected" to the user. */
	onNoSelection: () => void;
}

/** Capture the active selection, ensure a chat exists, and deliver the selection
 * as a located context chip. No-ops (with a notice) when nothing is selected,
 * and aborts quietly if the chat could not be opened. */
export async function tagSelectionToChat(deps: TagSelectionDeps): Promise<void> {
	// Capture BEFORE awaiting openTarget — revealing the panel may move focus.
	const snapshot = deps.captureSelection();
	if (!snapshot) {
		deps.onNoSelection();
		return;
	}
	const target = await deps.openTarget();
	if (!target) return;
	target.tagContext(buildTaggedContext({ ...snapshot, cwd: target.cwd }));
	target.reveal();
}
