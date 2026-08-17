import { describe, expect, it } from "vitest";
import type { HostUi, HostUiPickItem, WorkspaceSearchResult } from "../src/host/host-ui.js";
import { type ControllerUpdate, type RpcClientLike, SessionController } from "../src/host/session-controller.js";
import type { SourceLinkUi } from "../src/host/source-link-ui.js";
import type { OpenSourceRef, SessionTreeNodeDto } from "../src/shared/protocol.js";

/** Fake RpcClient that captures calls and lets a test drive events/exit. */
class FakeClient implements RpcClientLike {
	started = false;
	stopped = 0;
	aborted = 0;
	prompts: string[] = [];
	compactions: Array<string | undefined> = [];
	uiResponses: unknown[] = [];
	commandsResult: Array<{
		name: string;
		description?: string;
		source: "extension" | "prompt" | "skill" | "builtin";
		dashboard?: boolean;
	}> = [];
	startError: Error | undefined;
	/** When set, the next prompt/compact/abort/builtin call rejects with this error. */
	callError: Error | undefined;
	/** When set, only the transcript-rebuild RPCs (`getMessages`/`getTree`) reject —
	 * simulating a backend fork/navigate that succeeds while the reload fails. */
	rebuildError: Error | undefined;

	// Runtime status.
	state: {
		model?: { provider: string; id: string; name?: string };
		thinkingLevel?: string;
		askModeEnabled?: boolean;
		usingSubscription?: boolean;
		contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
		sessionFile?: string;
	} = {};
	dailyCost = 0;
	stats: {
		sessionId?: string;
		cost?: number;
		totalMessages?: number;
		tokens?: { input?: number; output?: number; total?: number };
		contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
	} = { cost: 0 };
	getStateCalls = 0;
	dailyCostCalls = 0;
	/** Optional gate: when set, `getState` blocks until `releaseState()` is
	 * called, letting a test hold a refreshStatus() in flight and interleave a
	 * second (coalesced) refresh before the first resolves. */
	private stateGate: Promise<void> | undefined;
	private stateGateResolve: (() => void) | undefined;
	blockState(): void {
		this.stateGate = new Promise<void>((resolve) => {
			this.stateGateResolve = resolve;
		});
	}
	releaseState(): void {
		this.stateGateResolve?.();
		this.stateGate = undefined;
		this.stateGateResolve = undefined;
	}

	// Model / thinking.
	availableModels: Array<{ provider: string; id: string; name?: string }> = [];
	setModelCalls: Array<{ provider: string; modelId: string }> = [];
	thinkingLevels: string[] = [];

	// Builtins.
	newSessions = 0;
	newSessionResult: { cancelled: boolean } = { cancelled: false };
	reloads = 0;
	dreams: Array<string | undefined> = [];
	dreamResult: { message: string } = { message: "dreamt" };
	names: string[] = [];
	exports: Array<string | undefined> = [];
	imports: string[] = [];
	importResult: { cancelled: boolean } = { cancelled: false };
	// Session tree / fork (Phase 6).
	forkCalls: string[] = [];
	forkResult: { text: string; cancelled: boolean } = { text: "", cancelled: false };
	navigateCalls: string[] = [];
	navigateResult: { cancelled: boolean; editorText?: string } = { cancelled: false };
	treeCalls = 0;
	treeResult: { roots: SessionTreeNodeDto[]; leafId: string | null } = { roots: [], leafId: null };
	forkMessagesCalls = 0;
	/** When set, `getForkMessages` returns this verbatim; otherwise it derives
	 * "every assistant entry in the tree is forkable" from `treeResult`. */
	forkMessagesOverride: Array<{ entryId: string; text: string; role: "user" | "assistant" }> | undefined;
	/** When set, `getForkMessages` throws this — independent of the blanket
	 * `callError` — so a get_fork_messages-only failure (e.g. an older/partial
	 * backend) can be exercised while `getTree`/`fork`/`navigateTree` still succeed. */
	forkMessagesError: Error | undefined;

	private eventListener: ((event: any) => void) | undefined;
	private exitListener: ((info: any) => void) | undefined;

	async start(): Promise<void> {
		if (this.startError) throw this.startError;
		this.started = true;
	}
	async stop(): Promise<void> {
		this.stopped += 1;
	}
	async prompt(message: string): Promise<void> {
		if (this.callError) throw this.callError;
		this.prompts.push(message);
	}
	async abort(): Promise<void> {
		if (this.callError) throw this.callError;
		this.aborted += 1;
	}
	// Queued messages (steer/follow-up). `steer`/`followUp` mirror the backend by
	// both recording the call and appending to the pending queue that
	// `getPendingMessages` reports and `clearPendingMessages` drains.
	steers: string[] = [];
	followUps: string[] = [];
	pendingSteering: string[] = [];
	pendingFollowUp: string[] = [];
	clearPendingCalls = 0;
	async steer(message: string): Promise<void> {
		if (this.callError) throw this.callError;
		this.steers.push(message);
		this.pendingSteering.push(message);
	}
	async followUp(message: string): Promise<void> {
		if (this.callError) throw this.callError;
		this.followUps.push(message);
		this.pendingFollowUp.push(message);
	}
	async getPendingMessages(): Promise<{ steering: string[]; followUp: string[] }> {
		return { steering: [...this.pendingSteering], followUp: [...this.pendingFollowUp] };
	}
	async clearPendingMessages(): Promise<{ steering: string[]; followUp: string[] }> {
		this.clearPendingCalls += 1;
		const cleared = { steering: [...this.pendingSteering], followUp: [...this.pendingFollowUp] };
		this.pendingSteering = [];
		this.pendingFollowUp = [];
		return cleared;
	}
	async compact(customInstructions?: string): Promise<unknown> {
		if (this.callError) throw this.callError;
		this.compactions.push(customInstructions);
		return {};
	}
	// Ask mode (read-only). Tracks each requested value; mirrors the RPC verb by
	// updating `state.askModeEnabled` and returning the resulting state.
	askModeCalls: boolean[] = [];
	async setAskMode(enabled: boolean): Promise<{ enabled: boolean }> {
		if (this.callError) throw this.callError;
		this.askModeCalls.push(enabled);
		this.state.askModeEnabled = enabled;
		return { enabled };
	}
	async getCommands() {
		return this.commandsResult;
	}
	sendExtensionUIResponse(response: unknown): void {
		this.uiResponses.push(response);
	}
	onEvent(listener: (event: any) => void): () => void {
		this.eventListener = listener;
		return () => {
			this.eventListener = undefined;
		};
	}
	onExit(listener: (info: any) => void): () => void {
		this.exitListener = listener;
		return () => {
			this.exitListener = undefined;
		};
	}
	async getState() {
		this.getStateCalls += 1;
		if (this.stateGate) await this.stateGate;
		return this.state;
	}
	async getDailyCost(): Promise<number> {
		this.dailyCostCalls += 1;
		return this.dailyCost;
	}
	async getSessionStats() {
		return this.stats;
	}
	async getAvailableModels() {
		return this.availableModels;
	}
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		if (this.callError) throw this.callError;
		this.setModelCalls.push({ provider, modelId });
		return { provider, id: modelId };
	}
	async setThinkingLevel(level: string): Promise<void> {
		if (this.callError) throw this.callError;
		this.thinkingLevels.push(level);
	}
	async newSession(): Promise<{ cancelled: boolean }> {
		if (this.callError) throw this.callError;
		this.newSessions += 1;
		return this.newSessionResult;
	}
	async reload(): Promise<void> {
		if (this.callError) throw this.callError;
		this.reloads += 1;
	}
	async dream(args?: string): Promise<{ message: string }> {
		if (this.callError) throw this.callError;
		this.dreams.push(args);
		return this.dreamResult;
	}
	async setSessionName(name: string): Promise<void> {
		if (this.callError) throw this.callError;
		this.names.push(name);
	}
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		if (this.callError) throw this.callError;
		this.exports.push(outputPath);
		return { path: outputPath ?? "/tmp/session.html" };
	}
	async importJsonl(inputPath: string): Promise<{ cancelled: boolean }> {
		if (this.callError) throw this.callError;
		this.imports.push(inputPath);
		return this.importResult;
	}
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		if (this.callError) throw this.callError;
		this.forkCalls.push(entryId);
		return this.forkResult;
	}
	async navigateTree(targetId: string): Promise<{ cancelled: boolean; editorText?: string }> {
		if (this.callError) throw this.callError;
		this.navigateCalls.push(targetId);
		return this.navigateResult;
	}
	async getTree(): Promise<{ roots: SessionTreeNodeDto[]; leafId: string | null }> {
		if (this.rebuildError) throw this.rebuildError;
		if (this.callError) throw this.callError;
		this.treeCalls += 1;
		return this.treeResult;
	}
	async getForkMessages(): Promise<Array<{ entryId: string; text: string; role: "user" | "assistant" }>> {
		if (this.forkMessagesError) throw this.forkMessagesError;
		if (this.callError) throw this.callError;
		this.forkMessagesCalls += 1;
		if (this.forkMessagesOverride) return this.forkMessagesOverride;
		// Default: every assistant entry in the current tree is forkable.
		const out: Array<{ entryId: string; text: string; role: "user" | "assistant" }> = [];
		const walk = (nodes: SessionTreeNodeDto[]): void => {
			for (const n of nodes) {
				if (n.role === "assistant") out.push({ entryId: n.id, text: n.preview, role: "assistant" });
				walk(n.children);
			}
		};
		walk(this.treeResult.roots);
		return out;
	}
	getMessagesCalls = 0;
	/** When set, `getMessages` returns this verbatim (full provider messages with
	 * text/thinking/toolCall content + paired toolResults); otherwise it derives a
	 * simple text-only message list from the current leaf branch's previews, so
	 * tests that only set `treeResult` still get a matching full-content rebuild. */
	messagesOverride: unknown[] | undefined;
	async getMessages(): Promise<unknown[]> {
		if (this.rebuildError) throw this.rebuildError;
		if (this.callError) throw this.callError;
		this.getMessagesCalls += 1;
		if (this.messagesOverride) return this.messagesOverride;
		const messages: unknown[] = [];
		for (const n of leafPath(this.treeResult.roots, this.treeResult.leafId)) {
			if (n.type !== "message") continue;
			if (n.role === "user") messages.push({ role: "user", content: n.preview });
			else if (n.role === "assistant")
				messages.push({ role: "assistant", content: [{ type: "text", text: n.preview }], stopReason: "stop" });
		}
		return messages;
	}
	emit(event: unknown): void {
		this.eventListener?.(event);
	}
	emitExit(info: unknown): void {
		this.exitListener?.(info);
	}
}

