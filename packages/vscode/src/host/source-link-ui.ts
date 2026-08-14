/**
 * SourceLinkUi — the vscode-free port through which the (node-only, testable)
 * SessionController opens a clicked code reference in the editor. The real
 * implementation lives in `vscode-source-link-ui.ts`; tests and headless use
 * inject the no-op below.
 */

import type { OpenSourceRef } from "../shared/protocol.js";

export interface SourceLinkUi {
	/** Open a code reference clicked in an answer: reveal a file location and/or
	 * navigate to a symbol's definition (best-effort). */
	openSource(ref: OpenSourceRef): Promise<void>;
}

/** No-op SourceLinkUi: every call is inert. Default when no UI is injected. */
export const noopSourceLinkUi: SourceLinkUi = {
	async openSource() {},
};
