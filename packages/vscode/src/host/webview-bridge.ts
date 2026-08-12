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
import type { HostToWebview, WebviewToHost } from "../shared/protocol.js";
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
	const post = (message: HostToWebview): void => {
		void webview.postMessage(message);
	};

	const unsubscribe = controller.onUpdate((update) => {
		if (!live) return;
		if (update.kind === "event") post({ type: "event", event: update.event });
		else post({ type: "status", status: update.status });
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
				void controller
					.refreshCommands()
					.then(() => post({ type: "commands", commands: controller.getCommandList() }));
				return;
			}
			case "submit":
				void controller.submit(raw.text);
				return;
			case "abort":
				void controller.abort();
				return;
			case "refresh-commands":
				void controller
					.refreshCommands()
					.then(() => post({ type: "commands", commands: controller.getCommandList() }));
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