/** Fake HostUi with scripted return values. */
class FakeUi implements HostUi {
	pickItems: HostUiPickItem[] | undefined;
	pickReturn: string | undefined;
	inputReturn: string | undefined;
	saveReturn: string | undefined;
	openReturn: string | undefined;
	filesReturn: Array<{ fsPath: string; isDirectory: boolean }> | undefined;
	filesCalls = 0;
	searchReturn: WorkspaceSearchResult[] = [];
	searchQueries: string[] = [];
	async quickPick(items: HostUiPickItem[]): Promise<string | undefined> {
		this.pickItems = items;
		return this.pickReturn;
	}
	async inputBox(): Promise<string | undefined> {
		return this.inputReturn;
	}
	async saveDialog(): Promise<string | undefined> {
		return this.saveReturn;
	}
	async openDialog(): Promise<string | undefined> {
		return this.openReturn;
	}
	async pickWorkspaceFiles(): Promise<Array<{ fsPath: string; isDirectory: boolean }> | undefined> {
		this.filesCalls += 1;
		return this.filesReturn;
	}
	async searchWorkspace(query: string): Promise<WorkspaceSearchResult[]> {
		this.searchQueries.push(query);
		return this.searchReturn;
	}
}

function makeController(fake: FakeClient, opts: { cwd?: string; ui?: HostUi; sessionPath?: string } = {}) {
	return new SessionController({
		cwd: opts.cwd ?? "/tmp/project",
		cliPath: "/cli.js",
		clientFactory: () => fake,
		ui: opts.ui,
		sessionPath: opts.sessionPath,
	});
}

