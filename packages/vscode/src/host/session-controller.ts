/**
 * SessionController — owns one dreb RPC child process for a single working
 * directory and keeps the authoritative transcript state for it.
 *
 * One controller per session from day one: it holds its own `RpcClient` (via an
 * injectable factory, so tests can supply a fake and production lazily loads the
 * ESM-only agent runtime), its own `cwd`, and its own projected state. This
 * makes a future multi-session pool a matter of holding several controllers,
 * with no rework here.
 *
 * The controller is transport-agnostic: it exposes `onUpdate` and forwards raw
 * events + status changes. The webview bridge adapts those to `postMessage`.
 */

import type { ComposerPrefillMode } from "../shared/composer-prefill.js";
import { formatSessionStats } from "../shared/format.js";
import { MENTION_RESULT_CAP, rankMentionResults } from "../shared/mention.js";
import {
	alignCheckpoints,
	applyEvent,
	type Checkpoint,
	createTranscriptState,
	foldMessagesIntoState,
	type TranscriptState,
} from "../shared/projection.js";
import type {
	HostStatus,
	ImageAttachmentDto,
	OpenSourceRef,
	QueuedMessageDto,
	ReviewFileDto,
	ReviewStateDto,
	SessionTreeDto,
	SessionTreeNodeDto,
	SlashCommandDto,
	TagContextOrigin,
	TaggedContextDto,
	UiResponse,
} from "../shared/protocol.js";
import { deriveSessionStatus, type SessionRunState } from "../shared/session-list.js";
import { buildFileContext, buildPromptWithContext, buildSymbolContext } from "../shared/tagged-context.js";
import { hunkIndexForLine, parseFileDiff } from "./diff-hunks.js";
import {
	baselineContent,
	captureTree,
	changedFiles,
	fileDiff,
	findGitRoot,
	revertFile,
	revertHunk,
} from "./git-snapshot.js";
import { type HostUi, noopHostUi } from "./host-ui.js";
import { ReviewModel } from "./review-model.js";
import { noopReviewUi, type ReviewUi } from "./review-ui.js";
import { BUILTIN_COMMANDS, DEFERRED_BUILTINS, routeInput, stripSlash, TERMINAL_ONLY_BUILTINS } from "./slash-router.js";
import { noopSourceLinkUi, type SourceLinkUi } from "./source-link-ui.js";

/** Thinking levels offered in the picker. The active model may support a subset;
 * `set_thinking_level` clamps server-side and we reflect the applied value via a
 * follow-up state refresh (the valid-per-model list is not exposed over RPC). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Structural view of the runtime state fields the controller reads. */
interface RpcSessionStateLike {
	model?: { provider: string; id: string; name?: string };
	thinkingLevel?: string;
	askModeEnabled?: boolean;
	usingSubscription?: boolean;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
	sessionFile?: string;
}

/** Structural view of `getSessionStats()` (superset assignable from SessionStats). */
interface SessionStatsLike {
	sessionId?: string;
	userMessages?: number;
	assistantMessages?: number;
	toolCalls?: number;
	totalMessages?: number;
	tokens?: { input?: number; output?: number; total?: number };
	cost?: number;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

/** Structural view of one available model. */
interface ModelInfoLike {
	provider: string;
	id: string;
	name?: string;
}

/**
 * Structural view of the parts of `RpcClient` the controller uses. Kept
 * hand-written (not `Pick<RpcClient>`) so unit tests can build a fake without
 * importing the agent's concrete types. Members are methods so parameter checks
 * stay bivariant and the real `RpcClient` remains assignable.
 */
export interface RpcClientLike {
	start(): Promise<void>;
	stop(): Promise<void>;
	prompt(message: string, images?: unknown[]): Promise<void>;
	/** Queue a message while the agent is streaming, injecting it into the
	 * running turn (after the current tool calls). The plain `prompt()` throws
	 * mid-stream, so a submit made while working must route here. */
	steer(message: string, images?: unknown[]): Promise<void>;
	/** Queue a message while the agent is streaming, delivered after the current
	 * turn fully finishes. */
	followUp(message: string, images?: unknown[]): Promise<void>;
	/** Read the queued steer/follow-up messages without clearing them. */
	getPendingMessages(): Promise<{ steering: string[]; followUp: string[] }>;
	/** Clear the queued steer/follow-up messages, returning the cleared text. */
	clearPendingMessages(): Promise<{ steering: string[]; followUp: string[] }>;
	abort(): Promise<void>;
	compact(customInstructions?: string): Promise<unknown>;
	/** Toggle read-only Ask mode; resolves with the resulting state. */
	setAskMode(enabled: boolean): Promise<{ enabled: boolean }>;
	getCommands(): Promise<
		Array<{
			name: string;
			description?: string;
			source: "extension" | "prompt" | "skill" | "builtin";
			/** Builtins only: false hides the command from autocomplete. */
			dashboard?: boolean;
		}>
	>;
	sendExtensionUIResponse(response: unknown): void;
	onEvent(listener: (event: any) => void): () => void;
	onExit(listener: (info: any) => void): () => void;
	/** List background subagents tracked by the RPC child's registry (running and
	 * recently completed). Used to seed the live "background work" indicator when a
	 * session (re)connects while agents are already running. */
	listBackgroundAgents?(): Promise<Array<{ agentId: string; status: string }>>;
	// Runtime status (TUI parity).
	getState(): Promise<RpcSessionStateLike>;
	getDailyCost(): Promise<number>;
	getSessionStats(): Promise<SessionStatsLike>;
	// Model / thinking selection.
	getAvailableModels(): Promise<ModelInfoLike[]>;
	setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }>;
	setThinkingLevel(level: string): Promise<void>;
	// Built-in slash commands.
	newSession(parentSession?: string): Promise<{ cancelled: boolean }>;
	reload(): Promise<void>;
	dream(args?: string): Promise<{ message: string }>;
	setSessionName(name: string): Promise<void>;
	exportHtml(outputPath?: string): Promise<{ path: string }>;
	importJsonl(inputPath: string): Promise<{ cancelled: boolean }>;
	// Session tree / fork (Phase 6).
	/** Fork a new branch from a session entry. Returns the re-ask `text` for a
	 * user-message fork (empty for an assistant continue-from-answer fork). */
	fork(entryId: string): Promise<{ text: string; cancelled: boolean }>;
	/** The session entries the backend will actually fork from (assistant turns
	 * that are not errored/aborted and hold no unresolved tool calls, plus
	 * non-empty user turns). Drives which inline Fork controls are shown. */
	getForkMessages(): Promise<Array<{ entryId: string; text: string; role: "user" | "assistant" }>>;
	/** Navigate (restore/branch-jump) the session leaf to a tree entry. */
	navigateTree(targetId: string): Promise<{ cancelled: boolean; editorText?: string }>;
	/** The session branch tree plus the current leaf. */
	getTree(): Promise<{ roots: SessionTreeNodeDto[]; leafId: string | null }>;
	/** The full provider-message list for the current branch (updated after a
	 * navigate/fork, and populated on resume). Used to rebuild the transcript with
	 * complete content — answers, thinking, and tool calls — rather than previews. */
	getMessages(): Promise<unknown[]>;
}

export type RpcClientFactory = (options: {
	cliPath: string;
	cwd: string;
	args: string[];
}) => RpcClientLike | Promise<RpcClientLike>;

