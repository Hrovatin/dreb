/// <reference types="vscode" />

/**
 * `dreb.sessions` webview view — the vscode glue around {@link SessionsViewModel}.
 *
 * This is the transport seam for the sessions sidebar (mirroring `webview-bridge.ts`
 * for the chat panel): host→webview uses `view.webview.postMessage`, webview→host
 * uses `onDidReceiveMessage`. All list-building and action routing live in the
 * vscode-free {@link SessionsViewModel}; this class only owns the webview lifecycle
 * and HTML shell.
 */

import * as vscode from "vscode";
import type { HostToSidebar, SidebarToHost } from "../shared/sidebar-protocol.js";
import { type SessionsViewDeps, SessionsViewModel } from "./sessions-view-model.js";

/** Build the sidebar webview HTML shell referencing its vite-built assets. */
export function getSidebarHtml(webview: vscode.Webview, extensionUri: vscode.Uri, nonce: string): string {
	const assetUri = (file: string) =>
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview-sidebar", file));
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
		<title>dreb sessions</title>
	</head>
	<body>
		<div id="root"></div>
		<script type="module" nonce="${nonce}" src="${scriptUri}"></script>
	</body>
</html>`;
}

function makeNonce(): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let nonce = "";
	for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	return nonce;
}

export class SessionsViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewId = "dreb.sessions";
	private view: vscode.WebviewView | undefined;
	private readonly model: SessionsViewModel;

	constructor(
		private readonly resolveExtensionUri: () => vscode.Uri,
		deps: Omit<SessionsViewDeps, "post">,
	) {
		this.model = new SessionsViewModel({ ...deps, post: (msg) => this.post(msg) });
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		// Re-resolve the extension root here (not once at construction) so the
		// sidebar self-heals like the chat panel: if the realpath resolution failed
		// at activation, a later view (re)resolve picks up the recovered real path
		// instead of pinning the symlink fallback (which would 404 the sidebar
		// assets until a full window reload).
		const extensionUri = this.resolveExtensionUri();
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist", "webview-sidebar")],
		};
		view.webview.html = getSidebarHtml(view.webview, extensionUri, makeNonce());
		view.webview.onDidReceiveMessage((msg: SidebarToHost) => void this.model.handle(msg));
		view.onDidDispose(() => {
			if (this.view === view) this.view = undefined;
		});
	}

	/** Rebuild + repost the session list (called by the host when the pool or a
	 * live session's status changes). No-op when the view isn't resolved. */
	refresh(): void {
		void this.model.refresh();
	}

	private post(msg: HostToSidebar): void {
		void this.view?.webview.postMessage(msg);
	}
}
