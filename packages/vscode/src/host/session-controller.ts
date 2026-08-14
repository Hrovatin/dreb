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

import { formatSessionStats } from "../shared/format.js";
import {
	alignCheckpoints,
	applyEvent,
	type BranchTurn,
	type Checkpoint,
	createTranscriptState,
	foldBranchIntoState,
	type TranscriptState,
} from "../shared/projection.js";
import type {
	HostStatus,
	OpenSourceRef,
	ReviewFileDto,
	ReviewStateDto,
	SessionTreeDto,
	SessionTreeNodeDto,
	SlashCommandDto,
	TaggedContextDto,
	UiResponse,
} from "../shared/protocol.js";
import { deriveSessionStatus, type SessionRunState } from "../shared/session-list.js";
import { buildFileContext, buildPromptWithContext } from "../shared/tagged-context.js";
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
	abort(): Promise<void>;
	compact(customInstructions?: string): Promise<unknown>;
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
	/** Navigate (restore/branch-jump) the session leaf to a tree entry. */
	navigateTree(targetId: string): Promise<{ cancelled: boolean; editorText?: string }>;
	/** The session branch tree plus the current leaf. */
	getTree(): Promise<{ roots: SessionTreeNodeDto[]; leafId: string | null }>;
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
	/** An editor selection was tagged into the chat (Phase 4). */
	| { kind: "tag-context"; context: TaggedContextDto }
	/** Inline restore/fork controls were recomputed (Phase 6). */
	| { kind: "checkpoints"; checkpoints: Checkpoint[] }
	/** The session branch tree, in response to a `show-tree` request (Phase 6). */
	| { kind: "tree"; tree: SessionTreeDto }
	/** Pre-fill the composer (a user-message fork's re-ask text) (Phase 6). */
	| { kind: "composer-prefill"; text: string }
	/** Transcript was replaced host-side (e.g. `/new`, `/import`); the bridge
	 * re-sends a fresh snapshot. */
	| { kind: "resync" };

/** Lazily loads the ESM-only agent runtime so tests with an injected factory
 * never pull it in. */
const defaultClientFactory: RpcClientFactory = async (options) => {
	const { RpcClient } = await import("@dreb/coding-agent/rpc");
	return new RpcClient({ cliPath: options.cliPath, cwd: options.cwd, args: options.args });
};

function formatExit(info: { code?: number | null; signal?: string | null; error?: Error }): string {
	if (info?.error) return `dreb process failed: ${info.error.message}`;
	return `dreb process exited (code ${info?.code ?? "null"}, signal ${info?.signal ?? "null"})`;
}

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

/** Reduce a session tree to the current branch (root → leaf): the ordered
 * user/assistant turns (preview text) plus the assistant entry ids on that
 * branch. Non-message entries (labels, tool results) are skipped. Returns empty
 * when there is no leaf (fresh/empty session). */
function currentBranch(
	roots: SessionTreeNodeDto[],
	leafId: string | null,
): { turns: BranchTurn[]; assistantEntryIds: string[] } {
	const path = leafId ? findPath(roots, leafId) : [];
	const turns: BranchTurn[] = [];
	const assistantEntryIds: string[] = [];
	for (const node of path) {
		if (node.type !== "message") continue;
		if (node.role === "user") {
			turns.push({ entryId: node.id, role: "user", text: node.preview });
		} else if (node.role === "assistant") {
			turns.push({ entryId: node.id, role: "assistant", text: node.preview });
			assistantEntryIds.push(node.id);
		}
	}
	return { turns, assistantEntryIds };
}

export class SessionController {
	private readonly state: TranscriptState = createTranscriptState();
	private readonly listeners = new Set<(update: ControllerUpdate) => void>();
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
	private readonly logger: (line: string) => void;
	private readonly options: SessionControllerOptions;
	private client: RpcClientLike | undefined;
	private sessionFile: string | undefined;
	private commands: SlashCommandDto[] = [...BUILTIN_COMMANDS];
	private status: HostStatus;
	private unsubEvent: (() => void) | undefined;
	private unsubExit: (() => void) | undefined;
	private disposed = false;
	/** Serializes status refreshes: coalesces an overlapping request into one
	 * trailing re-run so a new turn starting mid-refresh still ends up current.
	 * `statusAgainIncludeDaily` accumulates the daily-cost intent of every
	 * coalesced caller so the trailing re-run doesn't drop a requested daily
	 * refresh (e.g. an `agent_end` refresh coalesced into a cheaper one). */
	private statusBusy = false;
	private statusAgain = false;
	private statusAgainIncludeDaily = false;

