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
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { relative, sep } from "node:path";
import * as vscode from "vscode";
import type { LiveSessionInput } from "../shared/session-list.js";
import { formatTabTitle } from "../shared/tab-title.js";
import { buildArgs } from "./build-args.js";
import { resolveCliPath } from "./cli-path.js";
import type { resolveNodePath } from "./node-path.js";
import { createNodeRuntimeCacheState, resolveNodeRuntimeCached } from "./node-runtime-cache.js";
import type { ReviewUi } from "./review-ui.js";
import { SessionController } from "./session-controller.js";
import { SessionFlagsStore } from "./session-flags.js";
import { createSessionInventory, deletePersistedSession, type SessionInventory } from "./session-inventory.js";
import { SessionOrderStore } from "./session-order.js";
import { nextActiveKey, resolveActiveOrNew, SessionPool } from "./session-registry.js";
import {
	readSleepSetting,
	revealOrReattach,
	type SleepableSession,
	SleepController,
} from "./session-view-lifecycle.js";
import { SessionsViewProvider } from "./sessions-view.js";
import { type TagSelectionDeps, tagSelectionToChat } from "./tag-selection.js";
import { createVscodeHostUi } from "./vscode-host-ui.js";
import { createVscodeReviewUi } from "./vscode-review-ui.js";
import { createVscodeSourceLinkUi } from "./vscode-source-link-ui.js";
import { connectWebview, getWebviewHtml } from "./webview-bridge.js";

interface ChatSession {
	/** Pool key: the session `.jsonl` path when resuming, else `new:<uuid>`. */
	key: string;
	/** The chat panel + webview bridge, or `undefined` while backgrounded (the
	 * tab was closed but the controller keeps running / is idle-and-sleeping). */
	panel: vscode.WebviewPanel | undefined;
	controller: SessionController;
	/** The webview bridge for {@link panel}; `undefined` while backgrounded. */
	connection: vscode.Disposable | undefined;
	reviewUi: ReviewUi & vscode.Disposable;
	/** Sleep-on-idle driver: backgrounds a closed session and releases its RPC
	 * child once it goes idle. */
	sleep: SleepController;
	/** Set while an explicit teardown (stop / delete / deactivate / sleep) is
	 * disposing the panel, so the panel's own `onDidDispose` doesn't re-background
	 * a session that is already being torn down. */
	disposing: boolean;
}

/** Multi-session pool: one live chat panel per session key; several coexist and
 * keep running across tab/focus changes. The reentrancy-safe lifecycle core is
 * the vscode-free, unit-tested `session-registry.ts`; the vscode ops are here.
 *
 * `isDisposed` reflects the *controller*, not the view: a backgrounded session
 * (panel closed, controller still alive) is NOT disposed, so `reveal` reattaches
 * a fresh panel to the surviving controller instead of rebuilding it. A *failed*
 * controller (child exited / start failed) is treated as not-reusable so
 * reopening rebuilds a fresh child resuming from the persisted transcript
 * instead of revealing a dead panel (Phase 9, Item 1). */
const pool = new SessionPool<ChatSession>({
	isDisposed: (s) => s.controller.isDisposed() || s.controller.hasFailed(),
	reveal: (s) => revealSession(s),
	teardown: async (s) => {
		s.disposing = true;
		s.sleep.dispose(); // cancel the idle / inactivity-cap timers so they don't retain the session graph
		s.connection?.dispose();
		await s.controller.dispose();
		s.reviewUi.dispose();
		s.panel?.dispose();
	},
});

let sessionsView: SessionsViewProvider | undefined;
let inventory: SessionInventory;
let flags: SessionFlagsStore;
let order: SessionOrderStore;
/** The activation context, kept so `reveal` can rebuild a panel for a
 * backgrounded session that outlived its original panel. */
