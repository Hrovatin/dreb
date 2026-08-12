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
	async compact(): Promise<unknown> {
		return {};
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

		// A child crash drives both a host_error event and a status update; both
		// must reach the webview now that it is live.
		fake.emitExit({ code: 1, signal: null });
		expect(posted.some((m) => m.type === "status")).toBe(true);
		expect(posted.some((m) => m.type === "event" && (m.event as any)?.type === "host_error")).toBe(true);
	});

	it("dispatches webview messages to the controller", async () => {
		const fake = new BridgeFakeClient();
		const controller = await makeController(fake);
		const submit = vi.spyOn(controller, "submit").mockResolvedValue();
		const abort = vi.spyOn(controller, "abort").mockResolvedValue();
		const respondUi = vi.spyOn(controller, "respondUi").mockImplementation(() => {});
		const refresh = vi.spyOn(controller, "refreshCommands");

		const { webview, send } = makeWebview();
		connectWebview(webview as any, controller);

		send({ type: "submit", text: "hi there" });
		send({ type: "abort" });
		send({ type: "ui-response", response: { id: "u1", confirmed: true } });
		send({ type: "refresh-commands" });

		expect(submit).toHaveBeenCalledWith("hi there");
		expect(abort).toHaveBeenCalledTimes(1);
		expect(respondUi).toHaveBeenCalledWith({ id: "u1", confirmed: true });
		expect(refresh).toHaveBeenCalled();
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
});
