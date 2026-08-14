/// <reference types="vscode" />

/**
 * Extension entry point.
 *
 * State lives in the host: each {@link SessionController} owns the authoritative
 * transcript and its own RPC child. A {@link SessionPool} holds several of them
 * at once — one webview panel per session key — so multiple sessions run
 * concurrently and keep running when the user switches tabs. The `dreb.sessions`
 * sidebar ({@link SessionsViewProvider}) lists them (current cwd first, other
 * cwds explorable) with live status, and drives open / resume / rename / pin /
 * archive / delete.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { relative, sep } from "node:path";
import * as vscode from "vscode";
import type { LiveSessionInput } from "../shared/session-list.js";
import { resolveCliPath } from "./cli-path.js";
import type { ReviewUi } from "./review-ui.js";
import { SessionController } from "./session-controller.js";
import { SessionFlagsStore } from "./session-flags.js";
import { createSessionInventory, deletePersistedSession, type SessionInventory } from "./session-inventory.js";
import { SessionPool } from "./session-registry.js";
import { SessionsViewProvider } from "./sessions-view.js";
import { tagSelectionToChat } from "./tag-selection.js";
import { createVscodeHostUi } from "./vscode-host-ui.js";
import { createVscodeReviewUi } from "./vscode-review-ui.js";
import { createVscodeSourceLinkUi } from "./vscode-source-link-ui.js";
import { connectWebview, getWebviewHtml } from "./webview-bridge.js";

interface ChatSession {
	/** Pool key: the session `.jsonl` path when resuming, else `new:<uuid>`. */
	key: string;
	panel: vscode.WebviewPanel;
	controller: SessionController;
	connection: vscode.Disposable;
	reviewUi: ReviewUi & vscode.Disposable;
}

/** Multi-session pool: one live chat panel per session key; several coexist and
 * keep running across tab/focus changes. The reentrancy-safe lifecycle core is
 * the vscode-free, unit-tested `session-registry.ts`; the vscode ops are here. */
const pool = new SessionPool<ChatSession>({
	isDisposed: (s) => s.controller.isDisposed(),
	reveal: (s) => s.panel.reveal(vscode.ViewColumn.Active),
	teardown: async (s) => {
		s.connection.dispose();
		await s.controller.dispose();
		s.reviewUi.dispose();
		s.panel.dispose();
	},
});

let sessionsView: SessionsViewProvider | undefined;
let inventory: SessionInventory;
let flags: SessionFlagsStore;

/** Debounce sidebar refreshes driven by high-frequency controller updates so a
 * streaming turn doesn't trigger a disk scan per event. */
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSidebarRefresh(): void {
	if (refreshTimer) return;
	refreshTimer = setTimeout(() => {
		refreshTimer = undefined;
		sessionsView?.refresh();
	}, 150);
}

