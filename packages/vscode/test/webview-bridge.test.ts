import { describe, expect, it, vi } from "vitest";

// The bridge imports `vscode` only for the `Disposable` constructor (in
// `connectWebview`) and `Uri`/`asWebviewUri` (in `getWebviewHtml`, not tested
// here). A minimal Disposable is enough to exercise the transport wiring.
vi.mock("vscode", () => {
	class Disposable {
		constructor(private readonly fn: () => void) {}
		dispose(): void {
			this.fn();
		}
	}
	return { Disposable };
});

import { type RpcClientLike, SessionController } from "../src/host/session-controller.js";
import { connectWebview } from "../src/host/webview-bridge.js";
import type { HostToWebview, WebviewToHost } from "../src/shared/protocol.js";

/** Minimal RpcClient fake that lets a test push events. */
class BridgeFakeClient implements RpcClientLike {
	private ev: ((e: any) => void) | undefined;
	private ex: ((info: any) => void) | undefined;
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {}
	async abort(): Promise<void> {}
	async steer(): Promise<void> {}
	async followUp(): Promise<void> {}
	async getPendingMessages(): Promise<{ steering: string[]; followUp: string[] }> {
		return { steering: [], followUp: [] };
	}
	async clearPendingMessages(): Promise<{ steering: string[]; followUp: string[] }> {
		return { steering: [], followUp: [] };
	}
	async compact(): Promise<unknown> {
		return {};
	}
	async setAskMode(enabled: boolean): Promise<{ enabled: boolean }> {
		return { enabled };
	}
	async getCommands(): Promise<any[]> {
		return [];
	}
	sendExtensionUIResponse(): void {}
	onEvent(listener: (e: any) => void): () => void {
		this.ev = listener;
		return () => {
			this.ev = undefined;
		};
	}
	onExit(listener: (info: any) => void): () => void {
		this.ex = listener;
		return () => {
			this.ex = undefined;
		};
	}
	async getState(): Promise<any> {
		return {};
	}
	async getDailyCost(): Promise<number> {
		return 0;
	}
	async getSessionStats(): Promise<any> {
		return { cost: 0 };
	}
	async getAvailableModels(): Promise<any[]> {
		return [];
	}
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		return { provider, id: modelId };
	}
	async setThinkingLevel(): Promise<void> {}
	async newSession(): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}
	async reload(): Promise<void> {}
	async dream(): Promise<{ message: string }> {
		return { message: "" };
	}
	async setSessionName(): Promise<void> {}
	async exportHtml(): Promise<{ path: string }> {
		return { path: "" };
	}
	async importJsonl(): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}
	async fork(): Promise<{ text: string; cancelled: boolean }> {
		return { text: "", cancelled: false };
	}
	async navigateTree(): Promise<{ cancelled: boolean; editorText?: string }> {
		return { cancelled: false };
	}
	async getTree(): Promise<{ roots: any[]; leafId: string | null }> {
		return { roots: [], leafId: null };
	}
	async getForkMessages(): Promise<Array<{ entryId: string; text: string; role: "user" | "assistant" }>> {
		return [];
	}
	async getMessages(): Promise<unknown[]> {
		return [];
	}
	emit(event: unknown): void {
		this.ev?.(event);
	}
	emitExit(info: unknown): void {
		this.ex?.(info);
	}
}

/** Fake vscode.Webview capturing posts and exposing the message handler. */
function makeWebview() {
	const posted: HostToWebview[] = [];
	let handler: ((msg: WebviewToHost) => void) | undefined;
	const webview = {
		postMessage: (m: HostToWebview) => {
			posted.push(m);
			return Promise.resolve(true);
		},
		onDidReceiveMessage: (h: (msg: WebviewToHost) => void) => {
			handler = h;
			return { dispose() {} };
		},
	};
	return {
		webview,
		posted,
		send: (m: WebviewToHost) => handler?.(m),
	};
}

async function makeController(fake: BridgeFakeClient) {
	const controller = new SessionController({ cwd: "/tmp/p", cliPath: "/cli.js", clientFactory: () => fake });
	await controller.start();
	return controller;
}

