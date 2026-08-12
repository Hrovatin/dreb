/// <reference types="vscode" />

/**
 * Extension entry point. Registers the `dreb.openChat` command, which opens (or
 * reveals) a single chat webview panel backed by one SessionController.
 *
 * State lives in the host: the controller owns the authoritative transcript and
 * the RPC child, so tearing down and recreating the webview re-renders from the
 * controller's snapshot without losing the conversation.
 */

import { homedir } from "node:os";
import * as vscode from "vscode";
import { resolveCliPath } from "./cli-path.js";
import { SessionController } from "./session-controller.js";
import { createVscodeHostUi } from "./vscode-host-ui.js";
import { connectWebview, getWebviewHtml } from "./webview-bridge.js";

interface ChatSession {
	panel: vscode.WebviewPanel;
	controller: SessionController;
	connection: vscode.Disposable;
}

let current: ChatSession | undefined;

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand("dreb.openChat", () => {
			openChat(context).catch((err) => {
				vscode.window.showErrorMessage(`dreb: failed to open chat — ${errorText(err)}`);
			});
		}),
	);
}

export async function deactivate(): Promise<void> {
	await disposeCurrent();
}

async function openChat(context: vscode.ExtensionContext): Promise<void> {
	if (current) {
		current.panel.reveal(vscode.ViewColumn.Active);
		return;
	}

	const config = vscode.workspace.getConfiguration("dreb");
	const cwd = workspaceCwd();
	const cli = resolveCliPath({ configuredPath: config.get<string>("cliPath") });

	const controller = new SessionController({
		cwd,
		cliPath: cli.ok ? cli.path : "",
		args: buildArgs(config),
		ui: createVscodeHostUi(),
		logger: (line) => console.warn(`[dreb] ${line}`),
	});

	const panel = vscode.window.createWebviewPanel("dreb.chat", "dreb", vscode.ViewColumn.Active, {
		enableScripts: true,
		retainContextWhenHidden: true,
		localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")],
	});

	const connection = connectWebview(panel.webview, controller);
	panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri, makeNonce());

	current = { panel, controller, connection };
	panel.onDidDispose(() => {
		void disposeCurrent();
	});

	if (!cli.ok) {
		// Surface an actionable error into the transcript; the webview shows it
		// once it hydrates. No child is spawned.
		controller.reportFatal(cli.error);
		return;
	}

	try {
		await controller.start();
	} catch {
		// start() already surfaced a host_error + status to the transcript.
	}
}

async function disposeCurrent(): Promise<void> {
	if (!current) return;
	const session = current;
	current = undefined;
	session.connection.dispose();
	await session.controller.dispose();
	session.panel.dispose();
}

function workspaceCwd(): string {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();
}

function buildArgs(config: vscode.WorkspaceConfiguration): string[] {
	const args: string[] = [];
	const provider = config.get<string>("provider")?.trim();
	const model = config.get<string>("model")?.trim();
	if (provider) args.push("--provider", provider);
	if (model) args.push("--model", model);
	return args;
}

function makeNonce(): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let nonce = "";
	for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	return nonce;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