export interface SessionControllerOptions {
	cwd: string;
	cliPath: string;
	/** Extra CLI args (e.g. --provider/--model), appended verbatim. */
	args?: string[];
	/** Resume a specific session .jsonl by passing `--session <path>` to the RPC
	 * child. Omit for a fresh session. */
	sessionPath?: string;
	/** Override the RpcClient constructor (tests inject a fake). */
	clientFactory?: RpcClientFactory;
	/** Native prompt port (quick picks / dialogs); defaults to a no-op so the
	 * controller stays vscode-free and testable. Production injects the
	 * vscode-backed impl. */
	ui?: HostUi;
	/** Native change-review surface (SCM group + quick-diff + diff viewer);
	 * defaults to a no-op so the controller stays vscode-free and testable. */
	review?: ReviewUi;
	/** Native code-link opener (Phase 5b); defaults to a no-op so the controller
	 * stays vscode-free and testable. */
	sourceLink?: SourceLinkUi;
	logger?: (line: string) => void;
}

export type ControllerUpdate =
	| { kind: "event"; event: unknown }
	| { kind: "status"; status: HostStatus }
	/** The slash-command list changed (e.g. after `/reload`). */
	| { kind: "commands"; commands: SlashCommandDto[] }
	/** The change-review set changed (per-turn detection, accept/revert). */
	| { kind: "review"; review: ReviewStateDto }
	/** A context tag was added to the chat: an editor selection (Phase 4), or a
	 * file/folder from the native `@@` picker. `origin` lets the webview insert an
	 * inline `@name` reference for picker tags while leaving selection tags as a
	 * chip only. */
	| { kind: "tag-context"; context: TaggedContextDto; origin: TagContextOrigin }
	/** Inline restore/fork controls were recomputed (Phase 6). */
	| { kind: "checkpoints"; checkpoints: Checkpoint[] }
	/** The session branch tree, in response to a `show-tree` request (Phase 6). */
	| { kind: "tree"; tree: SessionTreeDto }
	/** Pre-fill the composer. `mode` (default `"replace"`) controls whether it
	 * overwrites the composer or `"prepend"`s before any in-progress draft. */
	| { kind: "composer-prefill"; text: string; mode?: ComposerPrefillMode }
	/** The pending steer/follow-up queue changed — the bridge forwards it to the
	 * webview as composer chips (empty clears them). */
	| { kind: "pending"; messages: QueuedMessageDto[] }
	/** Transcript was replaced host-side (e.g. `/new`, `/import`); the bridge
	 * re-sends a fresh snapshot. */
	| { kind: "resync" };

/** Lazily loads the ESM-only agent runtime so tests with an injected factory
 * never pull it in. */
const defaultClientFactory: RpcClientFactory = async (options) => {
	const { RpcClient } = await import("@dreb/coding-agent/rpc");
	return new RpcClient({ cliPath: options.cliPath, cwd: options.cwd, args: options.args });
};

function formatExit(info: { code?: number | null; signal?: string | null; error?: Error; stderr?: string }): string {
	if (info?.error) return `dreb process failed: ${info.error.message}`;
	return `dreb process exited (code ${info?.code ?? "null"}, signal ${info?.signal ?? "null"})`;
}

/** Recovery policy tuning (deliverable C, issue 53). Bounded auto-restart so a
 * transient crash self-heals but a crash-loop (dead pipe / deterministic
 * startup failure) degrades to a banner instead of spinning forever. */
const RESTART_MAX_IN_WINDOW = 3;
const RESTART_WINDOW_MS = 60_000;
const RESTART_BACKOFF_MS = 500;
/** How long a restarted child must stay up before the crash counter resets, so
 * a *later* isolated crash still gets a fresh recovery budget. */
const RESTART_STABLE_MS = 10_000;
const RECOVERING_NOTICE = "dreb stopped unexpectedly — recovering…";

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The path of nodes from a root down to `targetId` (inclusive), via depth-first
 * search over the nested `children`. Empty when the id is not in the tree. */
function findPath(nodes: SessionTreeNodeDto[], targetId: string): SessionTreeNodeDto[] {
	for (const node of nodes) {
		if (node.id === targetId) return [node];
		const rest = findPath(node.children, targetId);
		if (rest.length > 0) return [node, ...rest];
	}
	return [];
}

/** Reduce a session tree to the current branch (root → leaf), returning one
 * **run-terminal** assistant entry id per agent run. A run is delimited by user
 * messages; within a run the backend persists several assistant entries (each
 * tool-call turn plus the final answer), but the transcript renders one response
 * group per run, so only the run's last assistant entry carries the inline
 * restore/fork control. Non-message entries (labels, model changes, tool results)
 * are skipped. Returns empty when there is no leaf (fresh/empty session). */
function currentBranch(roots: SessionTreeNodeDto[], leafId: string | null): { runTerminalEntryIds: string[] } {
	const path = leafId ? findPath(roots, leafId) : [];
	const runTerminalEntryIds: string[] = [];
	let lastAssistantInRun: string | undefined;
	for (const node of path) {
		if (node.type !== "message") continue;
		if (node.role === "user") {
			// A user turn closes the current run: commit its terminal assistant entry.
			if (lastAssistantInRun) {
				runTerminalEntryIds.push(lastAssistantInRun);
				lastAssistantInRun = undefined;
			}
		} else if (node.role === "assistant") {
			lastAssistantInRun = node.id;
		}
		// toolResult / other roles stay within the current run.
	}
	if (lastAssistantInRun) runTerminalEntryIds.push(lastAssistantInRun);
	return { runTerminalEntryIds };
}

/** An `@dreb/ai` `ImageContent` part: the wire shape the agent expects for an
 * inline image. Declared locally so this module stays free of a static
 * `@dreb/ai` import (the RpcClient is loaded dynamically). */
interface ImageContentPart {
	type: "image";
	data: string;
	mimeType: string;
}

/** Map composer image attachments to the agent's `ImageContent` parts, or
 * `undefined` when there are none (so `prompt`/`steer` receive no `images` arg
 * for a text-only turn, exactly as before). */
function toImageContent(images?: readonly ImageAttachmentDto[]): ImageContentPart[] | undefined {
	if (!images || images.length === 0) return undefined;
	return images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
}