	constructor(options: SessionControllerOptions) {
		this.options = options;
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

	getCommandList(): SlashCommandDto[] {
		return this.commands;
	}

	onUpdate(listener: (update: ControllerUpdate) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Spawn the RPC child, wire event/exit handlers, and prime the command list. */
	async start(): Promise<void> {
		if (this.disposed) throw new Error("SessionController is disposed");
		const args = [
			...(this.options.args ?? []),
			...(this.options.sessionPath ? ["--session", this.options.sessionPath] : []),
		];
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
	async submit(text: string, attachments?: TaggedContextDto[]): Promise<void> {
		if (!this.client || !this.status.connected) {
			this.emitNotice(
				this.status.error
					? "dreb isn't connected — reopen the chat to restart it."
					: "dreb is still starting up — try again in a moment.",
			);
			return;
		}
		const decision = routeInput(text, this.commands);
		// An attachment-only submit (chips attached, no typed text) is deliberately
		// allowed by the composer; with no attachments there is genuinely nothing
		// to send, so short-circuit only then.
		if (decision.kind === "empty" && (!attachments || attachments.length === 0)) return;
		try {
			switch (decision.kind) {
				case "empty":
					// Reached only with attachments present (see guard above): send the
					// folded context so a chips-only submit isn't silently dropped.
					await this.client.prompt(buildPromptWithContext(text, attachments));
					return;
				case "prompt":
					// Fold any tagged editor selections into the prompt as located
					// context (attachments only apply to prompts, not slash builtins).
					await this.client.prompt(buildPromptWithContext(decision.message, attachments));
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

	async abort(): Promise<void> {
		if (!this.client || !this.status.connected) return;
		try {
			await this.client.abort();
		} catch (err) {
			this.logger(`abort failed: ${err instanceof Error ? err.message : String(err)}`);
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

	/** Clear the transcript in place (properties, not the reference) so `/new`
	 * and `/import` present a fresh conversation after a `resync`. */
	private resetTranscriptState(): void {
		this.state.items = [];
		this.state.streaming = false;
		this.state.uiRequests = [];
		this.state.statusText = undefined;
		this.state.hostError = undefined;
		this.state.nextResponseId = 1;
		// Drop the prior session's checkpoints so a new/imported session doesn't
		// render stale Restore/Fork controls on its first turn (the new session's
		// first response group reuses id 1 and would otherwise match a stale
		// `{responseId: 1}`). The subsequent `resync` re-posts this empty array.
		this.checkpoints = [];
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
		this.client?.sendExtensionUIResponse({ type: "extension_ui_response", ...response });
	}

	/** Tag an editor selection into the chat (Phase 4). Emits an update the
	 * bridge forwards to the webview as a removable composer chip (queued until
	 * the webview is live, so tagging into a freshly opened chat still lands). */
	tagContext(context: TaggedContextDto): void {
		this.emit({ kind: "tag-context", context });
	}

	/** Open the native file/folder picker and tag each chosen path into the chat
	 * as a path-reference chip (Phase 4b). No-ops when the picker is dismissed.
	 * Mirrors `pickModel()`: the vscode picker is injected via the `HostUi` port,
	 * so this method stays vscode-free and unit-testable. */
	async tagFileFromPicker(): Promise<void> {
		const picks = await this.ui.pickWorkspaceFiles();
		if (!picks) return;
		for (const pick of picks) {
			this.tagContext(buildFileContext({ fsPath: pick.fsPath, cwd: this.cwd, isDirectory: pick.isDirectory }));
		}
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

	/** Open the baseline↔current diff for a reviewed file. */
	async reviewOpenDiff(path: string): Promise<void> {
		await this.reviewUi.openDiff(path);
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
		try {
			const result = await this.client.fork(entryId);
			if (result.cancelled) {
				this.emitNotice("Fork cancelled — no new branch was created.");
				return;
			}
			await this.rebuildTranscript();
			// Only user (re-ask) forks return text; assistant forks return "" and
			// must not clobber whatever the user has already typed.
			if (result.text.length > 0) this.emit({ kind: "composer-prefill", text: result.text });
		} catch (err) {
			this.emitNotice(`Couldn't fork: ${errorText(err)}`);
		}
	}

	/** Restore (navigate) the session to a tree entry — a linear rewind or a
	 * branch-jump. Rebuilds the transcript to the target leaf. */
	async navigateTree(entryId: string): Promise<void> {
		if (!this.client) return;
		try {
			const result = await this.client.navigateTree(entryId);
			if (result.cancelled) {
				this.emitNotice("Restore cancelled.");
				return;
			}
			await this.rebuildTranscript();
		} catch (err) {
			this.emitNotice(`Couldn't restore the checkpoint: ${errorText(err)}`);
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
	 * fork moved the leaf), realign checkpoints, and resync the webview. Turn text
	 * uses the tree's per-entry previews — historical full text and tool activity
	 * are not reconstructed (MVP). */
	private async rebuildTranscript(): Promise<void> {
		if (!this.client) return;
		const tree = await this.client.getTree();
		const branch = currentBranch(tree.roots, tree.leafId);
		foldBranchIntoState(this.state, branch.turns);
		this.checkpoints = alignCheckpoints(this.state, branch.assistantEntryIds);
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
			this.checkpoints = alignCheckpoints(this.state, branch.assistantEntryIds);
			this.emit({ kind: "checkpoints", checkpoints: this.checkpoints });
		} catch (err) {
			this.logger(`checkpoint refresh failed: ${errorText(err)}`);
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

	private handleEvent(event: unknown): void {
		applyEvent(this.state, event);
		this.emit({ kind: "event", event });
		const type = (event as { type?: unknown })?.type;
		// Snapshot a baseline before the first turn of a review cycle (changes
		// then compound against it until accepted/reverted).
		if (type === "turn_start") this.maybeCaptureBaseline();
		// After each completed turn, refresh runtime status (cost/context/model)
		// the way the dashboard does on the streaming→idle transition, and
		// recompute the change-review set from the baseline.
		if (type === "agent_end") {
			void this.refreshStatus(true);
			void this.refreshReview();
			void this.refreshCheckpoints();
		}
	}

	private handleExit(info: { code?: number | null; signal?: string | null; error?: Error }): void {
		if (this.disposed) return;
		const message = formatExit(info);
		this.setStatus({ ...this.status, connected: false, error: message });
		this.handleEvent({ type: "host_error", message });
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