let extensionContext: vscode.ExtensionContext | undefined;

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
	extensionContext = context;
	inventory = createSessionInventory();
	flags = new SessionFlagsStore(context.globalState);
	order = new SessionOrderStore(context.globalState);
	sessionsView = new SessionsViewProvider(context.extensionUri, {
		inventory,
		flags,
		order,
		currentCwd: workspaceCwd,
		liveSessions: () =>
			pool.list().map(
				(s): LiveSessionInput => ({
					key: s.key,
					cwd: s.controller.cwd,
					path: s.controller.sessionPath,
					// Source the sidebar row's title from the same `controller.title` the
					// chat tab uses, so a session's tab (`D: <shortened>`) is always a
					// shortened form of the exact name its sidebar row shows — they can
					// never diverge (a live rename reflects in both immediately).
					title: s.controller.title,
					state: s.controller.runState,
				}),
			),
		activeKey: () => pool.active?.key,
		pathForKey: (key) => pool.get(key)?.controller.sessionPath ?? (key.startsWith("new:") ? undefined : key),
		openSession: (key) => void openSession(context, key),
		newSession: () => void openNewSession(context),
		renameSession: (key, name) => renameSession(key, name),
		deleteSession: (key) => deleteSession(key),
		stopSession: (key) => stopSession(key),
	});

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(SessionsViewProvider.viewId, sessionsView),
		vscode.commands.registerCommand("dreb.openChat", () => void openActiveOrNew(context)),
		vscode.commands.registerCommand("dreb.sessions.newSession", () => void openNewSession(context)),
		vscode.commands.registerCommand("dreb.sessions.refresh", () => sessionsView?.refresh()),
		vscode.commands.registerCommand("dreb.tagSelectionToChat", () =>
			tagSelectionToChat(selectionTagDeps(() => openActiveOrNew(context))),
		),
		vscode.commands.registerCommand("dreb.tagSelectionToNewChat", () =>
			tagSelectionToChat(selectionTagDeps(() => openNewSession(context))),
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
	extensionContext = undefined;
}

/** Open (or resume) a session by pool key. Reveals a live panel, or spawns a
 * controller resuming that session's `.jsonl` (disk-only rows key by path). */
