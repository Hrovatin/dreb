/**
 * ReviewUi — the vscode-free port through which the (node-only, testable)
 * SessionController drives the native change-review surface: the quick-diff
 * baseline provider, the SCM "pending review" group, and the diff viewer. The
 * real implementation lives in `vscode-review-ui.ts` (which imports `vscode`);
 * tests and headless use inject the no-op below.
 *
 * The controller owns *what* is under review (baseline content + the pending
 * file list) and pushes it here; this port owns only *how* it is shown.
 */

import type { ReviewFileDto } from "../shared/protocol.js";

export interface ReviewUi {
	/** Register/replace the baseline content for a path (left side of the diff /
	 * quick-diff gutter). `content === null` means the path is new in this cycle
	 * (baseline is empty). */
	setBaseline(path: string, content: string | null): void;
	/** Replace the pending-review file list shown in the SCM group. */
	setPending(files: ReviewFileDto[]): void;
	/** Open the baseline↔current diff for a path in the editor. */
	openDiff(path: string): Promise<void>;
	/** Clear all review UI (baselines + SCM group), e.g. on accept-all / dispose. */
	clear(): void;
}

/** No-op ReviewUi: every call is inert. Default when no UI is injected (tests,
 * headless), so review logic runs without a vscode surface. */
export const noopReviewUi: ReviewUi = {
	setBaseline() {},
	setPending() {},
	async openDiff() {},
	clear() {},
};