describe("connectWebview", () => {
	it("holds events until ready, then snapshots once and streams live with no duplication", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const { webview, posted, send } = makeWebview();
		connectWebview(webview as any, controller);

		// Pre-ready events must NOT be streamed to the webview…
		fake.emit({ type: "agent_start" });
		fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "pre" } });
		expect(posted).toHaveLength(0);

		// …but they ARE folded into the authoritative state and delivered once
		// via the snapshot when the webview announces ready.
		send({ type: "ready" });
		const snapshots = posted.filter((m) => m.type === "snapshot");
		expect(snapshots).toHaveLength(1);
		const snapshot = snapshots[0] as Extract<HostToWebview, { type: "snapshot" }>;
		expect(snapshot.state.streaming).toBe(true);
		const preGroup = snapshot.state.items.find((i) => i.kind === "response");
		expect(preGroup && preGroup.kind === "response" && preGroup.answer).toBe("pre");

		// Events AFTER ready stream live as `event` messages…
		fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "post" } });
		const events = posted.filter((m) => m.type === "event") as Array<Extract<HostToWebview, { type: "event" }>>;
		expect(events).toHaveLength(1);
		expect(events[0].event).toMatchObject({ assistantMessageEvent: { delta: "post" } });
		// …and the pre-ready events are never re-streamed (no snapshot/stream overlap).
		expect(events.some((e) => (e.event as any)?.assistantMessageEvent?.delta === "pre")).toBe(false);
	});

	it("streams status updates live after ready", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const { webview, posted, send } = makeWebview();
		connectWebview(webview as any, controller);
		send({ type: "ready" });

		// A child crash drives a recovering notice (host_notice event) and a
		// status update while auto-restart is in progress; both must reach the
		// webview now that it is live.
		fake.emitExit({ code: 1, signal: null });
		expect(posted.some((m) => m.type === "status")).toBe(true);
		expect(posted.some((m) => m.type === "event" && (m.event as any)?.type === "host_notice")).toBe(true);
	});

	it("dispatches webview messages to the controller", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const submit = vi.spyOn(controller, "submit").mockResolvedValue();
		const abort = vi.spyOn(controller, "abort").mockResolvedValue();
		const retry = vi.spyOn(controller, "retry").mockResolvedValue();
		const respondUi = vi.spyOn(controller, "respondUi").mockImplementation(() => {});
		const refresh = vi.spyOn(controller, "refreshCommands");

		const { webview, send } = makeWebview();
		connectWebview(webview as any, controller);

		send({ type: "submit", text: "hi there" });
		send({ type: "retry" });
		send({ type: "abort" });
		send({ type: "ui-response", response: { id: "u1", confirmed: true } });
		send({ type: "refresh-commands" });

		expect(submit).toHaveBeenCalledWith("hi there", undefined, undefined);
		expect(retry).toHaveBeenCalledTimes(1);
		expect(abort).toHaveBeenCalledTimes(1);
		expect(respondUi).toHaveBeenCalledWith({ id: "u1", confirmed: true });
		expect(refresh).toHaveBeenCalled();
	});

	it("dispatches a dismiss-suggestion message to the controller", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const dismiss = vi.spyOn(controller, "dismissSuggestion");

		const { webview, send } = makeWebview();
		connectWebview(webview as any, controller);

		send({ type: "dismiss-suggestion" });

		expect(dismiss).toHaveBeenCalledTimes(1);
	});

	it("forwards submit attachments to the controller", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const submit = vi.spyOn(controller, "submit").mockResolvedValue();
		const { webview, send } = makeWebview();
		connectWebview(webview as any, controller);

		const attachments = [
			{ kind: "selection" as const, path: "a.ts", startLine: 1, endLine: 2, language: "ts", text: "A" },
		];
		send({ type: "submit", text: "explain", attachments });
		expect(submit).toHaveBeenCalledWith("explain", attachments, undefined);
	});

	it("forwards pasted submit images to the controller", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const submit = vi.spyOn(controller, "submit").mockResolvedValue();
		const { webview, send } = makeWebview();
		connectWebview(webview as any, controller);

		const images = [{ data: "AQID", mimeType: "image/png" }];
		send({ type: "submit", text: "look", images });
		expect(submit).toHaveBeenCalledWith("look", undefined, images);
	});

	it("forwards a live tag-context update as a tag-context message", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const { webview, posted, send } = makeWebview();
		connectWebview(webview as any, controller);
		send({ type: "ready" });

		const context = {
			kind: "selection" as const,
			path: "src/a.ts",
			startLine: 3,
			endLine: 5,
			language: "ts",
			text: "x",
		};
		controller.tagContext(context);

		const tags = posted.filter((m) => m.type === "tag-context") as Array<
			Extract<HostToWebview, { type: "tag-context" }>
		>;
		expect(tags).toHaveLength(1);
		expect(tags[0].context).toEqual(context);
		// The default (editor-selection) origin threads through to the webview.
		expect(tags[0].origin).toBe("selection");
	});

	it("forwards the picker origin so @@ picks insert inline references", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const { webview, posted, send } = makeWebview();
		connectWebview(webview as any, controller);
		send({ type: "ready" });

		const context = { kind: "file" as const, path: "src/app.ts" };
		controller.tagContext(context, "picker");

		const tags = posted.filter((m) => m.type === "tag-context") as Array<
			Extract<HostToWebview, { type: "tag-context" }>
		>;
		expect(tags).toHaveLength(1);
		expect(tags[0].context).toEqual(context);
		// If the bridge dropped/defaulted origin, the webview would treat the pick
		// as a plain selection and skip the inline `@name` insertion (D3).
		expect(tags[0].origin).toBe("picker");
	});

	it("buffers a tag-context tagged before ready and flushes it once live", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const { webview, posted, send } = makeWebview();
		connectWebview(webview as any, controller);

		// Tag BEFORE the webview announces ready (e.g. tagging into a fresh chat).
		// Use a picker origin so this also proves origin survives the pending buffer.
		const context = { kind: "file" as const, path: "src/a.ts" };
		controller.tagContext(context, "picker");
		expect(posted.filter((m) => m.type === "tag-context")).toHaveLength(0);

		send({ type: "ready" });
		const tags = posted.filter((m) => m.type === "tag-context") as Array<
			Extract<HostToWebview, { type: "tag-context" }>
		>;
		expect(tags).toHaveLength(1);
		expect(tags[0].context).toEqual(context);
		expect(tags[0].origin).toBe("picker");
	});

	it("routes pick-model / pick-thinking messages to the controller", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const pickModel = vi.spyOn(controller, "pickModel").mockResolvedValue();
		const pickThinking = vi.spyOn(controller, "pickThinking").mockResolvedValue();

		const { webview, send } = makeWebview();
		connectWebview(webview as any, controller);

		send({ type: "pick-model" });
		send({ type: "pick-thinking" });

		expect(pickModel).toHaveBeenCalledTimes(1);
		expect(pickThinking).toHaveBeenCalledTimes(1);
	});

	it("routes a pick-file message to the controller", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const tagFileFromPicker = vi.spyOn(controller, "tagFileFromPicker").mockResolvedValue();

		const { webview, send } = makeWebview();
		connectWebview(webview as any, controller);

		send({ type: "pick-file" });

		expect(tagFileFromPicker).toHaveBeenCalledTimes(1);
	});

	it("routes search-workspace to the controller and posts mention-results with the same requestId", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const results = [
			{ kind: "file" as const, path: "src/app.ts" },
			{ kind: "file" as const, path: "src/host.ts" },
		];
		const search = vi.spyOn(controller, "searchWorkspace").mockResolvedValue(results);

		const { webview, posted, send } = makeWebview();
		connectWebview(webview as any, controller);

		send({ type: "search-workspace", query: "app", requestId: 7 });
		// Let the mocked promise resolve.
		await Promise.resolve();
		await Promise.resolve();

		expect(search).toHaveBeenCalledWith("app");
		const mentionResults = posted.find((m) => m.type === "mention-results") as
			| Extract<HostToWebview, { type: "mention-results" }>
			| undefined;
		expect(mentionResults).toBeDefined();
		expect(mentionResults?.requestId).toBe(7);
		expect(mentionResults?.results).toEqual(results);
	});

	it("posts empty mention-results (same requestId) when the workspace search rejects", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		vi.spyOn(controller, "searchWorkspace").mockRejectedValue(new Error("findFiles failed"));

		const { webview, posted, send } = makeWebview();
		connectWebview(webview as any, controller);

		send({ type: "search-workspace", query: "app", requestId: 9 });
		// Let the rejected promise settle through the .catch.
		await Promise.resolve();
		await Promise.resolve();

		const mentionResults = posted.find((m) => m.type === "mention-results") as
			| Extract<HostToWebview, { type: "mention-results" }>
			| undefined;
		expect(mentionResults).toBeDefined();
		expect(mentionResults?.requestId).toBe(9);
		expect(mentionResults?.results).toEqual([]);
	});

	it("routes an open-source message to the controller with the parsed ref", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const openSource = vi.spyOn(controller, "openSource").mockResolvedValue();

		const { webview, send } = makeWebview();
		connectWebview(webview as any, controller);

		send({ type: "open-source", ref: { path: "src/a.ts", line: 12, column: 3 } });
		send({ type: "open-source", ref: { symbol: "Widget", path: "src/a.ts", line: 5 } });

		expect(openSource).toHaveBeenCalledTimes(2);
		expect(openSource).toHaveBeenNthCalledWith(1, { path: "src/a.ts", line: 12, column: 3 });
		expect(openSource).toHaveBeenNthCalledWith(2, { symbol: "Widget", path: "src/a.ts", line: 5 });
	});

	it("forwards a commands update as a commands message", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const { webview, posted, send } = makeWebview();
		connectWebview(webview as any, controller);
		send({ type: "ready" });

		// /reload triggers a commands update after re-fetching get_commands.
		await controller.submit("/reload");
		expect(posted.some((m) => m.type === "commands")).toBe(true);
	});

	it("re-snapshots on a resync update (e.g. after /new)", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const { webview, posted, send } = makeWebview();
		connectWebview(webview as any, controller);
		send({ type: "ready" });
		const snapshotsBefore = posted.filter((m) => m.type === "snapshot").length;

		await controller.submit("/new");
		const snapshotsAfter = posted.filter((m) => m.type === "snapshot").length;
		expect(snapshotsAfter).toBeGreaterThan(snapshotsBefore);
	});

	it("stops streaming to the webview after the disposable is disposed", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const { webview, posted, send } = makeWebview();
		const disposable = connectWebview(webview as any, controller);
		send({ type: "ready" });
		const afterReady = posted.length;

		disposable.dispose();
		fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "late" } });

		expect(posted.length).toBe(afterReady); // nothing new posted post-dispose
	});

	it("reattaches after detach: a fresh bridge re-snapshots the still-live controller (Phase 7)", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);

		// First view: stream a turn, then detach (dispose only the bridge).
		const first = makeWebview();
		const firstBridge = connectWebview(first.webview as any, controller);
		first.send({ type: "ready" });
		fake.emit({ type: "agent_start" });
		fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "background work" } });
		firstBridge.dispose(); // tab closed → view detached; controller keeps running

		// The controller is untouched by detach — it can still receive events.
		fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " continued" } });

		// Reopen: a brand-new webview + bridge over the SAME controller re-snapshots
		// the current transcript (full history restored, no re-stream duplication).
		const second = makeWebview();
		connectWebview(second.webview as any, controller);
		second.send({ type: "ready" });

		const snapshots = second.posted.filter((m) => m.type === "snapshot");
		expect(snapshots).toHaveLength(1);
		const snap = snapshots[0] as Extract<HostToWebview, { type: "snapshot" }>;
		const group = snap.state.items.find((i) => i.kind === "response");
		expect(group && group.kind === "response" && group.answer).toBe("background work continued");
	});

	it("posts the current review state on ready (so review survives reload)", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		vi.spyOn(controller, "getReviewState").mockReturnValue({
			enabled: true,
			files: [{ path: "src/a.ts", status: "modified", hunkCount: 2 }],
		});
		const { webview, posted, send } = makeWebview();
		connectWebview(webview as any, controller);
		send({ type: "ready" });

		const review = posted.find((m) => m.type === "review") as Extract<HostToWebview, { type: "review" }> | undefined;
		expect(review).toBeDefined();
		expect(review?.review).toEqual({
			enabled: true,
			files: [{ path: "src/a.ts", status: "modified", hunkCount: 2 }],
		});
	});

	it("forwards a review update as a review message when live", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const { webview, posted, send } = makeWebview();
		connectWebview(webview as any, controller);
		send({ type: "ready" });
		const before = posted.filter((m) => m.type === "review").length;

		(controller as any).emit({
			kind: "review",
			review: { enabled: true, files: [{ path: "x.ts", status: "added", hunkCount: 1 }] },
		});

		const reviews = posted.filter((m) => m.type === "review") as Array<Extract<HostToWebview, { type: "review" }>>;
		expect(reviews.length).toBe(before + 1);
		expect(reviews.at(-1)?.review.files).toEqual([{ path: "x.ts", status: "added", hunkCount: 1 }]);
	});

	it("re-posts review state on a resync update", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const { webview, posted, send } = makeWebview();
		connectWebview(webview as any, controller);
		send({ type: "ready" });
		const before = posted.filter((m) => m.type === "review").length;

		await controller.submit("/new");
		const after = posted.filter((m) => m.type === "review").length;
		expect(after).toBeGreaterThan(before);
	});

	it("routes a review-open-diff message to the controller", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const openDiff = vi.spyOn(controller, "reviewOpenDiff").mockResolvedValue();
		const { webview, send } = makeWebview();
		connectWebview(webview as any, controller);
		send({ type: "ready" });

		send({ type: "review-open-diff", path: "src/a.ts" });
		expect(openDiff).toHaveBeenCalledWith("src/a.ts");
	});

	it("routes a review-accept-all message to the controller's reviewAcceptAll", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const acceptAll = vi.spyOn(controller, "reviewAcceptAll").mockResolvedValue();
		const openDiff = vi.spyOn(controller, "reviewOpenDiff").mockResolvedValue();
		const { webview, send } = makeWebview();
		connectWebview(webview as any, controller);
		send({ type: "ready" });

		send({ type: "review-accept-all" });
		expect(acceptAll).toHaveBeenCalledTimes(1);
		// The accept-all dispatch must not touch the per-file open-diff path.
		expect(openDiff).not.toHaveBeenCalled();
	});

	it("does not call reviewAcceptAll for unrelated webview messages", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const acceptAll = vi.spyOn(controller, "reviewAcceptAll").mockResolvedValue();
		vi.spyOn(controller, "reviewOpenDiff").mockResolvedValue();
		const { webview, send } = makeWebview();
		connectWebview(webview as any, controller);
		send({ type: "ready" });

		send({ type: "review-open-diff", path: "src/a.ts" });
		expect(acceptAll).not.toHaveBeenCalled();
	});

	// ── Session tree: fork + restore (Phase 6) ─────────────────────────────

	it("posts current checkpoints on ready (so inline controls survive reload)", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		vi.spyOn(controller, "getCheckpoints").mockReturnValue([
			{ responseId: 1, entryId: "a1", canRestore: false, canFork: true },
		]);
		const { webview, posted, send } = makeWebview();
		connectWebview(webview as any, controller);
		send({ type: "ready" });

		const cp = posted.find((m) => m.type === "checkpoints") as
			| Extract<HostToWebview, { type: "checkpoints" }>
			| undefined;
		expect(cp?.checkpoints).toEqual([{ responseId: 1, entryId: "a1", canRestore: false, canFork: true }]);
	});

	it("forwards checkpoints / tree / composer-prefill updates as messages when live", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const { webview, posted, send } = makeWebview();
		connectWebview(webview as any, controller);
		send({ type: "ready" });

		(controller as any).emit({
			kind: "checkpoints",
			checkpoints: [{ responseId: 2, entryId: "a2", canRestore: true, canFork: true }],
		});
		(controller as any).emit({ kind: "tree", tree: { roots: [], leafId: "a2" } });
		(controller as any).emit({ kind: "composer-prefill", text: "re-ask" });
		(controller as any).emit({ kind: "composer-prefill", text: "restored", mode: "prepend" });

		expect((posted.filter((m) => m.type === "checkpoints").at(-1) as any)?.checkpoints).toEqual([
			{ responseId: 2, entryId: "a2", canRestore: true, canFork: true },
		]);
		expect((posted.find((m) => m.type === "tree") as any)?.tree.leafId).toBe("a2");
		// A replace-style prefill (fork re-ask) carries no mode; the bridge passes that through.
		expect((posted.find((m) => m.type === "composer-prefill") as any)?.text).toBe("re-ask");
		expect((posted.find((m) => m.type === "composer-prefill") as any)?.mode).toBeUndefined();
		// The abort restore tags the prefill "prepend"; the bridge must forward the mode
		// verbatim or the webview silently falls back to replace and clobbers the draft.
		const prepend = posted.filter((m) => m.type === "composer-prefill").at(-1) as any;
		expect(prepend?.text).toBe("restored");
		expect(prepend?.mode).toBe("prepend");
	});

	it("re-posts checkpoints on a resync update", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const { webview, posted, send } = makeWebview();
		connectWebview(webview as any, controller);
		send({ type: "ready" });
		const before = posted.filter((m) => m.type === "checkpoints").length;

		await controller.submit("/new");
		expect(posted.filter((m) => m.type === "checkpoints").length).toBeGreaterThan(before);
	});

	it("routes fork / navigate-tree / show-tree messages to the controller", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const fork = vi.spyOn(controller, "fork").mockResolvedValue();
		const navigate = vi.spyOn(controller, "navigateTree").mockResolvedValue();
		const requestTree = vi.spyOn(controller, "requestTree").mockResolvedValue();
		const { webview, send } = makeWebview();
		connectWebview(webview as any, controller);
		send({ type: "ready" });

		send({ type: "fork", entryId: "a1" });
		send({ type: "navigate-tree", entryId: "a2" });
		send({ type: "show-tree" });

		expect(fork).toHaveBeenCalledWith("a1");
		expect(navigate).toHaveBeenCalledWith("a2");
		expect(requestTree).toHaveBeenCalledTimes(1);
	});
});