describe("SessionController", () => {
	it("starts the client, connects, and merges agent + builtin commands", async () => {
		const fake = new FakeClient();
		fake.commandsResult = [{ name: "/review", description: "Review", source: "prompt" }];
		const controller = makeController(fake);

		await controller.start();

		expect(fake.started).toBe(true);
		expect(controller.getStatus().connected).toBe(true);
		const names = controller.getCommandList().map((c) => c.name);
		expect(names).toContain("review"); // slash stripped, from agent
		expect(names).toContain("compact"); // builtin
	});

	it("populates runtime status (model/thinking/cost/context) on connect", async () => {
		const fake = new FakeClient();
		fake.state = {
			model: { provider: "anthropic", id: "claude", name: "Claude" },
			thinkingLevel: "medium",
			usingSubscription: false,
			contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 },
		};
		fake.stats = { cost: 0.25 };
		fake.dailyCost = 1.5;
		const controller = makeController(fake);

		await controller.start();

		const status = controller.getStatus();
		expect(status.model).toEqual({ provider: "anthropic", id: "claude", name: "Claude" });
		expect(status.thinkingLevel).toBe("medium");
		expect(status.cost).toEqual({ session: 0.25, daily: 1.5, usingSubscription: false });
		expect(status.contextUsage).toEqual({ tokens: 100, contextWindow: 1000, percent: 10 });
	});

	it("refreshes runtime status after each agent_end", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();
		const afterStart = fake.getStateCalls;

		fake.stats = { cost: 0.9 };
		fake.emit({ type: "agent_end" });
		await Promise.resolve();
		await Promise.resolve();

		expect(fake.getStateCalls).toBeGreaterThan(afterStart);
		expect(controller.getStatus().cost?.session).toBe(0.9);
	});

	it("preserves the last-known daily cost across a non-daily refresh (finding 6)", async () => {
		const fake = new FakeClient();
		fake.dailyCost = 2.5;
		const controller = makeController(fake);
		await controller.start(); // connect does a full refresh incl. daily
		expect(controller.getStatus().cost?.daily).toBe(2.5);
		const dailyCallsAfterConnect = fake.dailyCostCalls;

		// A cheaper refresh (e.g. /reload → refreshStatus(false)) must NOT refetch
		// the daily cost, and must NOT wipe the previously-known value to undefined.
		fake.dailyCost = 999; // would be wrong if refetched
		await controller.submit("/reload");

		expect(controller.getStatus().cost?.daily).toBe(2.5); // preserved, not wiped
		expect(fake.dailyCostCalls).toBe(dailyCallsAfterConnect); // not refetched
	});

	it("coalesces an overlapping refresh and honors the strongest daily intent (findings 2, 3)", async () => {
		const flush = async () => {
			for (let i = 0; i < 8; i++) await Promise.resolve();
		};
		const fake = new FakeClient();
		fake.dailyCost = 1.0;
		const controller = makeController(fake);
		await controller.start(); // daily = 1.0
		expect(controller.getStatus().cost?.daily).toBe(1.0);
		const stateCallsAfterConnect = fake.getStateCalls;
		const dailyCallsAfterConnect = fake.dailyCostCalls;

		// Hold a cheap refresh (includeDailyCost=false) in flight by gating getState.
		fake.blockState();
		fake.dailyCost = 5.0; // the value a daily-including refresh should fetch
		const reloadPromise = controller.submit("/reload"); // → refreshStatus(false), blocks
		await flush();

		// While the false-refresh is in flight, an agent_end fires a true refresh.
		// It must coalesce (not run concurrently) but its daily intent must survive.
		fake.emit({ type: "agent_end" });
		await flush();

		fake.releaseState();
		await reloadPromise;
		await flush();

		// Trailing re-run ran exactly once (finding 3 — not concurrently): one
		// getState for the in-flight false refresh + one for the trailing re-run.
		expect(fake.getStateCalls).toBe(stateCallsAfterConnect + 2);
		// The coalesced agent_end's daily intent was honored: the trailing re-run
		// fetched the fresh daily cost (finding 2 — not the false call's intent).
		expect(fake.dailyCostCalls).toBe(dailyCallsAfterConnect + 1);
		expect(controller.getStatus().cost?.daily).toBe(5.0);
	});

	it("applies events to the transcript and notifies listeners", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();

		const updates: Array<{ kind: string }> = [];
		controller.onUpdate((u) => updates.push(u));

		fake.emit({ type: "agent_start" });
		fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hi" } });
		fake.emit({ type: "agent_end" });

		const transcript = controller.getTranscript();
		expect(transcript.items.some((i) => i.kind === "response" && i.answer === "Hi")).toBe(true);
		expect(updates.filter((u) => u.kind === "event")).toHaveLength(3);
	});

	it("routes plain text to prompt and /compact to compact", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();

		await controller.submit("hello");
		await controller.submit("/compact now");

		expect(fake.prompts).toEqual(["hello"]);
		expect(fake.compactions).toEqual(["now"]);
	});

	it("/ask on and /ask off toggle read-only Ask mode over RPC", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();

		await controller.submit("/ask on");
		expect(fake.askModeCalls).toEqual([true]);
		expect(controller.getTranscript().statusText).toMatch(/Ask mode ON/);

		await controller.submit("/ask off");
		expect(fake.askModeCalls).toEqual([true, false]);
		expect(controller.getTranscript().statusText).toMatch(/Ask mode OFF/);
	});

	it("bare /ask toggles based on the current state", async () => {
		const fake = new FakeClient();
		fake.state = { askModeEnabled: false };
		const controller = makeController(fake);
		await controller.start();

		await controller.submit("/ask");
		expect(fake.askModeCalls).toEqual([true]);

		await controller.submit("/ask");
		expect(fake.askModeCalls).toEqual([true, false]);
	});

	it("/ask status reports the current state without changing it", async () => {
		const fake = new FakeClient();
		fake.state = { askModeEnabled: true };
		const controller = makeController(fake);
		await controller.start();

		await controller.submit("/ask status");
		expect(fake.askModeCalls).toEqual([]);
		expect(controller.getTranscript().statusText).toMatch(/currently ON/);
	});

	it("/ask with an invalid argument shows usage and does not toggle", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();

		await controller.submit("/ask bogus");
		expect(fake.askModeCalls).toEqual([]);
		expect(controller.getTranscript().statusText).toMatch(/Usage: \/ask/);
	});

	it("/ask on when already ON is a no-op reporting 'already ON' (terminal parity)", async () => {
		const fake = new FakeClient();
		fake.state = { askModeEnabled: true };
		const controller = makeController(fake);
		await controller.start();

		await controller.submit("/ask on");
		expect(fake.askModeCalls).toEqual([]);
		expect(controller.getTranscript().statusText).toMatch(/already ON/);
	});

	it("/ask off when already OFF is a no-op reporting 'already OFF' (terminal parity)", async () => {
		const fake = new FakeClient();
		fake.state = { askModeEnabled: false };
		const controller = makeController(fake);
		await controller.start();

		await controller.submit("/ask off");
		expect(fake.askModeCalls).toEqual([]);
		expect(controller.getTranscript().statusText).toMatch(/already OFF/);
	});

	it("/ask toggle is not a keyword — shows usage and does not toggle (terminal parity)", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();

		await controller.submit("/ask toggle");
		expect(fake.askModeCalls).toEqual([]);
		expect(controller.getTranscript().statusText).toMatch(/Usage: \/ask/);
	});

	it("folds tagged attachments into the prompt as located context", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();

		await controller.submit("explain this", [
			{
				kind: "selection",
				path: "src/a.ts",
				startLine: 5,
				endLine: 7,
				language: "typescript",
				text: "const y = 2;",
			},
		]);

		expect(fake.prompts).toEqual(["`src/a.ts` (lines 5-7):\n```typescript\nconst y = 2;\n```\n\nexplain this"]);
	});

	it("sends the folded context for an attachment-only submit (empty text)", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();

		// The composer allows sending with only chips and no typed text; the
		// context must still reach the agent rather than being silently dropped.
		await controller.submit("", [
			{
				kind: "selection",
				path: "src/a.ts",
				startLine: 5,
				endLine: 5,
				language: "typescript",
				text: "const y = 2;",
			},
		]);
		await controller.submit("   ", [
			{ kind: "selection", path: "src/b.ts", startLine: 1, endLine: 2, language: "typescript", text: "B" },
		]);

		expect(fake.prompts).toEqual([
			"`src/a.ts` (line 5):\n```typescript\nconst y = 2;\n```",
			"`src/b.ts` (lines 1-2):\n```typescript\nB\n```",
		]);
	});

	it("does not prompt on a truly empty submit (no text, no attachments)", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();

		await controller.submit("");
		await controller.submit("   ", []);

		expect(fake.prompts).toHaveLength(0);
	});

	it("ignores attachments for a slash builtin (only prompts get context)", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();

		await controller.submit("/compact tidy", [
			{ kind: "selection", path: "a.ts", startLine: 1, endLine: 1, language: "ts", text: "x" },
		]);

		expect(fake.prompts).toHaveLength(0);
		expect(fake.compactions).toEqual(["tidy"]);
	});

	it("tagContext emits a tag-context update to listeners", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();

		const updates: Array<{ kind: string }> = [];
		controller.onUpdate((u) => updates.push(u));
		const context = {
			kind: "selection" as const,
			path: "src/a.ts",
			startLine: 3,
			endLine: 5,
			language: "ts",
			text: "x",
		};
		controller.tagContext(context);

		const tag = updates.find((u) => u.kind === "tag-context") as
			| { kind: "tag-context"; context: unknown; origin?: unknown }
			| undefined;
		expect(tag?.context).toEqual(context);
		// A plain tag (editor selection) defaults to the "selection" origin so the
		// webview leaves it chip-only and does NOT insert inline reference text.
		expect(tag?.origin).toBe("selection");
	});

	it("tagFileFromPicker tags each picked file/folder as a path-reference chip", async () => {
		const fake = new FakeClient();
		const ui = new FakeUi();
		ui.filesReturn = [
			{ fsPath: "/tmp/project/src/app.ts", isDirectory: false },
			{ fsPath: "/tmp/project/src/host", isDirectory: true },
		];
		const controller = makeController(fake, { ui });
		await controller.start();

		const updates: Array<{ kind: string; context?: unknown; origin?: unknown }> = [];
		controller.onUpdate((u) => updates.push(u));
		await controller.tagFileFromPicker();

		const tagUpdates = updates.filter((u) => u.kind === "tag-context");
		expect(tagUpdates.map((u) => u.context)).toEqual([
			{ kind: "file", path: "src/app.ts" },
			{ kind: "file", path: "src/host", isDirectory: true },
		]);
		// Every picker-originated tag must carry origin "picker" — that flag is the
		// entire D3 mechanism (it tells the webview to insert an inline `@name`
		// reference). If it silently reverted to the "selection" default, `@@`
		// picks would land as chips only.
		expect(tagUpdates.map((u) => u.origin)).toEqual(["picker", "picker"]);
	});

	it("tagFileFromPicker no-ops when the picker is dismissed", async () => {
		const fake = new FakeClient();
		const ui = new FakeUi();
		ui.filesReturn = undefined; // dismissed
		const controller = makeController(fake, { ui });
		await controller.start();

		const updates: Array<{ kind: string }> = [];
		controller.onUpdate((u) => updates.push(u));
		await controller.tagFileFromPicker();

		expect(ui.filesCalls).toBe(1);
		expect(updates.some((u) => u.kind === "tag-context")).toBe(false);
	});

	it("searchWorkspace returns workspace-relative, ranked, capped file DTOs", async () => {
		const fake = new FakeClient();
		const ui = new FakeUi();
		// Deliberately unranked: the deeper path and the substring-only match must
		// sort after the filename prefix match ("app.ts").
		ui.searchReturn = [
			{ kind: "file", fsPath: "/tmp/project/src/components/wrap.ts" },
			{ kind: "file", fsPath: "/tmp/project/src/app.ts" },
		];
		const controller = makeController(fake, { ui });
		await controller.start();

		const results = await controller.searchWorkspace("app");

		expect(ui.searchQueries).toEqual(["app"]);
		expect(results).toEqual([{ kind: "file", path: "src/app.ts" }]);
	});

	it("searchWorkspace orders folders, then files, then symbols", async () => {
		const fake = new FakeClient();
		const ui = new FakeUi();
		ui.searchReturn = [
			{ kind: "symbol", name: "AppRunner", symbolKind: "class", fsPath: "/tmp/project/src/app.ts", line: 4 },
			{ kind: "file", fsPath: "/tmp/project/src/app.ts" },
			{ kind: "folder", fsPath: "/tmp/project/src/app" },
		];
		const controller = makeController(fake, { ui });
		await controller.start();

		const results = await controller.searchWorkspace("app");

		expect(results).toEqual([
			{ kind: "file", path: "src/app", isDirectory: true },
			{ kind: "file", path: "src/app.ts" },
			{ kind: "symbol", name: "AppRunner", symbolKind: "class", path: "src/app.ts", line: 4 },
		]);
	});

	it("searchWorkspace builds a workspace-relative symbol DTO from an absolute hit", async () => {
		const fake = new FakeClient();
		const ui = new FakeUi();
		ui.searchReturn = [
			{
				kind: "symbol",
				name: "handleClick",
				symbolKind: "function",
				fsPath: "/tmp/project/src/ui/button.ts",
				line: 12,
			},
		];
		const controller = makeController(fake, { ui });
		await controller.start();

		const results = await controller.searchWorkspace("handle");

		expect(results).toEqual([
			{ kind: "symbol", name: "handleClick", symbolKind: "function", path: "src/ui/button.ts", line: 12 },
		]);
	});

	it("searchWorkspace caps results to the mention limit", async () => {
		const fake = new FakeClient();
		const ui = new FakeUi();
		ui.searchReturn = Array.from({ length: 25 }, (_, i) => ({
			kind: "file" as const,
			fsPath: `/tmp/project/src/mod${i}.ts`,
		}));
		const controller = makeController(fake, { ui });
		await controller.start();

		const results = await controller.searchWorkspace("mod");

		expect(results.length).toBe(10);
		expect(results.every((r) => r.kind === "file")).toBe(true);
	});

	it("folds a file tag into the prompt as a path reference with no contents", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();

		await controller.submit("what does this do?", [
			{ kind: "file", path: "src/app.ts" },
			{ kind: "file", path: "src", isDirectory: true },
		]);

		expect(fake.prompts).toEqual(["`src/app.ts`\n\n`src/` (directory)\n\nwhat does this do?"]);
	});

	it("forwards registered agent commands through prompt", async () => {
		const fake = new FakeClient();
		fake.commandsResult = [{ name: "review", source: "prompt" }];
		const controller = makeController(fake);
		await controller.start();

		await controller.submit("/review 42");
		expect(fake.prompts).toEqual(["/review 42"]);
	});

	it("intercepts server builtins from get_commands and dispatches /new to newSession", async () => {
		// Regression: builtins advertised by get_commands (source "builtin") must
		// NOT be forwarded via prompt — the server rejects them and the rejection
		// is silently dropped. They are intercepted and dispatched to RPC.
		const fake = new FakeClient();
		fake.commandsResult = [
			{ name: "new", description: "New session", source: "builtin" },
			{ name: "copy", description: "Copy", source: "builtin", dashboard: false },
			{ name: "review", source: "extension" },
		];
		const controller = makeController(fake);
		await controller.start();

		// A dashboard-visible builtin appears in the dropdown with source "builtin".
		const knew = controller.getCommandList().find((c) => c.name === "new");
		expect(knew?.source).toBe("builtin");
		// dashboard:false builtins are hidden from the dropdown.
		expect(controller.getCommandList().some((c) => c.name === "copy")).toBe(false);

		const updates: Array<{ kind: string }> = [];
		controller.onUpdate((u) => updates.push(u));
		await controller.submit("/new");
		expect(fake.prompts).toHaveLength(0); // never forwarded to prompt
		expect(fake.newSessions).toBe(1);
		// /new resets the transcript and re-snapshots via a resync update.
		expect(updates.some((u) => u.kind === "resync")).toBe(true);
	});

	it("/new clears the transcript and starts fresh", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();
		fake.emit({ type: "message_start", message: { role: "user", content: "old" } });
		expect(controller.getTranscript().items).toHaveLength(1);

		await controller.submit("/new");

		expect(fake.newSessions).toBe(1);
		expect(controller.getTranscript().items).toHaveLength(0);
	});

	it("/reload reloads and re-emits the command list", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();
		const updates: Array<{ kind: string }> = [];
		controller.onUpdate((u) => updates.push(u));

		await controller.submit("/reload");

		expect(fake.reloads).toBe(1);
		expect(updates.some((u) => u.kind === "commands")).toBe(true);
	});

	it("/dream surfaces the returned message", async () => {
		const fake = new FakeClient();
		fake.dreamResult = { message: "merged 3 memories" };
		const controller = makeController(fake);
		await controller.start();

		await controller.submit("/dream");
		expect(fake.dreams).toEqual([undefined]);
		expect(controller.getTranscript().statusText).toBe("merged 3 memories");
	});

	it("/session appends a persistent stats line", async () => {
		const fake = new FakeClient();
		fake.stats = { sessionId: "s1", cost: 0.5, totalMessages: 4 };
		const controller = makeController(fake);
		await controller.start();

		await controller.submit("/session");
		const items = controller.getTranscript().items;
		const system = items.find((i) => i.kind === "system");
		expect(system && system.kind === "system" && system.text).toContain("Session stats");
	});

	it("/name prompts via the HostUi and calls setSessionName", async () => {
		const fake = new FakeClient();
		const ui = new FakeUi();
		ui.inputReturn = "My chat";
		const controller = makeController(fake, { ui });
		await controller.start();

		await controller.submit("/name");
		expect(fake.names).toEqual(["My chat"]);
	});

	it("/name uses an inline argument without prompting", async () => {
		const fake = new FakeClient();
		const ui = new FakeUi(); // inputReturn undefined — must not be used
		const controller = makeController(fake, { ui });
		await controller.start();

		await controller.submit("/name Inline Name");
		expect(fake.names).toEqual(["Inline Name"]);
	});

	it("/export saves via the HostUi save dialog", async () => {
		const fake = new FakeClient();
		const ui = new FakeUi();
		ui.saveReturn = "/tmp/out.html";
		const controller = makeController(fake, { ui });
		await controller.start();

		await controller.submit("/export");
		expect(fake.exports).toEqual(["/tmp/out.html"]);
	});

	it("/export does nothing when the save dialog is dismissed", async () => {
		const fake = new FakeClient();
		const ui = new FakeUi(); // saveReturn undefined
		const controller = makeController(fake, { ui });
		await controller.start();

		await controller.submit("/export");
		expect(fake.exports).toHaveLength(0);
	});

	it("/import opens via the HostUi and re-syncs the transcript", async () => {
		const fake = new FakeClient();
		const ui = new FakeUi();
		ui.openReturn = "/tmp/in.jsonl";
		const controller = makeController(fake, { ui });
		await controller.start();
		const updates: Array<{ kind: string }> = [];
		controller.onUpdate((u) => updates.push(u));

		await controller.submit("/import");
		expect(fake.imports).toEqual(["/tmp/in.jsonl"]);
		expect(updates.some((u) => u.kind === "resync")).toBe(true);
	});

	it("/quit stops the client, reports a disconnected status, and disposes idempotently", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();
		const updates: Array<{ kind: string }> = [];
		controller.onUpdate((u) => updates.push(u));

		await controller.submit("/quit");
		expect(fake.stopped).toBe(1);
		expect(controller.getStatus().connected).toBe(false);
		expect(updates.some((u) => u.kind === "status")).toBe(true);
		// The host uses isDisposed() to detect an ended session and rebuild a
		// fresh controller on reopen (finding 1 — otherwise reopen reveals a dead
		// panel). /quit must mark the controller disposed.
		expect(controller.isDisposed()).toBe(true);

		// dispose() is idempotent: a later teardown (e.g. panel close after quit)
		// must not stop the client a second time.
		await controller.dispose();
		expect(fake.stopped).toBe(1);
	});

	it("pickModel lists models, applies the choice, and refreshes status", async () => {
		const fake = new FakeClient();
		fake.availableModels = [
			{ provider: "anthropic", id: "claude", name: "Claude" },
			{ provider: "openai", id: "gpt", name: "GPT" },
		];
		fake.state = { model: { provider: "openai", id: "gpt", name: "GPT" } };
		const ui = new FakeUi();
		ui.pickReturn = "openai\u0000gpt";
		const controller = makeController(fake, { ui });
		await controller.start();
		const stateCallsBefore = fake.getStateCalls;

		await controller.pickModel();
		expect(ui.pickItems).toHaveLength(2);
		expect(fake.setModelCalls).toEqual([{ provider: "openai", modelId: "gpt" }]);
		// The mandated quickPick→setModel→refresh flow: assert the refresh ran and
		// the applied model is reflected (finding 5 — otherwise a dropped refresh
		// would go unnoticed).
		expect(fake.getStateCalls).toBeGreaterThan(stateCallsBefore);
		expect(controller.getStatus().model).toEqual({ provider: "openai", id: "gpt", name: "GPT" });
	});

	it("pickModel surfaces an RPC rejection as a bespoke notice", async () => {
		const fake = new FakeClient();
		fake.availableModels = [{ provider: "anthropic", id: "claude", name: "Claude" }];
		const ui = new FakeUi();
		ui.pickReturn = "anthropic\u0000claude";
		fake.callError = new Error("setModel boom");
		const controller = makeController(fake, { ui });
		await controller.start();

		await controller.pickModel();
		expect(controller.getTranscript().statusText).toMatch(/Model selection failed: setModel boom/);
	});

	it("pickModel does nothing when the picker is dismissed", async () => {
		const fake = new FakeClient();
		fake.availableModels = [{ provider: "anthropic", id: "claude" }];
		const ui = new FakeUi(); // pickReturn undefined
		const controller = makeController(fake, { ui });
		await controller.start();

		await controller.pickModel();
		expect(fake.setModelCalls).toHaveLength(0);
	});

	it("pickModel surfaces a notice and skips the picker when no models are available", async () => {
		const fake = new FakeClient();
		fake.availableModels = []; // none
		const ui = new FakeUi();
		const controller = makeController(fake, { ui });
		await controller.start();

		await controller.pickModel();
		expect(ui.pickItems).toBeUndefined(); // quickPick never invoked
		expect(fake.setModelCalls).toHaveLength(0);
		expect(controller.getTranscript().statusText).toMatch(/No models are available/);
	});

	it("pickThinking applies the selected level and refreshes status", async () => {
		const fake = new FakeClient();
		fake.state = { thinkingLevel: "high" };
		const ui = new FakeUi();
		ui.pickReturn = "high";
		const controller = makeController(fake, { ui });
		await controller.start();
		const stateCallsBefore = fake.getStateCalls;

		await controller.pickThinking();
		expect(fake.thinkingLevels).toEqual(["high"]);
		// Assert the refresh ran and the applied level is reflected (finding 5).
		expect(fake.getStateCalls).toBeGreaterThan(stateCallsBefore);
		expect(controller.getStatus().thinkingLevel).toBe("high");
	});

	it("pickThinking does nothing when the picker is dismissed", async () => {
		const fake = new FakeClient();
		const ui = new FakeUi(); // pickReturn undefined
		const controller = makeController(fake, { ui });
		await controller.start();

		await controller.pickThinking();
		expect(fake.thinkingLevels).toHaveLength(0);
	});

	it("pickThinking surfaces an RPC rejection as a bespoke notice", async () => {
		const fake = new FakeClient();
		const ui = new FakeUi();
		ui.pickReturn = "high";
		fake.callError = new Error("setThinking boom");
		const controller = makeController(fake, { ui });
		await controller.start();

		await controller.pickThinking();
		expect(controller.getTranscript().statusText).toMatch(/Thinking-level change failed: setThinking boom/);
	});

	it("dispatching /model opens the model picker", async () => {
		const fake = new FakeClient();
		fake.availableModels = [{ provider: "anthropic", id: "claude", name: "Claude" }];
		const ui = new FakeUi();
		ui.pickReturn = "anthropic\u0000claude";
		const controller = makeController(fake, { ui });
		await controller.start();

		await controller.submit("/model");
		expect(fake.setModelCalls).toEqual([{ provider: "anthropic", modelId: "claude" }]);
	});

	it("surfaces a 'later phase' notice for deferred builtins", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();

		await controller.submit("/fork");
		expect(fake.prompts).toHaveLength(0);
		expect(controller.getTranscript().statusText).toMatch(/later phase/);
	});

	it("surfaces a terminal-only notice for /login", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();

		await controller.submit("/login");
		expect(fake.prompts).toHaveLength(0);
		expect(controller.getTranscript().statusText).toMatch(/terminal UI/);
	});

	it("surfaces a notice when a builtin RPC call rejects", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();
		fake.callError = new Error("newSession boom");

		await controller.submit("/new");
		expect(controller.getTranscript().statusText).toMatch(/Request failed: newSession boom/);
	});

	it("blocks submits after a child crash with a reconnect notice", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();
		fake.emitExit({ code: 1, signal: null });

		await controller.submit("hello after crash");

		expect(fake.prompts).toHaveLength(0);
		expect(controller.getTranscript().statusText).toMatch(/isn't connected/);
	});

	it("surfaces a notice instead of leaking a rejected prompt call", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();
		fake.callError = new Error("stdin pipe broken");

		await expect(controller.submit("hello")).resolves.toBeUndefined();
		expect(controller.getTranscript().statusText).toMatch(/Request failed: stdin pipe broken/);
	});

	it("swallows a rejected abort without throwing", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();
		fake.callError = new Error("abort boom");

		await expect(controller.abort()).resolves.toBeUndefined();
	});

	it("forwards extension-UI responses with the wire type", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();
		controller.respondUi({ id: "u1", confirmed: true });
		expect(fake.uiResponses[0]).toEqual({ type: "extension_ui_response", id: "u1", confirmed: true });
	});

	it("surfaces a child-process crash into status and the transcript", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();

		const updates: Array<{ kind: string }> = [];
		controller.onUpdate((u) => updates.push(u));

		fake.emitExit({ code: 1, signal: null });

		expect(controller.getStatus().error).toMatch(/exited/);
		expect(controller.getTranscript().hostError).toMatch(/exited/);
		expect(updates.some((u) => u.kind === "status")).toBe(true);
		expect(updates.some((u) => u.kind === "event")).toBe(true);
	});

	it("surfaces a start failure and rethrows", async () => {
		const fake = new FakeClient();
		fake.startError = new Error("spawn failed");
		const controller = makeController(fake);

		await expect(controller.start()).rejects.toThrow("spawn failed");
		expect(controller.getStatus().error).toMatch(/spawn failed/);
		expect(controller.getTranscript().hostError).toMatch(/spawn failed/);
	});

	it("stops the client on dispose", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();
		await controller.dispose();
		expect(fake.stopped).toBe(1);
	});

	describe("queued composer messages (steer + pending display + restore on abort)", () => {
		it("queues a submit made while streaming via steer (not prompt) and shows a pending chip", async () => {
			const fake = new FakeClient();
			const controller = makeController(fake);
			await controller.start();
			const updates: ControllerUpdate[] = [];
			controller.onUpdate((u) => updates.push(u));

			fake.emit({ type: "agent_start" }); // now streaming
			await controller.submit("keep going, also check the tests");

			// Routed to steer, never to the (mid-stream-rejecting) prompt path.
			expect(fake.steers).toEqual(["keep going, also check the tests"]);
			expect(fake.prompts).toEqual([]);
			// The queued message is published for display.
			const pending = updates.filter(
				(u): u is Extract<ControllerUpdate, { kind: "pending" }> => u.kind === "pending",
			);
			expect(pending.at(-1)?.messages).toEqual([{ kind: "steer", text: "keep going, also check the tests" }]);
			expect(controller.getPending()).toEqual([{ kind: "steer", text: "keep going, also check the tests" }]);
		});

		it("sends a submit as a normal prompt when the agent is idle", async () => {
			const fake = new FakeClient();
			const controller = makeController(fake);
			await controller.start();

			await controller.submit("hello");

			expect(fake.prompts).toEqual(["hello"]);
			expect(fake.steers).toEqual([]);
			expect(controller.getPending()).toEqual([]);
		});

		it("clears the pending chip once the steered message is delivered mid-run", async () => {
			const fake = new FakeClient();
			const controller = makeController(fake);
			await controller.start();
			fake.emit({ type: "agent_start" });
			await controller.submit("keep going");
			expect(controller.getPending()).toHaveLength(1);

			const updates: ControllerUpdate[] = [];
			controller.onUpdate((u) => updates.push(u));
			// The backend delivers the steered message (drops it from its queue) and
			// streams it back as a user turn.
			fake.pendingSteering = [];
			fake.emit({ type: "message_start", message: { role: "user", content: "keep going" } });
			await Promise.resolve(); // let the void refreshPending() settle

			const pending = updates.filter(
				(u): u is Extract<ControllerUpdate, { kind: "pending" }> => u.kind === "pending",
			);
			expect(pending.at(-1)?.messages).toEqual([]);
			expect(controller.getPending()).toEqual([]);
		});

		it("restores queued messages to the composer and clears the backend queue on abort", async () => {
			const fake = new FakeClient();
			const controller = makeController(fake);
			await controller.start();
			fake.emit({ type: "agent_start" });
			await controller.submit("first follow-up");
			await controller.submit("second follow-up");
			expect(controller.getPending()).toHaveLength(2);

			const updates: ControllerUpdate[] = [];
			controller.onUpdate((u) => updates.push(u));
			await controller.abort();

			expect(fake.aborted).toBe(1);
			expect(fake.clearPendingCalls).toBe(1);
			expect(fake.pendingSteering).toEqual([]);
			// The queued text is restored to the composer (joined, in order) rather
			// than silently lost. `mode: "prepend"` tells the composer to insert
			// before any in-progress draft rather than overwrite it.
			const prefill = updates.filter(
				(u): u is Extract<ControllerUpdate, { kind: "composer-prefill" }> => u.kind === "composer-prefill",
			);
			expect(prefill.at(-1)?.text).toBe("first follow-up\n\nsecond follow-up");
			expect(prefill.at(-1)?.mode).toBe("prepend");
			// And the chips are cleared.
			expect(controller.getPending()).toEqual([]);
		});

		it("does not prefill the composer on abort when nothing is queued", async () => {
			const fake = new FakeClient();
			const controller = makeController(fake);
			await controller.start();
			fake.emit({ type: "agent_start" });

			const updates: ControllerUpdate[] = [];
			controller.onUpdate((u) => updates.push(u));
			await controller.abort();

			expect(fake.aborted).toBe(1);
			expect(fake.clearPendingCalls).toBe(1);
			expect(updates.some((u) => u.kind === "composer-prefill")).toBe(false);
		});
	});

	describe("hasFailed() (Phase 9 — reopen restarts a crashed session)", () => {
		it("is false for a brand-new session that is merely still starting", () => {
			const fake = new FakeClient();
			const controller = makeController(fake);
			// Constructed but start() not called: connected false, but no error yet.
			expect(controller.getStatus().connected).toBe(false);
			expect(controller.hasFailed()).toBe(false);
		});

		it("is false for a live, connected session", async () => {
			const fake = new FakeClient();
			const controller = makeController(fake);
			await controller.start();
			expect(controller.hasFailed()).toBe(false);
		});

		it("is true after the RPC child exits unexpectedly", async () => {
			const fake = new FakeClient();
			const controller = makeController(fake);
			await controller.start();
			fake.emitExit({ code: 1, signal: null });
			expect(controller.hasFailed()).toBe(true);
			expect(controller.isDisposed()).toBe(false); // still live, just failed
		});

		it("is true after a failed start() handshake", async () => {
			const fake = new FakeClient();
			fake.startError = new Error("spawn failed");
			const controller = makeController(fake);
			await expect(controller.start()).rejects.toThrow("spawn failed");
			expect(controller.hasFailed()).toBe(true);
		});

		it("is true after a fatal (e.g. CLI not found)", () => {
			const fake = new FakeClient();
			const controller = makeController(fake);
			controller.reportFatal("dreb CLI not found");
			expect(controller.hasFailed()).toBe(true);
		});

		it("is false after /quit (disposed, not failed)", async () => {
			const fake = new FakeClient();
			const controller = makeController(fake);
			await controller.start();
			await controller.submit("/quit");
			expect(controller.isDisposed()).toBe(true);
			expect(controller.hasFailed()).toBe(false);
		});
	});

	describe("onUserInput() (Phase 9 — resets the inactivity cap)", () => {
		it("fires on a composer submit (even one short-circuited while disconnected)", async () => {
			const fake = new FakeClient();
			const controller = makeController(fake);
			let inputs = 0;
			controller.onUserInput(() => {
				inputs += 1;
			});
			await controller.start();
			await controller.submit("hello");
			expect(inputs).toBe(1);

			// A disconnected submit is short-circuited but is still user engagement.
			fake.emitExit({ code: 1, signal: null });
			await controller.submit("still typing");
			expect(inputs).toBe(2);
		});

		it("fires when answering a blocking UI request", async () => {
			const fake = new FakeClient();
			const controller = makeController(fake);
			let inputs = 0;
			controller.onUserInput(() => {
				inputs += 1;
			});
			await controller.start();
			controller.respondUi({ id: "u1", confirmed: true });
			expect(inputs).toBe(1);
		});

		it("stops firing after the listener unsubscribes", async () => {
			const fake = new FakeClient();
			const controller = makeController(fake);
			let inputs = 0;
			const off = controller.onUserInput(() => {
				inputs += 1;
			});
			await controller.start();
			await controller.submit("one");
			off();
			await controller.submit("two");
			expect(inputs).toBe(1);
		});
	});

	it("drops a submit with a notice when the client is not started yet", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		// No start() — client is not created yet.
		await controller.submit("hello");
		expect(fake.prompts).toHaveLength(0);
		expect(controller.getTranscript().statusText).toMatch(/starting up/);
	});

	it("appends `--session <path>` to the args when resuming a specific session", async () => {
		const fake = new FakeClient();
		let capturedArgs: string[] | undefined;
		const controller = new SessionController({
			cwd: "/tmp/project",
			cliPath: "/cli.js",
			args: ["--provider", "anthropic"],
			sessionPath: "/abs/sess.jsonl",
			clientFactory: (opts) => {
				capturedArgs = opts.args;
				return fake;
			},
		});

		await controller.start();

		// User args come first, then the resume flag appended after them.
		expect(capturedArgs).toEqual(["--provider", "anthropic", "--session", "/abs/sess.jsonl"]);
		expect(capturedArgs?.slice(-2)).toEqual(["--session", "/abs/sess.jsonl"]);
	});

	it("omits `--session` from the args for a fresh session", async () => {
		const fake = new FakeClient();
		let capturedArgs: string[] | undefined;
		const controller = new SessionController({
			cwd: "/tmp/project",
			cliPath: "/cli.js",
			args: ["--provider", "anthropic"],
			clientFactory: (opts) => {
				capturedArgs = opts.args;
				return fake;
			},
		});

		await controller.start();

		expect(capturedArgs).toEqual(["--provider", "anthropic"]);
		expect(capturedArgs).not.toContain("--session");
	});

	it("rename() forwards the name to the client's setSessionName", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();

		await controller.rename("My name");
		expect(fake.names).toEqual(["My name"]);
	});

	it("runState reflects the projected transcript (idle → running → needs-input)", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();

		// Fresh session, nothing streaming and no pending UI request.
		expect(controller.runState).toBe("idle");

		// A streaming start moves it to running.
		fake.emit({ type: "agent_start" });
		expect(controller.runState).toBe("running");

		// The stream ends, then a blocking extension-UI request arrives → needs-input.
		fake.emit({ type: "agent_end" });
		expect(controller.runState).toBe("idle");
		fake.emit({ type: "extension_ui_request", id: "u1", method: "confirm", title: "Proceed?" });
		expect(controller.runState).toBe("needs-input");
	});

	it("sessionPath reflects the live session file from a status refresh", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		fake.state = { sessionFile: "/abs/live.jsonl" };
		await controller.start(); // connect does a full refresh incl. getState

		expect(controller.sessionPath).toBe("/abs/live.jsonl");
	});

	it("sessionPath falls back to the resume path before the first refresh", () => {
		const fake = new FakeClient();
		const controller = new SessionController({
			cwd: "/tmp/project",
			cliPath: "/cli.js",
			sessionPath: "/abs/resume.jsonl",
			clientFactory: () => fake,
		});

		// No start() yet — no live sessionFile, so it falls back to the resume path.
		expect(controller.sessionPath).toBe("/abs/resume.jsonl");
	});

	it("does not clobber a known live session file when a later refresh omits it", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		fake.state = { sessionFile: "/abs/live.jsonl" };
		await controller.start();
		expect(controller.sessionPath).toBe("/abs/live.jsonl");

		// A later refresh whose state omits sessionFile must preserve the known path.
		fake.state = {};
		fake.emit({ type: "agent_end" });
		await Promise.resolve();
		await Promise.resolve();

		expect(controller.sessionPath).toBe("/abs/live.jsonl");
	});
});