export class SessionController {
	private readonly state: TranscriptState = createTranscriptState();
	private readonly listeners = new Set<(update: ControllerUpdate) => void>();
	/** User-input listeners (Phase 9): fired whenever the user actively drives
	 * the session (a composer submit or an answer to a blocking UI request), so
	 * the sleep controller can reset its "no user input" inactivity cap. */
	private readonly inputListeners = new Set<() => void>();
	private readonly factory: RpcClientFactory;
	private readonly ui: HostUi;
	private readonly reviewUi: ReviewUi;
	private readonly sourceLinkUi: SourceLinkUi;
	private readonly reviewModel = new ReviewModel();
	/** Whether change review is active for this cwd (false outside a git repo). */
	private reviewEnabled = false;
	/** The git repository root backing change review. All review git operations
	 * and path joins are anchored here (not `options.cwd`) so a workspace opened
	 * at a subdirectory of the repo still produces correct repo-root-relative
	 * paths. Falls back to `options.cwd` when outside a repo (review disabled). */
	private reviewRoot: string;
	/** Last-published review state (held so the bridge can include it in the
	 * reload snapshot — review survives webview recreation). */
	private reviewState: ReviewStateDto = { enabled: false, files: [] };
	/** Last-computed inline restore/fork controls (Phase 6), aligned to the
	 * current transcript's response groups. Held so the bridge can include them
	 * in the ready/resync snapshot. */
	private checkpoints: Checkpoint[] = [];
	/** Last-known pending steer/follow-up queue (held so the bridge can include
	 * it in the ready snapshot — queued chips survive webview recreation).
	 * Refreshed authoritatively from the RPC child on run transitions and after
	 * a queued submit. */
	private pendingMessages: QueuedMessageDto[] = [];
	private readonly logger: (line: string) => void;
	private readonly options: SessionControllerOptions;
	private client: RpcClientLike | undefined;
	private sessionFile: string | undefined;
	private commands: SlashCommandDto[] = [...BUILTIN_COMMANDS];
	private status: HostStatus;
	private unsubEvent: (() => void) | undefined;
	private unsubExit: (() => void) | undefined;
	private disposed = false;
	/** Resume path for `start()`: the `--session` file to load. Starts as the
	 * construction-time resume path and is re-pointed at the live session file on
	 * an auto-restart so recovery is lossless. */
	private resumePath: string | undefined;
	/** Timestamps of recent auto-restart attempts (rolling window), used to bound
	 * recovery against a crash-loop (deliverable C). */
	private restartTimestamps: number[] = [];
	/** Pending backoff timer for a scheduled restart. */
	private restartTimer: ReturnType<typeof setTimeout> | undefined;
	/** Fires once a restarted child has stayed up long enough to be considered
	 * stable, clearing the crash budget. */
	private stableTimer: ReturnType<typeof setTimeout> | undefined;
	/** Serializes status refreshes: coalesces an overlapping request into one
	 * trailing re-run so a new turn starting mid-refresh still ends up current.
	 * `statusAgainIncludeDaily` accumulates the daily-cost intent of every
	 * coalesced caller so the trailing re-run doesn't drop a requested daily
	 * refresh (e.g. an `agent_end` refresh coalesced into a cheaper one). */
	private statusBusy = false;
	private statusAgain = false;
	private statusAgainIncludeDaily = false;
	/** The last message the user actually sent to the model (raw composer text +
	 * attachments, pre-fold), retained so a failed / unanswered turn can be resent
	 * verbatim via {@link retry}. Set only for prompt sends — never for slash
	 * builtins, which are not model turns and have nothing to "retry". Survives an
	 * in-place RPC-child restart (the controller instance outlives it), so a retry
	 * after auto-recovery targets the recovered child. */
	private lastPrompt: { text: string; attachments?: TaggedContextDto[]; images?: ImageAttachmentDto[] } | undefined;

	constructor(options: SessionControllerOptions) {
		this.options = options;
		this.resumePath = options.sessionPath;
		this.factory = options.clientFactory ?? defaultClientFactory;
		this.ui = options.ui ?? noopHostUi;
		this.reviewUi = options.review ?? noopReviewUi;
		this.sourceLinkUi = options.sourceLink ?? noopSourceLinkUi;
		this.logger = options.logger ?? (() => {});
		this.status = { connected: false, cwd: options.cwd };
		// Resolve the git-repo state synchronously up front (findGitRoot is a cheap
		// upward directory walk) so `getReviewState()` returns the correct enabled
		// flag the instant the webview announces `ready` — which can happen before
		// the slow `start()` RPC handshake completes. Deferring this to `start()`
		// would answer that early `ready` with a stale `enabled: false` and flash a
		// spurious "change review unavailable" notice in an ordinary git repo.
		const root = findGitRoot(options.cwd);
		this.reviewEnabled = root !== null;
		this.reviewRoot = root ?? options.cwd;
		this.reviewState = { enabled: this.reviewEnabled, files: [] };
	}

	get cwd(): string {
		return this.options.cwd;
	}

	/** The live session .jsonl path (from get_state), falling back to a resume
	 * path passed at construction; undefined for a brand-new session before its
	 * first status refresh. */
	get sessionPath(): string | undefined {
		return this.sessionFile ?? this.options.sessionPath;
	}

	/** Live run state (running / needs-input / idle) derived from the projected
	 * transcript. */
	get runState(): SessionRunState {
		return deriveSessionStatus(this.state);
	}

	/** Rename the live session (persisted via the set_session_name RPC). */
	async rename(name: string): Promise<void> {
		await this.client?.setSessionName(name);
	}

	/** The git repository root backing change review (repo root, or the workspace
	 * cwd when review is disabled). Used by the extension to map editor URIs to
	 * the repo-root-relative paths the review model speaks. */
	get gitRoot(): string {
		return this.reviewRoot;
	}

	getTranscript(): TranscriptState {
		return this.state;
	}

	getStatus(): HostStatus {
		return this.status;
	}

	/** The current change-review state (pending files); included by the bridge in
	 * the reload snapshot so review survives webview recreation. */
	getReviewState(): ReviewStateDto {
		return this.reviewState;
	}

	/** The current inline restore/fork controls (Phase 6); included by the bridge
	 * in the ready/resync snapshot so they survive webview recreation. */
	getCheckpoints(): Checkpoint[] {
		return this.checkpoints;
	}

	/** The current pending steer/follow-up queue (Phase: queued composer
	 * messages); included by the bridge in the ready snapshot so queued chips
	 * survive webview recreation. */
	getPending(): QueuedMessageDto[] {
		return this.pendingMessages;
	}

	getCommandList(): SlashCommandDto[] {
		return this.commands;
	}