async function openSession(context: vscode.ExtensionContext, key: string): Promise<ChatSession | undefined> {
	try {
		const keyPath = key.startsWith("new:") ? undefined : key;
		// A crashed session (child gone, controller not disposed) is treated as
		// not-reusable by the pool predicate, so `pool.open` tears it down and
		// rebuilds. Resume that rebuild from the crashed controller's actual
		// persisted transcript — which may be a real `.jsonl` even under a `new:`
		// key once the child wrote its first entry — so the restart is lossless.
		const existing = pool.get(key);
		const crashedPath =
			existing?.controller.hasFailed() && !existing.controller.isDisposed()
				? existing.controller.sessionPath
				: undefined;
		const resumePath = keyPath ?? crashedPath;
		const session = await pool.open(key, () => createSession(context, key, resumePath));
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

/** Reveal the last-active session, or start a new one — used by the chat command
 * and the "Add Selection to Chat" flow (which need *some* live target). Delegates
 * to the vscode-free `resolveActiveOrNew`, which reads `pool.lastActive` (not
 * `pool.active`) so that tagging from the editor targets the chat the user was
 * last in, rather than spawning a new one just because focus moved from the chat
 * webview to the code editor. */
async function openActiveOrNew(context: vscode.ExtensionContext): Promise<ChatSession | undefined> {
	return resolveActiveOrNew(pool, {
		isDisposed: (s) => s.controller.isDisposed(),
		hasFailed: (s) => s.controller.hasFailed(),
		reveal: (s) => revealSession(s),
		openNew: () => openNewSession(context),
	});
}

/** Build the injected deps for the "add selection to chat" commands. The `open`
 * callback chooses the target session — active-or-new (`dreb.tagSelectionToChat`)
 * vs. always a fresh one (`dreb.tagSelectionToNewChat`) — while capture, target
 * shaping, and the empty-selection notice are identical for both entries. */
function selectionTagDeps(open: () => Promise<ChatSession | undefined>): TagSelectionDeps {
	return {
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
			const session = await open();
			if (!session) return undefined;
			return {
				cwd: session.controller.cwd,
				tagContext: (ctx) => session.controller.tagContext(ctx),
				reveal: () => revealSession(session),
			};
		},
		onNoSelection: () => vscode.window.showInformationMessage("dreb: select some code to add to the chat."),
	};
}

/** Build a fresh chat session: controller + native UIs, then attach a webview
 * view. Only invoked by the pool when a session for `key` is actually needed.
 *
 * The controller and its native UIs are *session-bound* — they persist across
 * view attach/detach so the agent keeps running when the tab is closed. Only the
 * panel + webview bridge are *view-bound*; {@link attachView} builds them and
 * `onDidDispose` detaches (backgrounds) them without killing the controller. */
function createSession(context: vscode.ExtensionContext, key: string, sessionPath?: string): ChatSession {
	const config = vscode.workspace.getConfiguration("dreb");
	const cwd = workspaceCwd();
	const { cli, node } = resolveRuntime(config);

	const reviewUi = createVscodeReviewUi(cwd);
	const controller = new SessionController({
		cwd,
		cliPath: cli.ok ? cli.path : "",
		nodePath: node.nodePath,
		env: node.env,
		args: buildArgs(config),
		sessionPath,
		ui: createVscodeHostUi(),
		review: reviewUi,
		sourceLink: createVscodeSourceLinkUi(cwd),
		logger: (line) => console.warn(`[dreb] ${line}`),
	});

	const session: ChatSession = {
		key,
		panel: undefined,
		controller,
		connection: undefined,
		reviewUi,
		// Assigned immediately below (it closes over `session`).
		sleep: undefined as unknown as SleepController,
		disposing: false,
	};
	const sleepable: SleepableSession = {
		runState: () => controller.runState,
		hasView: () => session.panel !== undefined,
	};
	// Two configurable inactivity timers (Phase 9): an idle-deactivation period
	// for detached + idle sessions, and a longer no-user-input cap that sleeps
	// any session regardless of state. `0` disables a timer; any invalid entry
	// (non-number / NaN / Infinity / negative, past VS Code's schema warning)
	// falls back to the default rather than the previous silent 0-ms self-sleep.
	const idleMinutes = readSleepSetting(config.get<unknown>("session.idleSleepMinutes"), 60);
	const inactivityHours = readSleepSetting(config.get<unknown>("session.inactivitySleepHours"), 4);
	session.sleep = new SleepController(
		sleepable,
		{ sleep: () => void sleepSession(session) },
		{
			idleMs: idleMinutes * 60_000,
			capMs: inactivityHours * 60 * 60_000,
		},
	);

	// Controller-lifetime listeners (survive view reattach): keep the sidebar in
	// sync (debounced so a turn doesn't scan disk per event), drive sleep-on-idle
	// for a backgrounded session, and reflect run-state in the tab title.
	controller.onUpdate(() => {
		scheduleSidebarRefresh();
		session.sleep.onUpdate();
		updateTabTitle(session);
	});
	// Reset the inactivity cap whenever the user drives the session.
	controller.onUserInput(() => session.sleep.onUserInput());

	attachView(context, session);

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

/** Build and attach a fresh chat panel + webview bridge to a session's
 * controller — on first creation and again when reopening a backgrounded session
 * whose original panel was closed. */
function attachView(context: vscode.ExtensionContext, session: ChatSession): void {
	const panel = vscode.window.createWebviewPanel("dreb.chat", panelTitle(session), vscode.ViewColumn.Active, {
		enableScripts: true,
		retainContextWhenHidden: true,
		localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")],
	});

	const connection = connectWebview(panel.webview, session.controller);
	panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri, makeNonce());
	session.panel = panel;
	session.connection = connection;
	session.sleep.onAttach();

	panel.onDidDispose(() => {
		// An explicit teardown (stop / delete / deactivate / sleep) already owns
		// disposal — don't re-background a session that is being torn down.
		if (session.disposing) return;
		// User closed the tab: detach the view but keep the controller running.
		// It stays alive while working / awaiting input, and sleeps once idle.
		detachView(session);
		session.sleep.onDetach();
		// If the closed tab was the focused one, no dreb chat is active anymore
		// (focus may land on a non-dreb editor that emits no view-state event).
		pool.setActive(nextActiveKey(pool.active?.key, session.key, false));
		scheduleSidebarRefresh();
	});
	panel.onDidChangeViewState((e) => {
		// Track which session's tab is focused so the sidebar can highlight it.
		// The decision is order-independent (deactivate(old) + activate(new) fire
		// in either order) — see `nextActiveKey`.
		pool.setActive(nextActiveKey(pool.active?.key, session.key, e.webviewPanel.active));
		scheduleSidebarRefresh();
	});
}

/** Detach the webview view from a backgrounded session: dispose the bridge and
 * drop the panel references, keeping the controller (and its RPC child) alive. */
function detachView(session: ChatSession): void {
	session.connection?.dispose();
	session.connection = undefined;
	session.panel = undefined;
}

/** Reveal a session's panel, rebuilding it if the session was backgrounded (its
 * panel closed) since it was last viewed. Does nothing if the extension is
 * shutting down (no context to rebuild into). */
function revealSession(session: ChatSession): void {
	const ctx = extensionContext;
	revealOrReattach(
		{ hasPanel: () => session.panel !== undefined, hasContext: () => ctx !== undefined },
		{
			reveal: () => session.panel?.reveal(vscode.ViewColumn.Active),
			rebuild: () => {
				if (ctx) attachView(ctx, session);
			},
		},
	);
}

/** The chat tab title: `D: <session name>` (shortened) plus a compact run-state
 * marker, so multiple open chats are distinguishable in the tab strip, map back
 * to their sidebar row, and a backgrounded / unfocused session's running,
 * working, or needs-input status stays visible. */
function panelTitle(session: ChatSession): string {
	return formatTabTitle(session.controller.title, session.controller.runState);
}

function updateTabTitle(session: ChatSession): void {
	if (session.panel) session.panel.title = panelTitle(session);
}

/** Put a session to sleep: release its controller / RPC child (via the pool
 * teardown), leaving a resumable on-disk row that reopening restores from the
 * persisted transcript. Driven by the idle timer (detached + idle) or the
 * no-user-input cap (any session, regardless of attach state / run-state). */
async function sleepSession(session: ChatSession): Promise<void> {
	await pool.disposeSession(session);
	scheduleSidebarRefresh();
}

/** Abort a session's current turn and end it — the explicit, deliberate
 * interrupt. Closing a tab never aborts; this is the only user path that does. */
async function stopSession(key: string): Promise<void> {
	const session = pool.get(key);
	if (!session) return;
	try {
		await session.controller.abort();
	} catch {
		// Abort is best-effort (e.g. no turn in flight); tear down regardless.
	}
	await pool.disposeKey(key);
	scheduleSidebarRefresh();
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
	const { cli, node } = resolveRuntime(config);
	if (!cli.ok) {
		vscode.window.showErrorMessage(`dreb: cannot rename — ${cli.error}`);
		return;
	}
	const controller = new SessionController({
		cwd,
		cliPath: cli.path,
		nodePath: node.nodePath,
		env: node.env,
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
		const result = await deletePersistedSession(
			inventory,
			flags,
			path,
			pool.active?.controller.sessionPath,
			(message) => vscode.window.showErrorMessage(message),
		);
		// Drop any persisted manual order rank too, so a re-created session at the
		// same path doesn't inherit a stale position.
		if (result.ok) await order.clear(path);
	}
	scheduleSidebarRefresh();
}

function workspaceCwd(): string {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();
}

/** Cached real (symlink-resolved) directory of this extension's install. */
let extensionRealDirCache: string | undefined;

/**
 * This extension's own directory with symlinks resolved. A repo-local install
 * symlinks `packages/vscode` into `~/.vscode/extensions`, so `extensionUri.fsPath`
 * is the symlink; `realpath` yields the actual monorepo path, which repo-relative
 * CLI resolution needs to reach the sibling `packages/coding-agent`.
 */
function extensionDirReal(): string | undefined {
	if (extensionRealDirCache) return extensionRealDirCache;
	const raw = extensionContext?.extensionUri.fsPath;
	if (!raw) return undefined;
	try {
		extensionRealDirCache = realpathSync(raw);
	} catch {
		extensionRealDirCache = raw;
	}
	return extensionRealDirCache;
}

/**
 * Resolve the runtime a session needs: the CLI entry point (repo-relative by
 * default) and the Node executable to spawn it with (a discovered Node >=22 or
 * the editor's own runtime). Centralized so every controller call site stays in
 * sync.
 *
 * The Node runtime resolution (cache invalidation + one-time older-runtime
 * warning) lives in the pure, unit-tested `node-runtime-cache` module.
 */
const nodeRuntimeCacheState = createNodeRuntimeCacheState();

function resolveRuntime(config: vscode.WorkspaceConfiguration): {
	cli: ReturnType<typeof resolveCliPath>;
	node: ReturnType<typeof resolveNodePath>;
} {
	const cli = resolveCliPath({
		configuredPath: config.get<string>("cliPath"),
		extensionDir: extensionDirReal(),
	});

	const node = resolveNodeRuntimeCached(nodeRuntimeCacheState, {
		configuredNodePath: config.get<string>("nodePath") ?? "",
		warn: (message) => vscode.window.showWarningMessage(message),
	});

	return { cli, node };
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