describe("SessionController.openSource", () => {
	it("delegates a clicked code reference to the injected SourceLinkUi", async () => {
		const calls: OpenSourceRef[] = [];
		const sourceLink: SourceLinkUi = {
			async openSource(ref) {
				calls.push(ref);
			},
		};
		const controller = new SessionController({
			cwd: "/tmp/project",
			cliPath: "/cli.js",
			clientFactory: () => new FakeClient(),
			sourceLink,
		});

		await controller.openSource({ path: "src/a.ts", line: 12 });
		await controller.openSource({ symbol: "Widget", path: "src/a.ts", line: 3 });

		expect(calls).toEqual([
			{ path: "src/a.ts", line: 12 },
			{ symbol: "Widget", path: "src/a.ts", line: 3 },
		]);
	});

	it("is inert (no throw) when no SourceLinkUi is injected", async () => {
		const controller = new SessionController({
			cwd: "/tmp/project",
			cliPath: "/cli.js",
			clientFactory: () => new FakeClient(),
		});
		await expect(controller.openSource({ path: "src/a.ts", line: 1 })).resolves.toBeUndefined();
	});

	it("swallows a throwing SourceLinkUi into a notice (bridge calls it fire-and-forget)", async () => {
		const sourceLink: SourceLinkUi = {
			async openSource() {
				throw new Error("boom");
			},
		};
		const controller = new SessionController({
			cwd: "/tmp/project",
			cliPath: "/cli.js",
			clientFactory: () => new FakeClient(),
			sourceLink,
		});
		// Must not reject — an unhandled rejection is exactly what we're guarding.
		await expect(controller.openSource({ symbol: "Widget" })).resolves.toBeUndefined();
	});
});