export function activate(context: vscode.ExtensionContext): void {
	inventory = createSessionInventory();
	flags = new SessionFlagsStore(context.globalState);
	sessionsView = new SessionsViewProvider(context.extensionUri, {
		inventory,
		flags,
		currentCwd: workspaceCwd,
		liveSessions: () =>
			pool.list().map(
				(s): LiveSessionInput => ({
					key: s.key,
					cwd: s.controller.cwd,
					path: s.controller.sessionPath,
					state: s.controller.runState,
				}),
			),
		pathForKey: (key) => pool.get(key)?.controller.sessionPath ?? (key.startsWith("new:") ? undefined : key),
		openSession: (key) => void openSession(context, key),
		newSession: () => void openNewSession(context),
		renameSession: (key, name) => renameSession(key, name),
		deleteSession: (key) => deleteSession(key),
	});

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(SessionsViewProvider.viewId, sessionsView),
		vscode.commands.registerCommand("dreb.openChat", () => void openActiveOrNew(context)),
		vscode.commands.registerCommand("dreb.sessions.newSession", () => void openNewSession(context)),
		vscode.commands.registerCommand("dreb.sessions.refresh", () => sessionsView?.refresh()),
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
					const session = await openActiveOrNew(context);
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
			void pool.active?.controller.reviewAcceptAll();
		}),
		vscode.commands.registerCommand("dreb.review.revertAll", () => {
			void pool.active?.controller.reviewRevertAll();
		}),
		vscode.commands.registerCommand("dreb.review.rejectHunkAtCursor", async () => {
			const editor = vscode.window.activeTextEditor;
			const controller = pool.active?.controller;
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
	const controller = pool.active?.controller;
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
	await pool.disposeAll();
}

/** Open (or resume) a session by pool key. Reveals a live panel, or spawns a
 * controller resuming that session's `.jsonl` (disk-only rows key by path). */
async function openSession(context: vscode.ExtensionContext, key: string): Promise<ChatSession | undefined> {
	try {
		const sessionPath = key.startsWith("new:") ? undefined : key;
		const session = await pool.open(key, () => createSession(context, key, sessionPath));
		pool.setActive(key);
		scheduleSidebarRefresh();
		return session;
	} catch (err) {
		vscode.window.showErrorMessage(`dreb: failed to open session — ${errorText(err)}`);
		return undefined;
	}
}

/** Start a brand-new session in the current workspace. */
async function openNewSession(context: vscode.ExtensionContext): Promise<ChatSession | undefined> {
	return openSession(context, `new:${randomUUID()}`);
}

/** Reveal the focused session, or start a new one — used by the chat command and
 * the "Add Selection to Chat" flow (which need *some* live target). */
async function openActiveOrNew(context: vscode.ExtensionContext): Promise<ChatSession | undefined> {
	const active = pool.active;
	if (active && !active.controller.isDisposed()) {
		active.panel.reveal(vscode.ViewColumn.Active);
		return active;
	}
	return openNewSession(context);
}

/** Build a fresh chat session: controller, webview panel, transport wiring. Only
 * invoked by the pool when a session for `key` is actually needed. */
function createSession(context: vscode.ExtensionContext, key: string, sessionPath?: string): ChatSession {
	const config = vscode.workspace.getConfiguration("dreb");
	const cwd = workspaceCwd();
	const cli = resolveCliPath({ configuredPath: config.get<string>("cliPath") });

	const reviewUi = createVscodeReviewUi(cwd);
	const controller = new SessionController({
		cwd,
		cliPath: cli.ok ? cli.path : "",
		args: buildArgs(config),
		sessionPath,
		ui: createVscodeHostUi(),
		review: reviewUi,
		sourceLink: createVscodeSourceLinkUi(cwd),
		logger: (line) => console.warn(`[dreb] ${line}`),
	});

	const panel = vscode.window.createWebviewPanel("dreb.chat", "dreb", vscode.ViewColumn.Active, {
		enableScripts: true,
		retainContextWhenHidden: true,
		localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")],
	});

	const connection = connectWebview(panel.webview, controller);
	panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri, makeNonce());

	const session: ChatSession = { key, panel, controller, connection, reviewUi };
	panel.onDidDispose(() => {
		void pool.disposeSession(session).then(() => scheduleSidebarRefresh());
	});
	panel.onDidChangeViewState((e) => {
		if (e.webviewPanel.active) pool.setActive(key);
	});
	// Live status (running / needs-input / idle) changes as the controller streams;
	// keep the sidebar in sync (debounced so a turn doesn't scan disk per event).
	controller.onUpdate(() => scheduleSidebarRefresh());

	if (!cli.ok) {
		// Surface an actionable error into the transcript; the webview shows it
		// once it hydrates. No child is spawned.
		controller.reportFatal(cli.error);
	} else {
		// start() surfaces its own host_error + status into the transcript on
		// failure, so a rejection here is already reflected in the UI.
		void controller.start().catch(() => {});
	}

	scheduleSidebarRefresh();
	return session;
}

/** Rename a session. A live controller renames directly; a disk-only session is
 * renamed by briefly spawning a headless resume child (no panel) — the flagged
 * "rename anytime" behavior. */
async function renameSession(key: string, name: string): Promise<void> {
	const trimmed = name.trim();
	if (!trimmed) return;
	const live = pool.get(key);
	if (live) {
		try {
			await live.controller.rename(trimmed);
		} catch (err) {
			vscode.window.showErrorMessage(`dreb: rename failed — ${errorText(err)}`);
		}
		return;
	}

	const path = key;
	const all = await inventory.listAll();
	const cwd = all.find((s) => s.path === path)?.cwd ?? workspaceCwd();
	const config = vscode.workspace.getConfiguration("dreb");
	const cli = resolveCliPath({ configuredPath: config.get<string>("cliPath") });
	if (!cli.ok) {
		vscode.window.showErrorMessage(`dreb: cannot rename — ${cli.error}`);
		return;
	}
	const controller = new SessionController({
		cwd,
		cliPath: cli.path,
		args: buildArgs(config),
		sessionPath: path,
		logger: (line) => console.warn(`[dreb] ${line}`),
	});
	try {
		await controller.start();
		await controller.rename(trimmed);
	} catch (err) {
		vscode.window.showErrorMessage(`dreb: rename failed — ${errorText(err)}`);
	} finally {
		await controller.dispose();
	}
}

/** Delete a session (behind a modal confirmation): tear down any live controller,
 * then delete its transcript through dreb's session manager — trash-first with an
 * unlink fallback, `.jsonl` validation, and an active-session guard — and drop its
 * persisted flags only once the delete actually succeeded. */
async function deleteSession(key: string): Promise<void> {
	const live = pool.get(key);
	const path = live?.controller.sessionPath ?? (key.startsWith("new:") ? undefined : key);
	const choice = await vscode.window.showWarningMessage(
		"Delete this dreb session? Its transcript is moved to the trash (or permanently removed if trash is unavailable).",
		{ modal: true },
		"Delete",
	);
	if (choice !== "Delete") return;
	if (live) await pool.disposeSession(live);
	if (path) {
		// Delete the transcript and drop its flags only on success. `activeSessionPath`
		// is read *after* disposing the target above, so the guard only fires for a
		// genuinely different session that is still active.
		await deletePersistedSession(inventory, flags, path, pool.active?.controller.sessionPath, (message) =>
			vscode.window.showErrorMessage(message),
		);
	}
	scheduleSidebarRefresh();
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
