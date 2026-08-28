/**
 * ReviewModel — the pure, vscode-free state machine for a change-review cycle.
 *
 * A *cycle* begins when the agent first edits files while the review set is
 * empty: the host captures a baseline snapshot (a git tree ref) and hands it
 * here. Changes then *compound* across turns until the user accepts or reverts.
 * This module owns only the review bookkeeping — the baseline ref and which
 * files the user has explicitly accepted — and derives the "pending review"
 * list from the git-computed changed files. All git I/O (capture, diff, revert)
 * lives in `git-snapshot.ts`; all editor UI lives behind the `ReviewUi` port.
 *
 * Unit-tested in `test/review-model.test.ts` with no git or vscode.
 */

import type { ReviewFileDto } from "../shared/protocol.js";

/** A file that differs from the baseline, as computed by `git-snapshot`. */
export interface ChangedFile {
	path: string;
	status: ReviewFileDto["status"];
	hunkCount: number;
}

export class ReviewModel {
	/** The baseline git tree ref for the active cycle, or undefined when idle. */
	private baseline: string | undefined;
	/** Files the user accepted this cycle — excluded from the pending list until
	 * the cycle resets (documented limitation: a later edit to an accepted file
	 * re-surfaces only after the next accept-all / empty-set reset). */
	private readonly accepted = new Set<string>();

	/** Whether a review cycle is currently active (a baseline is held). */
	hasCycle(): boolean {
		return this.baseline !== undefined;
	}

	/** The active baseline ref, or undefined when idle. */
	baselineRef(): string | undefined {
		return this.baseline;
	}

	/** Start a cycle with the given baseline ref. No-op if one is already active
	 * (changes compound against the original baseline). */
	beginCycle(ref: string): void {
		if (this.baseline === undefined) this.baseline = ref;
	}

	/** Derive the pending-review list: changed files minus explicitly accepted
	 * ones, in stable path order. Empty when no cycle is active. */
	pending(changed: readonly ChangedFile[]): ReviewFileDto[] {
		if (this.baseline === undefined) return [];
		return changed
			.filter((c) => !this.accepted.has(c.path))
			.map((c) => ({ path: c.path, status: c.status, hunkCount: c.hunkCount }))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	/** Mark a file accepted (stops showing it in review, no commit). */
	accept(path: string): void {
		this.accepted.add(path);
	}

	/** Undo a prior per-file accept (used when the user reverts that file). */
	unaccept(path: string): void {
		this.accepted.delete(path);
	}

	/** End the cycle entirely: drop the baseline and all accept markers. The next
	 * agent edit starts a fresh cycle with a new baseline. */
	reset(): void {
		this.baseline = undefined;
		this.accepted.clear();
	}
}