/** Build a session-tree node (Phase 6). */
function node(
	id: string,
	role: "user" | "assistant",
	preview: string,
	children: SessionTreeNodeDto[] = [],
): SessionTreeNodeDto {
	return { id, parentId: null, type: "message", role, preview, timestamp: "2026-01-01T00:00:00.000Z", children };
}

/** The nodes from a root down to `leafId` (inclusive), root-first — mirrors the
 * real branch the RPC child resolves for `get_messages`/`get_tree`. */
function leafPath(nodes: SessionTreeNodeDto[], leafId: string | null): SessionTreeNodeDto[] {
	if (!leafId) return [];
	for (const n of nodes) {
		if (n.id === leafId) return [n];
		const rest = leafPath(n.children, leafId);
		if (rest.length > 0) return [n, ...rest];
	}
	return [];
}

/** A three-turn branch: user → assistant(a1) → user → assistant(a2). */
function twoResponseTree(): { roots: SessionTreeNodeDto[]; leafId: string } {
	return {
		roots: [
			node("u1", "user", "hi", [
				node("a1", "assistant", "hello", [node("u2", "user", "again", [node("a2", "assistant", "world")])]),
			]),
		],
		leafId: "a2",
	};
}

const flush = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("SessionController session tree (Phase 6)", () => {
	it("forks from an entry, rebuilds the transcript from the branch, and resyncs", async () => {
		const fake = new FakeClient();
		fake.treeResult = twoResponseTree();
		const controller = makeController(fake);
		await controller.start();
		const updates: Array<{ kind: string; [k: string]: unknown }> = [];
		controller.onUpdate((u) => updates.push(u as never));

		await controller.fork("a1");

		expect(fake.forkCalls).toEqual(["a1"]);
		expect(fake.treeCalls).toBeGreaterThan(0); // rebuild fetched the tree
		// Transcript rebuilt from the branch's full messages: user/assistant turns in order.
		const items = controller.getTranscript().items;
		expect(
			items.map((i) => (i.kind === "user" ? `u:${i.text}` : i.kind === "response" ? `a:${i.answer}` : i.text)),
		).toEqual(["u:hi", "a:hello", "u:again", "a:world"]);
		expect(updates.some((u) => u.kind === "resync")).toBe(true);
		const cp = updates.find((u) => u.kind === "checkpoints") as
			| { checkpoints: Array<{ entryId: string; canRestore: boolean }> }
			| undefined;
		expect(cp?.checkpoints.map((c) => `${c.entryId}:${c.canRestore}`)).toEqual(["a1:true", "a2:false"]);
	});

	it("gates canFork on the rebuild path too, not just the live path (finding 1)", async () => {
		const fake = new FakeClient();
		fake.treeResult = twoResponseTree();
		// Only the first assistant turn is forkable (e.g. a2 errored / used a tool).
		fake.forkMessagesOverride = [{ entryId: "a1", text: "hello", role: "assistant" }];
		const controller = makeController(fake);
		await controller.start();

		// fork() → rebuildTranscript() must thread the forkable set through
		// alignCheckpoints exactly like the live refreshCheckpoints path does.
		await controller.fork("a1");

		expect(fake.forkMessagesCalls).toBeGreaterThan(0);
		expect(controller.getCheckpoints().map((c) => `${c.entryId}:${c.canRestore}:${c.canFork}`)).toEqual([
			"a1:true:true",
			"a2:false:false",
		]);
	});

	it("hides Fork (canFork false) without a spurious notice when get_fork_messages fails on rebuild (finding 2)", async () => {
		const fake = new FakeClient();
		fake.treeResult = twoResponseTree();
		// Only get_fork_messages fails (older/partial backend); getTree + fork work.
		fake.forkMessagesError = new Error("get_fork_messages unsupported");
		const controller = makeController(fake);
		await controller.start();
		const updates: Array<{ kind: string }> = [];
		controller.onUpdate((u) => updates.push(u as never));

		await controller.fork("a1");

		// The fork itself succeeded and the transcript rebuilt: forkableEntryIds()
		// swallows the RPC failure and returns an empty set, so Fork is hidden
		// (canFork false) rather than the outer fork() catch firing a bogus
		// "Couldn't fork" notice for a fork that actually worked.
		expect(updates.some((u) => u.kind === "resync")).toBe(true);
		expect(controller.getCheckpoints().map((c) => `${c.entryId}:${c.canFork}`)).toEqual(["a1:false", "a2:false"]);
		expect(controller.getTranscript().statusText ?? "").not.toMatch(/Couldn't fork/);
	});

	it("pre-fills the composer on a user-message fork (re-ask text), not an assistant fork", async () => {
		const fake = new FakeClient();
		fake.treeResult = twoResponseTree();
		fake.forkResult = { text: "re-ask this", cancelled: false };
		const controller = makeController(fake);
		await controller.start();
		const prefills: Array<{ text: string; mode?: string }> = [];
		controller.onUpdate((u) => {
			if ((u as { kind: string }).kind === "composer-prefill") prefills.push(u as { text: string; mode?: string });
		});

		await controller.fork("u2");
		expect(prefills.map((p) => p.text)).toEqual(["re-ask this"]);
		// Fork re-ask must REPLACE the composer: it omits `mode`, so the webview
		// defaults to "replace". A "prepend" here would jam re-ask text in front of
		// whatever the user had typed — the opposite of what a fork intends.
		expect(prefills.at(-1)?.mode).toBeUndefined();

		// Assistant fork returns "" → no composer clobber.
		fake.forkResult = { text: "", cancelled: false };
		await controller.fork("a1");
		expect(prefills.map((p) => p.text)).toEqual(["re-ask this"]);
	});

	it("surfaces a notice and does not rebuild when a fork is cancelled", async () => {
		const fake = new FakeClient();
		fake.forkResult = { text: "", cancelled: true };
		const controller = makeController(fake);
		await controller.start();
		const treeCallsBefore = fake.treeCalls;

		await controller.fork("a1");

		expect(controller.getTranscript().statusText).toMatch(/Fork cancelled/);
		expect(fake.treeCalls).toBe(treeCallsBefore); // no rebuild
	});

	it("resets and resyncs (never leaves a stale branch) when a fork succeeds but the reload fails", async () => {
		const fake = new FakeClient();
		fake.treeResult = twoResponseTree();
		const controller = makeController(fake, { sessionPath: "/abs/sess.jsonl" });
		await controller.start();
		// Resume folded the branch, so there is a (soon-to-be-stale) transcript.
		expect(controller.getTranscript().items.length).toBeGreaterThan(0);

		const updates: Array<{ kind: string }> = [];
		controller.onUpdate((u) => updates.push(u as never));
		// The backend fork succeeds and moves the leaf, but the transcript-reload
		// RPCs (getMessages/getTree) then fail.
		fake.rebuildError = new Error("reload boom");

		await controller.fork("a1");

		expect(fake.forkCalls).toContain("a1"); // backend already moved branch
		// The webview is reset + resynced — it must NOT keep rendering the old
		// branch over a backend that has switched.
		expect(controller.getTranscript().items).toEqual([]);
		expect(controller.getCheckpoints()).toEqual([]);
		expect(updates.some((u) => u.kind === "resync")).toBe(true);
		expect(controller.getTranscript().statusText).toMatch(/couldn't reload/i);
	});

	it("keeps the current transcript intact when the backend fork itself fails (no reset)", async () => {
		const fake = new FakeClient();
		fake.treeResult = twoResponseTree();
		const controller = makeController(fake, { sessionPath: "/abs/sess.jsonl" });
		await controller.start();
		const before = controller.getTranscript().items.length;
		expect(before).toBeGreaterThan(0);

		const updates: Array<{ kind: string }> = [];
		controller.onUpdate((u) => updates.push(u as never));
		// The backend fork call rejects — the leaf never moved, so the current
		// transcript is still valid and must not be blanked.
		fake.callError = new Error("fork boom");

		await controller.fork("a1");

		expect(controller.getTranscript().statusText).toMatch(/Couldn't fork/);
		expect(controller.getTranscript().items.length).toBe(before); // preserved
		expect(updates.some((u) => u.kind === "resync")).toBe(false); // no reset/resync
	});

	it("resets and resyncs when a restore succeeds but the reload fails", async () => {
		const fake = new FakeClient();
		fake.treeResult = twoResponseTree();
		const controller = makeController(fake, { sessionPath: "/abs/sess.jsonl" });
		await controller.start();
		expect(controller.getTranscript().items.length).toBeGreaterThan(0);

		const updates: Array<{ kind: string }> = [];
		controller.onUpdate((u) => updates.push(u as never));
		fake.rebuildError = new Error("reload boom");

		await controller.navigateTree("a1");

		expect(fake.navigateCalls).toContain("a1"); // backend already moved
		expect(controller.getTranscript().items).toEqual([]);
		expect(controller.getCheckpoints()).toEqual([]);
		expect(updates.some((u) => u.kind === "resync")).toBe(true);
		expect(controller.getTranscript().statusText).toMatch(/couldn't reload/i);
	});

	it("restores (navigates) to an entry and rebuilds the transcript", async () => {
		const fake = new FakeClient();
		fake.treeResult = twoResponseTree();
		const controller = makeController(fake);
		await controller.start();
		const updates: Array<{ kind: string }> = [];
		controller.onUpdate((u) => updates.push(u as never));

		await controller.navigateTree("a1");

		expect(fake.navigateCalls).toEqual(["a1"]);
		expect(updates.some((u) => u.kind === "resync")).toBe(true);
		expect(updates.some((u) => u.kind === "checkpoints")).toBe(true);
	});

	it("rebuilds a restored tool-using run into ONE full-content group (issue 47)", async () => {
		// A tool-using run persists TWO assistant entries (the tool-call turn + the
		// final answer) plus a toolResult between them. The rebuilt transcript must
		// fold them into a single response group — full answer + a thinking/tool
		// activity box — not three preview blocks with "(no content)" placeholders,
		// and its one restore control must key to the run-terminal entry (a2).
		const TS = "2026-01-01T00:00:00.000Z";
		const fake = new FakeClient();
		fake.treeResult = {
			roots: [
				{
					id: "u1",
					parentId: null,
					type: "message",
					role: "user",
					preview: "do it",
					timestamp: TS,
					children: [
						{
							id: "a1",
							parentId: "u1",
							type: "message",
							role: "assistant",
							preview: "",
							timestamp: TS,
							children: [
								{
									id: "tr1",
									parentId: "a1",
									type: "message",
									role: "toolResult",
									preview: "[read]",
									timestamp: TS,
									children: [
										{
											id: "a2",
											parentId: "tr1",
											type: "message",
											role: "assistant",
											preview: "here is the answer",
											timestamp: TS,
											children: [],
										},
									],
								},
							],
						},
					],
				},
			],
			leafId: "a2",
		};
		fake.messagesOverride = [
			{ role: "user", content: "do it" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "let me check" },
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } },
				],
				stopReason: "toolUse",
			},
			{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "file body" }] },
			{ role: "assistant", content: [{ type: "text", text: "here is the answer" }], stopReason: "stop" },
		];
		const controller = makeController(fake);
		await controller.start();

		await controller.navigateTree("a2");

		expect(fake.getMessagesCalls).toBeGreaterThan(0);
		const items = controller.getTranscript().items;
		// One user turn + exactly one response group (not per-assistant-entry blocks).
		expect(items.map((i) => i.kind)).toEqual(["user", "response"]);
		const group = items.find((i) => i.kind === "response");
		if (group?.kind !== "response") throw new Error("expected a response group");
		expect(group.answer).toBe("here is the answer");
		expect(group.activity.filter((a) => a.kind === "thinking")).toHaveLength(1);
		const tool = group.activity.find((a) => a.kind === "tool");
		expect(tool).toMatchObject({ toolName: "read", status: "done", resultText: "file body" });
		// The single restore/fork control keys to the run-terminal entry (a2).
		expect(controller.getCheckpoints().map((c) => `${c.entryId}:${c.canRestore}:${c.canFork}`)).toEqual([
			"a2:false:true",
		]);
	});

	it("surfaces a notice when a restore is cancelled", async () => {
		const fake = new FakeClient();
		fake.navigateResult = { cancelled: true };
		const controller = makeController(fake);
		await controller.start();

		await controller.navigateTree("a1");
		expect(controller.getTranscript().statusText).toMatch(/Restore cancelled/);
	});

	it("emits the session tree on request", async () => {
		const fake = new FakeClient();
		fake.treeResult = twoResponseTree();
		const controller = makeController(fake);
		await controller.start();
		let tree: { roots: unknown[]; leafId: string | null } | undefined;
		controller.onUpdate((u) => {
			if ((u as { kind: string }).kind === "tree")
				tree = (u as { tree: { roots: unknown[]; leafId: string | null } }).tree;
		});

		await controller.requestTree();
		expect(tree?.leafId).toBe("a2");
		expect(tree?.roots.length).toBe(1);
	});

	it("recomputes checkpoints after each completed turn, keyed to response groups", async () => {
		const fake = new FakeClient();
		fake.treeResult = { roots: [node("u1", "user", "hi", [node("a1", "assistant", "hello")])], leafId: "a1" };
		const controller = makeController(fake);
		await controller.start();
		const checkpointUpdates: Array<Array<{ responseId: number; entryId: string; canRestore: boolean }>> = [];
		controller.onUpdate((u) => {
			if (u.kind === "checkpoints") checkpointUpdates.push(u.checkpoints);
		});

		// A live turn builds one response group (id 1) from events.
		fake.emit({ type: "agent_start" });
		fake.emit({ type: "message_start", message: { role: "assistant" } });
		fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
		fake.emit({ type: "agent_end" });
		await flush();

		const latest = checkpointUpdates.at(-1);
		expect(latest).toEqual([{ responseId: 1, entryId: "a1", canRestore: false, canFork: true }]);
		expect(controller.getCheckpoints()).toEqual([{ responseId: 1, entryId: "a1", canRestore: false, canFork: true }]);
	});

	it("gates canFork from get_fork_messages — a non-forkable turn omits its entry (finding A)", async () => {
		const fake = new FakeClient();
		fake.treeResult = { roots: [node("u1", "user", "hi", [node("a1", "assistant", "hello")])], leafId: "a1" };
		// The backend reports a1 as NOT forkable (e.g. it used a tool / errored).
		fake.forkMessagesOverride = [];
		const controller = makeController(fake);
		await controller.start();

		fake.emit({ type: "agent_start" });
		fake.emit({ type: "message_start", message: { role: "assistant" } });
		fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
		fake.emit({ type: "agent_end" });
		await flush();

		expect(controller.getCheckpoints()).toEqual([
			{ responseId: 1, entryId: "a1", canRestore: false, canFork: false },
		]);
		expect(fake.forkMessagesCalls).toBeGreaterThan(0);
	});

	it("surfaces a notice when a fork throws (fire-and-forget from the bridge)", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();
		fake.callError = new Error("boom");

		await expect(controller.fork("a1")).resolves.toBeUndefined();
		expect(controller.getTranscript().statusText).toMatch(/Couldn't fork: boom/);
	});

	it("clears checkpoints on /new so a stale prior-session control can't render (finding 2)", async () => {
		const fake = new FakeClient();
		fake.treeResult = twoResponseTree();
		const controller = makeController(fake);
		await controller.start();
		await controller.fork("a1"); // populate checkpoints from the current session
		expect(controller.getCheckpoints().length).toBeGreaterThan(0);
		const updates: Array<{ kind: string }> = [];
		controller.onUpdate((u) => updates.push(u as never));

		await controller.submit("/new");

		// Durable state is cleared; the resync then re-posts the empty checkpoints
		// to the webview (bridge-level, covered in webview-bridge.test.ts).
		expect(controller.getCheckpoints()).toEqual([]);
		expect(updates.some((u) => u.kind === "resync")).toBe(true);
	});

	it("clears checkpoints on /import as well (finding 2)", async () => {
		const fake = new FakeClient();
		fake.treeResult = twoResponseTree();
		const ui = new FakeUi();
		ui.openReturn = "/tmp/in.jsonl";
		const controller = makeController(fake, { ui });
		await controller.start();
		await controller.fork("a1");
		expect(controller.getCheckpoints().length).toBeGreaterThan(0);

		await controller.submit("/import");
		expect(controller.getCheckpoints()).toEqual([]);
	});

	it("rebuilds only the branch matching the leaf, not a sibling branch (finding 4)", async () => {
		// A real fork: a1 has TWO children (two divergent branches). The leaf is in
		// branch A, so the rebuilt transcript must follow branch A and ignore B.
		const fake = new FakeClient();
		fake.treeResult = {
			roots: [
				node("u1", "user", "hi", [
					node("a1", "assistant", "hello", [
						node("u2a", "user", "ask-A", [node("a2a", "assistant", "answer-A")]),
						node("u2b", "user", "ask-B", [node("a2b", "assistant", "answer-B")]),
					]),
				]),
			],
			leafId: "a2a",
		};
		const controller = makeController(fake);
		await controller.start();

		await controller.navigateTree("a2a");

		const items = controller.getTranscript().items;
		expect(
			items.map((i) => (i.kind === "user" ? `u:${i.text}` : i.kind === "response" ? `a:${i.answer}` : i.text)),
		).toEqual(["u:hi", "a:hello", "u:ask-A", "a:answer-A"]);
		// Checkpoints key to branch-A entries only (the sibling branch is absent).
		expect(controller.getCheckpoints().map((c) => c.entryId)).toEqual(["a1", "a2a"]);
	});
});