	onUpdate(listener: (update: ControllerUpdate) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Subscribe to user-input events (composer submit / UI-request answer). Used
	 * by the sleep controller to reset the inactivity cap on genuine engagement. */
	onUserInput(listener: () => void): () => void {
		this.inputListeners.add(listener);
		return () => this.inputListeners.delete(listener);
	}

	private emitUserInput(): void {
		for (const listener of this.inputListeners) {
			try {
				listener();
			} catch (err) {
				this.logger(`user-input listener failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	/** Spawn the RPC child, wire event/exit handlers, and prime the command list. */
	async start(): Promise<void> {
		if (this.disposed) throw new Error("SessionController is disposed");
		const args = [...(this.options.args ?? []), ...(this.resumePath ? ["--session", this.resumePath] : [])];
		const client = await this.factory({
			cliPath: this.options.cliPath,
			cwd: this.options.cwd,
			args,
		});
		this.client = client;
		this.unsubEvent = client.onEvent((event) => this.handleEvent(event));
		this.unsubExit = client.onExit((info) => this.handleExit(info));
		try {
			await client.start();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.setStatus({ ...this.status, connected: false, error: message });
			this.handleEvent({ type: "host_error", message: `Failed to start dreb: ${message}` });
			throw err;
		}
		this.setStatus({ ...this.status, connected: true, error: undefined });
		// Review enablement was resolved synchronously in the constructor (see
		// there); re-publish it now so any webview that went live before this
		// point receives the authoritative state via the push path too. Outside a
		// git repo this drives the "change review unavailable" notice (acceptance
		// criterion: degrade gracefully with a clear notice).
		this.emit({ kind: "review", review: this.reviewState });
		await this.refreshCommands();
		await this.refreshStatus(true);
		// Seed the live "background work" indicator from the RPC child's registry so
		// a session that (re)connects while background agents are already running
		// shows the right state immediately, rather than waiting for the next
		// background_agent_* event. Best-effort — never blocks a successful start.
		await this.seedBackgroundAgents();
		// When resuming a persisted session (`--session <path>`), the RPC child
		// loads the saved conversation into its own memory but never re-broadcasts
		// the historical events. The transcript is built exclusively from that live
		// event stream, so a resumed session would render a blank window. Fold the
		// persisted branch in now (same path as restore/fork) so prior turns render
		// immediately. Guarded on `sessionPath` so a brand-new session keeps
		// populating from the live stream and doesn't fold on start.
		if (this.resumePath) {
			try {
				await this.rebuildTranscript();
			} catch (err) {
				this.logger(`resume transcript rebuild failed: ${errorText(err)}`);
				// A failure partway through the rebuild can leave a half-folded
				// transcript (`foldMessagesIntoState` clears items before repopulating).
				// Reset to a clean empty state (and clear checkpoints) so the webview
				// never shows a partial conversation, then resync so an already-live
				// webview reflects that clean state. Finally surface a notice — parity
				// with fork()/navigateTree() — so the user knows their prior turns are
				// saved and will reload on reopen, rather than silently facing a blank
				// window indistinguishable from a brand-new session. Best-effort: this
				// never rethrows out of `start()`.
				this.resetTranscriptState();
				this.emitNotice(
					"Couldn't restore the previous conversation — it's still saved and will reload when you reopen the chat.",
				);
				this.emit({ kind: "resync" });
			}
		}
	}

	/** Prime {@link TranscriptState.backgroundAgentIds} from the RPC child's
	 * background-agent registry. Runs the running agents back through
	 * {@link handleEvent} as synthetic `background_agent_start` events so the seed
	 * shares the live apply-and-notify path (and is idempotent — a live start event
	 * that already arrived is deduped by `applyEvent`). Best-effort. */
	private async seedBackgroundAgents(): Promise<void> {
		if (!this.client?.listBackgroundAgents) return;
		try {
			const agents = await this.client.listBackgroundAgents();
			for (const agent of agents) {
				if (agent.status === "running" && agent.agentId) {
					this.handleEvent({ type: "background_agent_start", agentId: agent.agentId });
				}
			}
		} catch (err) {
			this.logger(`seedBackgroundAgents failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Fetch the agent's commands and merge with host builtins.
	 *
	 * Resource commands (extension/prompt/skill) become `source: "agent"` and
	 * route through `prompt`. Built-ins are surfaced as `source: "builtin"` so
	 * the router intercepts them (sending a builtin through `prompt` is rejected
	 * server-side and silently dropped). On success we trust the server's
	 * builtin list (respecting its `dashboard` visibility flag); if the call
	 * fails we degrade to the hardcoded builtin fallback. */
	async refreshCommands(): Promise<SlashCommandDto[]> {
		let agentCommands: SlashCommandDto[] = [];
		let builtinCommands: SlashCommandDto[] | undefined;
		try {
			const raw = (await this.client?.getCommands()) ?? [];
			agentCommands = raw
				.filter((c) => c.source !== "builtin")
				.map((c) => ({ name: stripSlash(c.name), description: c.description, source: "agent" as const }));
			builtinCommands = raw
				.filter((c) => c.source === "builtin" && c.dashboard !== false)
				.map((c) => ({ name: stripSlash(c.name), description: c.description, source: "builtin" as const }));
		} catch (err) {
			this.logger(`getCommands failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		this.commands = [
			...agentCommands,
			...(builtinCommands && builtinCommands.length > 0 ? builtinCommands : BUILTIN_COMMANDS),
		];
		return this.commands;
	}

	/** Route composer text to the correct RPC call. Guarded on an active
	 * connection so a submit that races the spawn window (or lands after a
	 * child crash) surfaces a notice instead of dispatching into a client that
	 * isn't ready, and every awaited RPC call is wrapped so a rejection becomes
	 * a visible notice rather than an unhandled promise rejection. */
	async submit(text: string, attachments?: TaggedContextDto[], images?: ImageAttachmentDto[]): Promise<void> {
		// Any composer submit is genuine user engagement — reset the inactivity
		// cap before anything else (even a submit that races the spawn window or
		// lands after a crash and is short-circuited below).
		this.emitUserInput();
		if (!this.client || !this.status.connected) {
			this.emitNotice(
				this.status.error
					? "dreb isn't connected — reopen the chat to restart it."
					: "dreb is still starting up — try again in a moment.",
			);
			return;
		}
		const decision = routeInput(text, this.commands);
		// An attachment-only or image-only submit (chips/images attached, no typed
		// text) is deliberately allowed by the composer; with neither is there
		// genuinely nothing to send, so short-circuit only then.
		const hasAttachments = (attachments && attachments.length > 0) || (images && images.length > 0);
		if (decision.kind === "empty" && !hasAttachments) return;
		try {
			switch (decision.kind) {
				case "empty":
					// Reached only with attachments/images present (see guard above):
					// send the folded context + images so a chips/images-only submit
					// isn't silently dropped. Retain the raw inputs so a failed turn
					// can be resent verbatim.
					this.lastPrompt = { text, attachments, images };
					await this.deliver(buildPromptWithContext(text, attachments), images);
					return;
				case "prompt":
					// Fold any tagged editor selections into the prompt as located
					// context (attachments only apply to prompts, not slash builtins);
					// pasted images ride along as separate image content parts.
					// Retain the raw inputs so a failed turn can be resent verbatim; a
					// retry re-routes the same text, reproducing the identical prompt.
					this.lastPrompt = { text, attachments, images };
					await this.deliver(buildPromptWithContext(decision.message, attachments), images);
					return;
				case "builtin":
					await this.runBuiltin(decision.command, decision.arg);
					return;
				case "unknown-command":
					this.emitNotice(`Unknown command: /${decision.name}`);
					return;
			}
		} catch (err) {
			this.emitNotice(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Resend the last message the user sent to the model — used to recover a turn
	 * that failed or went unanswered (provider unavailable, rate-limited, transient
	 * error). Re-drives the retained payload through {@link submit}, inheriting all
	 * of its guards (disconnected → notice, streaming → steer) and re-emitting user
	 * engagement, and reproducing the identical folded prompt (same text + tagged
	 * context + pasted images). No-ops with a notice when there is nothing to resend
	 * (e.g. only slash builtins have been run). */
	async retry(): Promise<void> {
		const last = this.lastPrompt;
		if (!last) {
			this.emitNotice("Nothing to retry yet — send a message first.");
			return;
		}
		await this.submit(last.text, last.attachments, last.images);
	}

	/** Send composer text (and any pasted images) to the model. While the agent is
	 * working, `prompt()` throws ("Agent is already processing…"), which would
	 * silently swallow the message; route it through `steer()` instead so it's
	 * queued into the running turn, and refresh the pending chips so the queued
	 * message is visible. When idle, dispatch it as a normal prompt. Images are
	 * mapped to the agent's `ImageContent` shape (a `type: "image"` part). */
	private async deliver(message: string, images?: ImageAttachmentDto[]): Promise<void> {
		const client = this.client;
		if (!client) return;
		const content = toImageContent(images);
		if (this.state.streaming) {
			await client.steer(message, content);
			await this.refreshPending();
			return;
		}
		await client.prompt(message, content);
	}

	/** Abort the current turn. Any messages the user queued while the agent was
	 * working are stranded by an abort (the agent loop exits without draining the
	 * steer/follow-up queue), so drain and clear the RPC child's queue and restore
	 * the queued text into the composer — the user decides whether to resend it
	 * rather than losing it. */
	async abort(): Promise<void> {
		if (!this.client || !this.status.connected) return;
		try {
			await this.client.abort();
		} catch (err) {
			this.logger(`abort failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		try {
			const { steering, followUp } = await this.client.clearPendingMessages();
			const restored = [...steering, ...followUp].filter((text) => text.trim().length > 0);
			this.setPending([]);
			if (restored.length > 0) {
				this.emit({ kind: "composer-prefill", text: restored.join("\n\n"), mode: "prepend" });
			}
		} catch (err) {
			this.logger(`clearing pending on abort failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Dispatch a built-in slash command to its RPC method / native UI. Invoked
	 * only from `submit` (which has already verified an active connection), so a
	 * rejection here is caught by `submit` and surfaced as a notice. */
	private async runBuiltin(command: string, arg?: string): Promise<void> {
		const client = this.client;
		if (!client) return;
		switch (command) {
			case "compact":
				await client.compact(arg);
				return;
			case "ask": {
				const sub = arg?.trim().toLowerCase() ?? "";
				if (sub !== "on" && sub !== "off" && sub !== "" && sub !== "status") {
					this.emitNotice("Usage: /ask [on | off | status] (bare /ask toggles).");
					return;
				}
				// Fetch the authoritative live state once: it drives the bare-toggle
				// direction, the `status` report, and the already-in-mode guard.
				const current = (await client.getState()).askModeEnabled ?? false;
				if (sub === "status") {
					this.emitNotice(`Read-only Ask mode is currently ${current ? "ON" : "OFF"}.`);
					return;
				}
				const enable = sub === "on" ? true : sub === "off" ? false : !current;
				// Match the terminal: a no-op (already in the requested state) reports
				// "already ON/OFF" instead of re-emitting the full activation notice.
				if (enable === current) {
					this.emitNotice(`Read-only Ask mode is already ${enable ? "ON" : "OFF"}.`);
					return;
				}
				const { enabled } = await client.setAskMode(enable);
				this.emitNotice(
					enabled
						? "Read-only Ask mode ON — edits/writes disabled, no shell (use the typed read-only git tool), subagents limited to read-only agents. Use /ask off to exit."
						: "Read-only Ask mode OFF — normal tools restored.",
				);
				return;
			}
			case "model":
				await this.pickModel();
				return;
			case "new": {
				const result = await client.newSession();
				if (result?.cancelled) {
					this.emitNotice("New session cancelled.");
					return;
				}
				this.resetTranscriptState();
				await this.refreshCommands();
				await this.refreshStatus(true);
				this.emit({ kind: "resync" });
				this.emitNotice("Started a new session.");
				return;
			}
			case "reload": {
				await client.reload();
				await this.refreshCommands();
				this.emit({ kind: "commands", commands: this.commands });
				await this.refreshStatus(false);
				this.emitNotice("Reloaded skills, extensions, prompts, and settings.");
				return;
			}
			case "dream": {
				const result = await client.dream(arg);
				this.emitNotice(result?.message ?? "Memory consolidation complete.");
				return;
			}
			case "session": {
				const stats = await client.getSessionStats();
				this.pushSystem(formatSessionStats(stats));
				return;
			}
			case "name": {
				const name = arg ?? (await this.ui.inputBox({ prompt: "Session name", placeholder: "My session" }));
				if (!name || name.trim().length === 0) return;
				await client.setSessionName(name.trim());
				await this.refreshStatus(false);
				this.emitNotice(`Renamed session to "${name.trim()}".`);
				return;
			}
			case "export": {
				const path =
					arg ?? (await this.ui.saveDialog({ defaultName: "dreb-session.html", filters: { HTML: ["html"] } }));
				if (!path) return;
				const result = await client.exportHtml(path);
				this.emitNotice(`Exported session to ${result.path}.`);
				return;
			}
			case "import": {
				const path = arg ?? (await this.ui.openDialog({ filters: { "Session JSONL": ["jsonl"] } }));
				if (!path) return;
				const result = await client.importJsonl(path);
				if (result?.cancelled) {
					this.emitNotice("Import cancelled.");
					return;
				}
				this.resetTranscriptState();
				await this.refreshCommands();
				await this.refreshStatus(true);
				this.emit({ kind: "resync" });
				this.emitNotice(`Imported session from ${path}.`);
				return;
			}
			case "quit": {
				// Emit feedback BEFORE dispose (which clears listeners), then tear
				// down the child. `dispose` unsubscribes first, so stopping the
				// client does not surface a spurious "process exited" error.
				this.emitNotice("Session ended — reopen the chat to start a new one.");
				this.setStatus({ ...this.status, connected: false, error: undefined });
				await this.dispose();
				return;
			}
			default:
				if (DEFERRED_BUILTINS.has(command)) {
					this.emitNotice(`/${command} is coming in a later phase.`);
				} else if (TERMINAL_ONLY_BUILTINS.has(command)) {
					this.emitNotice(`/${command} is handled in the terminal UI, not over RPC.`);
				} else {
					this.emitNotice(`The /${command} command isn't available yet.`);
				}
				return;
		}
	}

	/** Open the native model picker and apply the selection. Public so the
	 * webview header can trigger it via a `pick-model` message. */
	async pickModel(): Promise<void> {
		const client = this.client;
		if (!client || !this.status.connected) {
			this.emitNotice("dreb isn't connected — reopen the chat to restart it.");
			return;
		}
		try {
			const models = await client.getAvailableModels();
			if (models.length === 0) {
				this.emitNotice("No models are available.");
				return;
			}
			const picked = await this.ui.quickPick(
				models.map((m) => ({
					label: m.name && m.name.length > 0 ? m.name : m.id,
					description: m.provider,
					detail: `${m.provider}/${m.id}`,
					value: `${m.provider}\u0000${m.id}`,
				})),
				{ placeholder: "Select a model" },
			);
			if (!picked) return;
			const sep = picked.indexOf("\u0000");
			const provider = picked.slice(0, sep);
			const modelId = picked.slice(sep + 1);
			await client.setModel(provider, modelId);
			await this.refreshStatus(false);
		} catch (err) {
			this.emitNotice(`Model selection failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Open the native thinking-level picker and apply the selection. Public so
	 * the webview header can trigger it via a `pick-thinking` message. */
	async pickThinking(): Promise<void> {
		const client = this.client;
		if (!client || !this.status.connected) {
			this.emitNotice("dreb isn't connected — reopen the chat to restart it.");
			return;
		}
		try {
			const current = this.status.thinkingLevel;
			const picked = await this.ui.quickPick(
				THINKING_LEVELS.map((level) => ({
					label: level,
					description: level === current ? "current" : undefined,
					value: level,
				})),
				{ placeholder: "Select thinking level" },
			);
			if (!picked) return;
			await client.setThinkingLevel(picked);
			await this.refreshStatus(false);
		} catch (err) {
			this.emitNotice(`Thinking-level change failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Re-read runtime status (model / thinking / cost / context) and emit it.
	 * Coalesces overlapping calls into a single trailing re-run. Failures are
	 * logged, never surfaced to the transcript (status is best-effort). */
	private async refreshStatus(includeDailyCost: boolean): Promise<void> {
		const client = this.client;
		if (!client || !this.status.connected) return;
		if (this.statusBusy) {
			this.statusAgain = true;
			// Preserve the strongest pending intent: if any coalesced caller wants
			// the daily cost, the trailing re-run must fetch it (finding 2).
			if (includeDailyCost) this.statusAgainIncludeDaily = true;
			return;
		}
		this.statusBusy = true;
		try {
			const [state, stats, daily] = await Promise.all([
				client.getState(),
				client.getSessionStats(),
				// When not refetching, preserve the last-known daily total rather
				// than wiping the chip on every /name, /reload, or picker (finding 6).
				includeDailyCost ? client.getDailyCost() : Promise.resolve<number | undefined>(this.status.cost?.daily),
			]);
			const model = state.model
				? { provider: state.model.provider, id: state.model.id, name: state.model.name }
				: undefined;
			// Capture the live session file without clobbering a known value when a
			// later state read omits it.
			this.sessionFile = state.sessionFile ?? this.sessionFile;
			this.setStatus({
				...this.status,
				model,
				thinkingLevel: state.thinkingLevel,
				cost: {
					session: stats.cost ?? 0,
					daily,
					usingSubscription: state.usingSubscription ?? false,
				},
				contextUsage: state.contextUsage
					? {
							tokens: state.contextUsage.tokens,
							contextWindow: state.contextUsage.contextWindow,
							percent: state.contextUsage.percent,
						}
					: undefined,
			});
		} catch (err) {
			this.logger(`refreshStatus failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.statusBusy = false;
			if (this.statusAgain) {
				this.statusAgain = false;
				// Serve coalesced callers with their accumulated daily intent, not
				// this finishing call's parameter (finding 2).
				const again = this.statusAgainIncludeDaily;
				this.statusAgainIncludeDaily = false;
				void this.refreshStatus(again);
			}
		}
	}

	/** Refresh the pending steer/follow-up queue from the RPC child (authoritative
	 * — an empty result clears the chips). Best-effort: a read failure leaves the
	 * last-known queue in place rather than surfacing a notice. Called on run
	 * transitions, after a queued submit, and after an abort clears the queue. */
	private async refreshPending(): Promise<void> {
		const client = this.client;
		if (!client || !this.status.connected) return;
		try {
			const { steering, followUp } = await client.getPendingMessages();
			this.setPending([
				...steering.map((text): QueuedMessageDto => ({ kind: "steer", text })),
				...followUp.map((text): QueuedMessageDto => ({ kind: "follow-up", text })),
			]);
		} catch (err) {
			this.logger(`refreshPending failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Replace the held pending queue and publish it to the webview. */
	private setPending(messages: QueuedMessageDto[]): void {
		this.pendingMessages = messages;
		this.emit({ kind: "pending", messages });
	}

	/** Clear the transcript in place (properties, not the reference) so `/new`
	 * and `/import` present a fresh conversation after a `resync`. */
	private resetTranscriptState(): void {
		this.state.items = [];
		this.state.streaming = false;
		this.state.uiRequests = [];
		this.state.backgroundAgentIds = [];
		this.state.statusText = undefined;
		this.state.hostError = undefined;
		this.state.nextResponseId = 1;
		// Drop the prior session's checkpoints so a new/imported session doesn't
		// render stale Restore/Fork controls on its first turn (the new session's
		// first response group reuses id 1 and would otherwise match a stale
		// `{responseId: 1}`). The subsequent `resync` re-posts this empty array.
		this.checkpoints = [];
		// A fresh/imported session starts with no queued messages (the RPC child
		// clears its own queue on new_session); clear the chips to match.
		this.setPending([]);
	}

	/** Append a persistent host-side line to the transcript (e.g. `/session`). */
	private pushSystem(text: string): void {
		this.handleEvent({ type: "host_system", text });
	}

	/** Surface a fatal host-side failure (e.g. the CLI could not be located)
	 * into the transcript + status without spawning a child. */
	reportFatal(message: string): void {
		this.setStatus({ ...this.status, connected: false, error: message });
		this.handleEvent({ type: "host_error", message });
	}

	/** Answer a blocking extension-UI request. */
	respondUi(response: UiResponse): void {
		// Answering a prompt is user engagement — reset the inactivity cap.
		this.emitUserInput();
		this.client?.sendExtensionUIResponse({ type: "extension_ui_response", ...response });
	}

	/** Tag a context reference into the chat. Emits an update the bridge forwards
	 * to the webview as a removable composer chip (queued until the webview is
	 * live, so tagging into a freshly opened chat still lands). `origin` defaults
	 * to `"selection"` (an editor selection, chip only); the native `@@` picker
	 * passes `"picker"` so the webview also inserts an inline `@name` reference. */
	tagContext(context: TaggedContextDto, origin: TagContextOrigin = "selection"): void {
		this.emit({ kind: "tag-context", context, origin });
	}

	/** Open the native file/folder picker and tag each chosen path into the chat
	 * as a path-reference chip (Phase 4b). No-ops when the picker is dismissed.
	 * Mirrors `pickModel()`: the vscode picker is injected via the `HostUi` port,
	 * so this method stays vscode-free and unit-testable. */
	async tagFileFromPicker(): Promise<void> {
		const picks = await this.ui.pickWorkspaceFiles();
		if (!picks) return;
		for (const pick of picks) {
			this.tagContext(
				buildFileContext({ fsPath: pick.fsPath, cwd: this.cwd, isDirectory: pick.isDirectory }),
				"picker",
			);
		}
	}

	/** Search the workspace for the inline `@`-mention typeahead dropdown. Returns
	 * ready-to-tag `TaggedContextDto`s (folders, files, and code symbols, with
	 * workspace-relative paths built from the session `cwd` so a webview selection
	 * needs no further host round-trip), ranked by kind then relevance to `query`
	 * and capped. Stays vscode-free: the search is injected via the `HostUi` port. */
	async searchWorkspace(query: string): Promise<TaggedContextDto[]> {
		const hits = await this.ui.searchWorkspace(query);
		const results: TaggedContextDto[] = hits.map((hit) => {
			if (hit.kind === "symbol") {
				return buildSymbolContext({
					fsPath: hit.fsPath,
					cwd: this.cwd,
					name: hit.name,
					symbolKind: hit.symbolKind,
					line: hit.line,
				});
			}
			return buildFileContext({ fsPath: hit.fsPath, cwd: this.cwd, isDirectory: hit.kind === "folder" });
		});
		return rankMentionResults(results, query, MENTION_RESULT_CAP);
	}

	// ── Change review ──────────────────────────────────────────────────────

	/** Capture the pre-turn baseline once per review cycle. */
	private maybeCaptureBaseline(): void {
		if (!this.reviewEnabled || this.reviewModel.hasCycle()) return;
		const tree = captureTree(this.reviewRoot);
		if (tree) this.reviewModel.beginCycle(tree);
	}

	/** Recompute the pending-review set from the baseline, push baseline content
	 * to the review surface, and publish. When nothing remains pending (all
	 * reverted or accepted), end the cycle so the next edit re-baselines. */
	private async refreshReview(): Promise<void> {
		if (!this.reviewEnabled) return;
		const ref = this.reviewModel.baselineRef();
		if (!ref) {
			this.publishReview([]);
			return;
		}
		const changed = changedFiles(this.reviewRoot, ref);
		const pending = this.reviewModel.pending(changed);
		for (const f of pending) {
			this.reviewUi.setBaseline(f.path, baselineContent(this.reviewRoot, ref, f.path));
		}
		this.reviewUi.setPending(pending);
		this.publishReview(pending);
		if (pending.length === 0) {
			this.reviewModel.reset();
			this.reviewUi.clear();
		}
	}

	private publishReview(files: ReviewFileDto[]): void {
		this.reviewState = { enabled: this.reviewEnabled, files };
		this.emit({ kind: "review", review: this.reviewState });
	}

	/** Open the baseline↔current diff for a reviewed file. Fire-and-forget from
	 * the bridge, so guard the async `vscode.diff` call and surface a notice
	 * instead of leaking an unhandled rejection (mirrors `openSource`). */
	async reviewOpenDiff(path: string): Promise<void> {
		try {
			await this.reviewUi.openDiff(path);
		} catch (err) {
			this.emitNotice(`Couldn't open the diff for ${path}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Open a code reference the user clicked in an answer (Phase 5b). The
	 * adapter is best-effort and non-throwing, but guard here too so an
	 * unexpected failure surfaces a notice instead of an unhandled rejection
	 * (the bridge calls this fire-and-forget). */
	async openSource(ref: OpenSourceRef): Promise<void> {
		try {
			await this.sourceLinkUi.openSource(ref);
		} catch (err) {
			this.emitNotice(`Couldn't open the reference: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ── Session tree: fork + restore checkpoint (Phase 6) ──────────────────

	/** Fork a new branch from a session entry. A user-message fork returns re-ask
	 * text that pre-fills the composer; an assistant fork returns "" (continue
	 * from that answer) and must not clobber the composer. Rebuilds the transcript
	 * to the forked branch. Fire-and-forget from the bridge, so guard throws into
	 * a notice. */
	async fork(entryId: string): Promise<void> {
		if (!this.client) return;
		let result: { text: string; cancelled: boolean };
		try {
			result = await this.client.fork(entryId);
		} catch (err) {
			// The backend fork failed, so the leaf never moved — the current
			// transcript is still valid. Just surface a notice; do NOT reset.
			this.emitNotice(`Couldn't fork: ${errorText(err)}`);
			return;
		}
		if (result.cancelled) {
			this.emitNotice("Fork cancelled — no new branch was created.");
			return;
		}
		try {
			await this.rebuildTranscript();
		} catch (err) {
			// The backend already moved to the new branch, but the reload failed.
			// Leaving the old transcript up would render a stale, wrong-branch
			// conversation over a backend that has switched. Reset to a clean state
			// (also clears checkpoints) and resync — parity with the resume guard —
			// so the webview never shows the wrong branch.
			this.logger(`fork transcript rebuild failed: ${errorText(err)}`);
			this.resetTranscriptState();
			this.emitNotice(
				"Forked, but the chat couldn't reload — the new branch is saved and will show when you reopen the chat.",
			);
			this.emit({ kind: "resync" });
			return;
		}
		// Only user (re-ask) forks return text; assistant forks return "" and
		// must not clobber whatever the user has already typed.
		if (result.text.length > 0) this.emit({ kind: "composer-prefill", text: result.text });
	}

	/** Restore (navigate) the session to a tree entry — a linear rewind or a
	 * branch-jump. Rebuilds the transcript to the target leaf. */
	async navigateTree(entryId: string): Promise<void> {
		if (!this.client) return;
		let result: { cancelled: boolean; editorText?: string };
		try {
			result = await this.client.navigateTree(entryId);
		} catch (err) {
			// The backend navigation failed, so the leaf never moved — the current
			// transcript is still valid. Just surface a notice; do NOT reset.
			this.emitNotice(`Couldn't restore the checkpoint: ${errorText(err)}`);
			return;
		}
		if (result.cancelled) {
			this.emitNotice("Restore cancelled.");
			return;
		}
		try {
			await this.rebuildTranscript();
		} catch (err) {
			// The backend already moved to the restored leaf, but the reload failed.
			// Reset + resync (parity with the resume guard) so the webview never
			// keeps rendering the pre-restore branch over a backend that has moved.
			this.logger(`restore transcript rebuild failed: ${errorText(err)}`);
			this.resetTranscriptState();
			this.emitNotice(
				"Restored, but the chat couldn't reload — the restored point is saved and will show when you reopen the chat.",
			);
			this.emit({ kind: "resync" });
		}
	}

	/** Fetch the session branch tree and emit it for the branch-tree view. */
	async requestTree(): Promise<void> {
		if (!this.client) return;
		try {
			const tree = await this.client.getTree();
			this.emit({ kind: "tree", tree: { roots: tree.roots, leafId: tree.leafId } });
		} catch (err) {
			this.emitNotice(`Couldn't load the session tree: ${errorText(err)}`);
		}
	}

	/** Rebuild the transcript from the current session branch (after a restore or
	 * fork moved the leaf, or on resume), realign checkpoints, and resync the
	 * webview. Uses the branch's full provider messages (`get_messages`) so answers,
	 * thinking, and tool activity are reconstructed into the same response-group
	 * model the live event stream builds — the rebuilt chat renders like a fresh
	 * one. Checkpoints key to the tree's run-terminal assistant entries. */
	private async rebuildTranscript(): Promise<void> {
		if (!this.client) return;
		const messages = await this.client.getMessages();
		const tree = await this.client.getTree();
		foldMessagesIntoState(this.state, messages);
		const branch = currentBranch(tree.roots, tree.leafId);
		this.checkpoints = alignCheckpoints(this.state, branch.runTerminalEntryIds, await this.forkableEntryIds());
		await this.refreshStatus(true);
		this.emit({ kind: "resync" });
		this.emit({ kind: "checkpoints", checkpoints: this.checkpoints });
	}

	/** Recompute inline restore/fork controls for the current (event-built)
	 * transcript. Runs after each completed turn so the controls attach to the
	 * right entry. Best-effort: a tree fetch failure leaves the last controls in
	 * place rather than surfacing a notice. */
	private async refreshCheckpoints(): Promise<void> {
		if (!this.client) return;
		try {
			const tree = await this.client.getTree();
			const branch = currentBranch(tree.roots, tree.leafId);
			this.checkpoints = alignCheckpoints(this.state, branch.runTerminalEntryIds, await this.forkableEntryIds());
			this.emit({ kind: "checkpoints", checkpoints: this.checkpoints });
		} catch (err) {
			this.logger(`checkpoint refresh failed: ${errorText(err)}`);
		}
	}

	/** The set of session entry ids the backend will fork from, used to gate the
	 * inline Fork control (via {@link alignCheckpoints}). Best-effort: on failure
	 * returns an empty set, which hides Fork rather than showing a control that
	 * would only produce a "Couldn't fork…" notice. */
	private async forkableEntryIds(): Promise<ReadonlySet<string>> {
		if (!this.client) return new Set();
		try {
			const messages = await this.client.getForkMessages();
			return new Set(messages.map((m) => m.entryId));
		} catch (err) {
			this.logger(`fork-messages fetch failed: ${errorText(err)}`);
			return new Set();
		}
	}

	/** Accept a single file (clear its review marker; no commit). */
	async reviewAcceptFile(path: string): Promise<void> {
		this.reviewModel.accept(path);
		await this.refreshReview();
	}

	/** Accept every pending change at once (clear the cycle; no commit). */
	async reviewAcceptAll(): Promise<void> {
		this.reviewModel.reset();
		this.reviewUi.clear();
		this.publishReview([]);
	}

	/** Revert a whole file to its baseline content, discarding the turn's edits. */
	async reviewRevertFile(path: string): Promise<void> {
		const ref = this.reviewModel.baselineRef();
		if (!ref) return;
		const ok = revertFile(this.reviewRoot, ref, path);
		if (ok) this.reviewModel.unaccept(path);
		else this.emitNotice(`Could not revert ${path}.`);
		// refreshReview recomputes from the working tree, so a file that failed to
		// revert stays listed rather than being silently dropped.
		await this.refreshReview();
	}

	/** Revert every pending file to baseline, then end the cycle. Files that fail
	 * to revert remain pending (surfaced via `refreshReview`) and are reported,
	 * rather than being silently cleared while their edits persist on disk. */
	async reviewRevertAll(): Promise<void> {
		const ref = this.reviewModel.baselineRef();
		if (!ref) return;
		const failures: string[] = [];
		for (const f of this.reviewState.files) {
			if (revertFile(this.reviewRoot, ref, f.path)) this.reviewModel.unaccept(f.path);
			else failures.push(f.path);
		}
		if (failures.length > 0) {
			const noun = failures.length === 1 ? "file" : "files";
			this.emitNotice(`Could not revert ${failures.length} ${noun}: ${failures.join(", ")}`);
		}
		await this.refreshReview();
	}

	/** Reject exactly the hunk containing `line` (1-based, in the current file)
	 * — the non-interactive equivalent of `git restore -p`. Returns true when a
	 * hunk was found and reverted. */
	async reviewRejectHunkAtLine(path: string, line: number): Promise<boolean> {
		const ref = this.reviewModel.baselineRef();
		if (!ref) return false;
		const { diff, binary } = fileDiff(this.reviewRoot, ref, path);
		if (binary || diff.length === 0) return false;
		const index = hunkIndexForLine(parseFileDiff(diff).hunks, line);
		if (index === undefined) return false;
		const ok = revertHunk(this.reviewRoot, ref, path, index);
		await this.refreshReview();
		return ok;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.clearRestartTimer();
		this.clearStableTimer();
		this.unsubEvent?.();
		this.unsubExit?.();
		this.listeners.clear();
		try {
			await this.client?.stop();
		} catch (err) {
			this.logger(`stop failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Whether this controller has been torn down (e.g. via `/quit`). A disposed
	 * controller cannot be restarted; the host must build a fresh one. */
	isDisposed(): boolean {
		return this.disposed;
	}

	/** Whether the RPC child is gone / unusable while the controller itself is
	 * still live (an unexpected child exit, a failed `start()` handshake, or a
	 * fatal like CLI-not-found). Distinguished from a brand-new session that is
	 * merely still starting (no error yet) and from a `/quit`-ended session
	 * (`disposed`). The host treats a failed controller as not-reusable so
	 * reopening rebuilds a fresh child resuming from the persisted transcript
	 * instead of revealing a dead panel. */
	hasFailed(): boolean {
		return !this.disposed && !this.status.connected && this.status.error !== undefined;
	}

	private handleEvent(event: unknown): void {
		applyEvent(this.state, event);
		this.emit({ kind: "event", event });
		const type = (event as { type?: unknown })?.type;
		// Snapshot a baseline before the first turn of a review cycle (changes
		// then compound against it until accepted/reverted).
		if (type === "turn_start") this.maybeCaptureBaseline();
		// Keep the queued-message chips in sync with the RPC child's queue:
		// a run starting/ending changes what's still pending, and a steered
		// user message delivered mid-run drops out of the queue.
		if (type === "agent_start" || type === "agent_end") void this.refreshPending();
		else if (type === "message_start" && (event as { message?: { role?: string } }).message?.role === "user") {
			void this.refreshPending();
		}
		// After each completed turn, refresh runtime status (cost/context/model)
		// the way the dashboard does on the streaming→idle transition, and
		// recompute the change-review set from the baseline.
		if (type === "agent_end") {
			// A completed turn proves the child is alive and processing, so treat it
			// as a stable run: clear the crash-recovery budget.
			this.restartTimestamps = [];
			this.clearStableTimer();
			void this.refreshStatus(true);
			void this.refreshReview();
			void this.refreshCheckpoints();
		}
	}

	private handleExit(info: { code?: number | null; signal?: string | null; error?: Error; stderr?: string }): void {
		if (this.disposed) return;
		const message = formatExit(info);
		// Surface the child's captured stderr (deliverable B) so a late crash's
		// trigger is recorded for diagnosis instead of being discarded.
		const stderr = info.stderr?.trim();
		if (stderr) this.logger(`RPC child exited (${message}); stderr:\n${stderr}`);
		else this.logger(`RPC child exited (${message})`);
		// Drop the dead client + its stale listeners before attempting recovery so
		// a leftover handler can't fire against the old process.
		this.teardownClient();
		// Automated in-place recovery (deliverable C): auto-restart from the
		// persisted transcript, bounded by a crash-loop budget.
		this.beginRecovery(message);
	}

	/** Tear down the current client's subscriptions and drop the reference. The
	 * child is presumed already gone (called from the exit path), but stop() is
	 * still invoked best-effort to release any client-side resources. */
	private teardownClient(): void {
		this.unsubEvent?.();
		this.unsubExit?.();
		this.unsubEvent = undefined;
		this.unsubExit = undefined;
		const dead = this.client;
		this.client = undefined;
		void Promise.resolve(dead?.stop()).catch(() => {});
	}

	/** Decide whether to auto-restart the crashed child (bounded) or give up with
	 * a persistent banner. Called on an unexpected exit and on a failed restart. */
	private beginRecovery(reason: string): void {
		if (this.disposed) return;
		if (!this.withinRestartBudget()) {
			this.giveUpRecovery(reason);
			return;
		}
		this.recordRestartAttempt();
		// Clear the error so `hasFailed()` stays false and the host doesn't tear
		// this controller down mid-recovery; show a transient notice rather than a
		// fatal banner.
		this.setStatus({ ...this.status, connected: false, error: undefined });
		this.emitNotice(RECOVERING_NOTICE);
		this.clearRestartTimer();
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined;
			void this.restart(reason);
		}, RESTART_BACKOFF_MS);
		this.restartTimer.unref?.();
	}

	/** Auto-restart the RPC child in place, resuming from the live session file so
	 * the persisted transcript is reloaded losslessly. All controller-lifetime
	 * listeners and the connected webview bridge stay attached. */
	private async restart(reason: string): Promise<void> {
		if (this.disposed) return;
		// Resume from the live session file (falls back to the original resume
		// path for a session that never wrote an entry before crashing).
		this.resumePath = this.sessionPath;
		try {
			await this.start();
		} catch {
			// start() already surfaced its own failure status; route the failed
			// attempt back through the bounded policy (retry or give up).
			this.beginRecovery(reason);
			return;
		}
		// Connected again. Arm a stable-run reset so a child that survives long
		// enough clears the crash budget and a *later* isolated crash still gets a
		// fresh recovery allowance.
		this.armStableRunReset();
	}

	/** Terminal recovery state: repeated crashes within the window. Surface a
	 * persistent, actionable banner. */
	private giveUpRecovery(reason: string): void {
		const banner = `${reason} — automatic recovery failed after repeated crashes. Reopen the chat to restart.`;
		this.setStatus({ ...this.status, connected: false, error: banner });
		this.handleEvent({ type: "host_error", message: banner });
	}

	/** True while the rolling window still has restart budget left. Prunes stale
	 * attempts so the budget refills once the window passes. */
	private withinRestartBudget(): boolean {
		const now = Date.now();
		this.restartTimestamps = this.restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS);
		return this.restartTimestamps.length < RESTART_MAX_IN_WINDOW;
	}

	private recordRestartAttempt(): void {
		this.restartTimestamps.push(Date.now());
	}

	private armStableRunReset(): void {
		this.clearStableTimer();
		this.stableTimer = setTimeout(() => {
			this.stableTimer = undefined;
			this.restartTimestamps = [];
		}, RESTART_STABLE_MS);
		this.stableTimer.unref?.();
	}

	private clearRestartTimer(): void {
		if (this.restartTimer !== undefined) {
			clearTimeout(this.restartTimer);
			this.restartTimer = undefined;
		}
	}

	private clearStableTimer(): void {
		if (this.stableTimer !== undefined) {
			clearTimeout(this.stableTimer);
			this.stableTimer = undefined;
		}
	}

	private emitNotice(message: string): void {
		this.handleEvent({ type: "host_notice", message });
	}

	private setStatus(status: HostStatus): void {
		this.status = status;
		this.emit({ kind: "status", status });
	}

	private emit(update: ControllerUpdate): void {
		for (const listener of this.listeners) {
			try {
				listener(update);
			} catch (err) {
				this.logger(`update listener failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
}
