/// <reference types="vscode" />

/**
 * Webview bridge — adapts a SessionController to a VS Code webview. This is the
 * transport seam that replaces the dashboard's HTTP+SSE layer: host→webview
 * uses `webview.postMessage`, webview→host uses `onDidReceiveMessage`.
 *
 * Ordering contract: raw events are NOT streamed to the webview until it has
 * announced `ready` and received the authoritative snapshot. The snapshot is
 * sent and the "live" flag flipped synchronously (no `await` between), so no
 * event is ever both baked into the snapshot and re-streamed (which would
 * duplicate transcript entries).
 */

import * as vscode from "vscode";
import type { HostToWebview, TaggedContextDto, WebviewToHost } from "../shared/protocol.js";
import type { SessionController } from "./session-controller.js";

/** Build the webview HTML shell referencing the vite-built assets. */
export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, nonce: string): string {
	const assetUri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", file));
	const scriptUri = assetUri("main.js");
	const styleUri = assetUri("main.css");
	const csp = [
		"default-src 'none'",
		`img-src ${webview.cspSource} https: data:`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`font-src ${webview.cspSource}`,
		`script-src 'nonce-${nonce}'`,
	].join("; ");

	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta http-equiv="Content-Security-Policy" content="${csp}" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<link rel="stylesheet" href="${styleUri}" />
		<title>dreb</title>
	</head>
	<body>
		<div id="root"></div>
		<script type="module" nonce="${nonce}" src="${scriptUri}"></script>
	</body>
</html>`;
}

/** Wire a controller to a webview. Returns a disposable that tears down both. */
export function connectWebview(webview: vscode.Webview, controller: SessionController): vscode.Disposable {
	let live = false;
	// Selections tagged before the webview announced `ready` (e.g. tagging into a
	// freshly opened chat) — buffered here and flushed once live so they aren't
	// dropped by the pre-ready gate.
	const pendingTags: TaggedContextDto[] = [];
	const post = (message: HostToWebview): void => {
		void webview.postMessage(message);
	};
	const pushCommands = (): void => {
		void controller.refreshCommands().then(() => post({ type: "commands", commands: controller.getCommandList() }));
	};

	const unsubscribe = controller.onUpdate((update) => {
		// Tagged selections are buffered before `ready` (unlike streamed events,
		// which the snapshot already captures), so handle them ahead of the
		// pre-ready gate below.
		if (update.kind === "tag-context") {
			if (live) post({ type: "tag-context", context: update.context });
			else pendingTags.push(update.context);
			return;
		}
		if (!live) return;
		switch (update.kind) {
			case "event":
				post({ type: "event", event: update.event });
				break;
			case "status":
				post({ type: "status", status: update.status });
				break;
			case "commands":
				post({ type: "commands", commands: update.commands });
				break;
			case "review":
				post({ type: "review", review: update.review });
				break;
			case "resync":
				// Transcript was replaced host-side (/new, /import) — re-snapshot.
				post({
					type: "snapshot",
					state: structuredClone(controller.getTranscript()),
					commands: controller.getCommandList(),
					status: controller.getStatus(),
				});
				post({ type: "review", review: controller.getReviewState() });
				break;
		}
	});

	const messageSub = webview.onDidReceiveMessage((raw: WebviewToHost) => {
		switch (raw?.type) {
			case "ready": {
				// Snapshot + go-live must be atomic (no await between) so streamed
				// events and the snapshot never overlap. `structuredClone` detaches
				// the snapshot from the live, still-mutating transcript object.
				post({
					type: "snapshot",
					state: structuredClone(controller.getTranscript()),
					commands: controller.getCommandList(),
					status: controller.getStatus(),
				});
				live = true;
				post({ type: "review", review: controller.getReviewState() });
				// Deliver any selections tagged before the webview was live.
				for (const context of pendingTags.splice(0)) post({ type: "tag-context", context });
				pushCommands();
				return;
			}
			case "submit":
				void controller.submit(raw.text, raw.attachments);
				return;
			case "abort":
				void controller.abort();
				return;
			case "refresh-commands":
				pushCommands();
				return;
			case "pick-model":
				void controller.pickModel();
				return;
			case "pick-thinking":
				void controller.pickThinking();
				return;
			case "pick-file":
				void controller.tagFileFromPicker();
				return;
			case "review-open-diff":
				void controller.reviewOpenDiff(raw.path);
				return;
			case "ui-response":
				controller.respondUi(raw.response);
				return;
		}
	});

	return new vscode.Disposable(() => {
		unsubscribe();
		messageSub.dispose();
	});
}