describe("SessionController resume (Phase 5 — rebuild transcript on start)", () => {
	it("folds the persisted branch into the transcript on start when resuming", async () => {
		const fake = new FakeClient();
		fake.treeResult = twoResponseTree();
		const controller = makeController(fake, { sessionPath: "/abs/sess.jsonl" });
		const updates: Array<{ kind: string }> = [];
		controller.onUpdate((u) => updates.push(u as never));

		await controller.start();

		// The resumed child never replays historical events, so start() rebuilds
		// the transcript from the persisted branch's full messages instead of leaving it blank.
		expect(fake.treeCalls).toBeGreaterThan(0);
		const items = controller.getTranscript().items;
		expect(
			items.map((i) => (i.kind === "user" ? `u:${i.text}` : i.kind === "response" ? `a:${i.answer}` : i.text)),
		).toEqual(["u:hi", "a:hello", "u:again", "a:world"]);
		// The rebuild resyncs an already-live webview (finding 4) and realigns the
		// inline restore/fork controls to the folded turns (finding 5) — keyed to
		// the branch's run-terminal assistant entries, with the current leaf non-restorable.
		expect(updates.some((u) => u.kind === "resync")).toBe(true);
		expect(controller.getCheckpoints().map((c) => `${c.entryId}:${c.canRestore}`)).toEqual(["a1:true", "a2:false"]);
	});

	it("does not fold on start for a brand-new session (no sessionPath)", async () => {
		const fake = new FakeClient();
		fake.treeResult = twoResponseTree();
		const controller = makeController(fake); // no sessionPath

		await controller.start();

		// A fresh session keeps populating from the live event stream; start() must
		// not fetch the tree or pre-fold any turns.
		expect(fake.treeCalls).toBe(0);
		expect(controller.getTranscript().items).toEqual([]);
	});

	it("resets to a clean state and notifies the user when the resume rebuild fails", async () => {
		const fake = new FakeClient();
		// getTree (invoked by rebuildTranscript) throws; start() must swallow it.
		fake.callError = new Error("getTree boom");
		const controller = makeController(fake, { sessionPath: "/abs/sess.jsonl" });
		const updates: Array<{ kind: string }> = [];
		controller.onUpdate((u) => updates.push(u as never));

		await expect(controller.start()).resolves.toBeUndefined();

		// Best-effort: the failure does not block startup — the session stays
		// connected and usable.
		expect(controller.getStatus().connected).toBe(true);
		// The transcript is reset to a clean empty state (no half-folded turns) and
		// checkpoints are cleared, so the webview never shows a partial conversation
		// (finding 3).
		expect(controller.getTranscript().items).toEqual([]);
		expect(controller.getCheckpoints()).toEqual([]);
		// A resync pushes that clean state to an already-live webview...
		expect(updates.some((u) => u.kind === "resync")).toBe(true);
		// ...and the user is told the prior conversation is saved rather than facing
		// a silent blank window indistinguishable from a brand-new session
		// (finding 1).
		expect(controller.getTranscript().statusText).toMatch(/still saved/i);
	});
});
