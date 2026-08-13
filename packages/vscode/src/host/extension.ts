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
import { relative, sep } from "node:path";
import * as vscode from "vscode";
import { resolveCliPath } from "./cli-path.js";
import type { ReviewUi } from "./review-ui.js";
import { SessionController } from "./session-controller.js";
import { SessionRegistry } from "./session-registry.js";
import { tagSelectionToChat } from "./tag-selection.js";
import { createVscodeHostUi } from "./vscode-host-ui.js";
import { createVscodeReviewUi } from "./vscode-review-ui.js";
import { connectWebview, getWebviewHtml } from "./webview-bridge.js";

interface ChatSession {
	panel: vscode.WebviewPanel;
	controller: SessionController;
	connection: vscode.Disposable;
	reviewUi: ReviewUi & vscode.Disposable;
}

/** Enforces the single-live-panel invariant and the reentrancy-safe open /
 * teardown lifecycle. The vscode-specific operations are injected; the racing
 * logic itself lives in the vscode-free, unit-tested `session-registry.ts`. */
const registry = new SessionRegistry<ChatSession>({
	isDisposed: (s) => s.controller.isDisposed(),
	reveal: (s) => s.panel.reveal(vscode.ViewColumn.Active),
	teardown: async (s) => {
		s.connection.dispose();
		await s.controller.dispose();
		s.reviewUi.dispose();
		s.panel.dispose();
	},
});

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand("dreb.openChat", () => {
			void openChatOrNotify(context);
		}),
		vscode.commands.registerCommand("dreb.tagSelectionToChat", () =>
			tagSelectionToChat({
				captureSelection: () => {
					const editor = vscode.window.activeTextEditor;
					if (!editor || editor.selection.isEmpty) return undefined;
					const { selection, document } = editor;
					return {
						fsPath: document.uri.fsPath,
						startLine: selection.start.line + 1,
						endLine: selection.end.line + 1,
						language: document.languageId,
						text: document.getText(selection),
					};
				},
				openTarget: async () => {
					const session = await openChatOrNotify(context);
					if (!session) return undefined;
					return {
						cwd: session.controller.cwd,
						tagContext: (ctx) => session.controller.tagContext(ctx),
						reveal: () => session.panel.reveal(vscode.ViewColumn.Active),
					};
				},
				onNoSelection: () => vscode.window.showInformationMessage("dreb: select some code to add to the chat."),
			}),
		),
		vscode.commands.registerCommand("dreb.review.openDiff", (arg?: unknown) => {
			const resolved = resolveReviewTarget(arg);
			if (resolved) void resolved.controller.reviewOpenDiff(resolved.path);
		}),
		vscode.commands.registerCommand("dreb.review.acceptFile", (arg?: unknown) => {
			const resolved = resolveReviewTarget(arg);
			if (resolved) void resolved.controller.reviewAcceptFile(resolved.path);
		}),
		vscode.commands.registerCommand("dreb.review.revertFile", (arg?: unknown) => {
			const resolved = resolveReviewTarget(arg);
			if (resolved) void resolved.controller.reviewRevertFile(resolved.path);
		}),
		vscode.commands.registerCommand("dreb.review.acceptAll", () => {
			void registry.active?.controller.reviewAcceptAll();
		}),
		vscode.commands.registerCommand("dreb.review.revertAll", () => {
			void registry.active?.controller.reviewRevertAll();
		}),
		vscode.commands.registerCommand("dreb.review.rejectHunkAtCursor", async () => {
			const editor = vscode.window.activeTextEditor;
			const controller = registry.active?.controller;
			if (!editor || !controller) return;
			const path = toRepoRelative(controller.gitRoot, editor.document.uri);
			if (path === undefined) {
				vscode.window.showInformationMessage("dreb: the active file is not under change review.");
				return;
			}
			const line = editor.selection.active.line + 1;
			const ok = await controller.reviewRejectHunkAtLine(path, line);
			if (!ok) vscode.window.showInformationMessage("dreb: no reviewable hunk at the cursor.");
		}),
	);
}

/** Resolve a review command argument (a repo-relative path string from the
 * webview / SCM `command`, or a `SourceControlResourceState` from an SCM menu)
 * to the active controller + repo-relative path. */
function resolveReviewTarget(arg: unknown): { controller: SessionController; path: string } | undefined {
	const controller = registry.active?.controller;
	if (!controller) return undefined;
	if (typeof arg === "string") return { controller, path: arg };
	const uri = (arg as { resourceUri?: vscode.Uri })?.resourceUri;
	if (!uri) return undefined;
	const path = toRepoRelative(controller.gitRoot, uri);
	return path === undefined ? undefined : { controller, path };
}

/** A file URI's path relative to `cwd` (forward slashes), or undefined if it is
 * not under `cwd`. */
function toRepoRelative(cwd: string, uri: vscode.Uri): string | undefined {
	if (uri.scheme !== "file") return undefined;
	const rel = relative(cwd, uri.fsPath);
	if (rel.length === 0 || rel.startsWith("..")) return undefined;
	return rel.split(sep).join("/");
}

export async function deactivate(): Promise<void> {
	await registry.disposeActive();
}

/** Open (or reveal) the chat panel, surfacing any failure as an error message.
 * Returns the live session, or undefined when opening failed. Shared by the
 * `dreb.openChat` and `dreb.tagSelectionToChat` commands. */
async function openChatOrNotify(context: vscode.ExtensionContext): Promise<ChatSession | undefined> {
	try {
		await registry.open(() => createSession(context));
		return registry.active;
	} catch (err) {
		vscode.window.showErrorMessage(`dreb: failed to open chat — ${errorText(err)}`);
		return undefined;
	}
}

/** Build a fresh chat session: controller, webview panel, and transport wiring.
 * Called by the registry only when a new session is actually needed. The panel's
 * `onDidDispose` tears down *this* session specifically (never a newer live one)
 * via the registry's scoped, idempotent `disposeSession`. */
function createSession(context: vscode.ExtensionContext): ChatSession {
	const config = vscode.workspace.getConfiguration("dreb");
	const cwd = workspaceCwd();
	const cli = resolveCliPath({ configuredPath: config.get<string>("cliPath") });

	const reviewUi = createVscodeReviewUi(cwd);
	const controller = new SessionController({
		cwd,
		cliPath: cli.ok ? cli.path : "",
		args: buildArgs(config),
		ui: createVscodeHostUi(),
		review: reviewUi,
		logger: (line) => console.warn(`[dreb] ${line}`),
	});

	const panel = vscode.window.createWebviewPanel("dreb.chat", "dreb", vscode.ViewColumn.Active, {
		enableScripts: true,
		retainContextWhenHidden: true,
		localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")],
	});

	const connection = connectWebview(panel.webview, controller);
	panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri, makeNonce());

	const session: ChatSession = { panel, controller, connection, reviewUi };
	panel.onDidDispose(() => {
		void registry.disposeSession(session);
	});

	if (!cli.ok) {
		// Surface an actionable error into the transcript; the webview shows it
		// once it hydrates. No child is spawned.
		controller.reportFatal(cli.error);
	} else {
		// start() surfaces its own host_error + status into the transcript on
		// failure, so a rejection here is already reflected in the UI.
		void controller.start().catch(() => {});
	}

	return session;
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
