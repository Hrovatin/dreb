import { describe, expect, it } from "vitest";
import { type RpcClientLike, SessionController } from "../src/host/session-controller.js";

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
	/** When set, the next prompt/compact/abort call rejects with this error. */
	callError: Error | undefined;
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
	async compact(customInstructions?: string): Promise<unknown> {
		if (this.callError) throw this.callError;
		this.compactions.push(customInstructions);
		return {};
	}
	async getCommands(): Promise<
		Array<{
			name: string;
			description?: string;
			source: "extension" | "prompt" | "skill" | "builtin";
			dashboard?: boolean;
		}>
	> {
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
	emit(event: unknown): void {
		this.eventListener?.(event);
	}
	emitExit(info: unknown): void {
		this.exitListener?.(info);
	}
}

function makeController(fake: FakeClient, cwd = "/tmp/project") {
	return new SessionController({ cwd, cliPath: "/cli.js", clientFactory: () => fake });
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

	it("forwards registered agent commands through prompt", async () => {
		const fake = new FakeClient();
		fake.commandsResult = [{ name: "review", source: "prompt" }];
		const controller = makeController(fake);
		await controller.start();

		await controller.submit("/review 42");
		expect(fake.prompts).toEqual(["/review 42"]);
	});

	it("intercepts server builtins from get_commands instead of routing them to prompt", async () => {
		// Regression: builtins advertised by get_commands (source "builtin") must
		// NOT be forwarded via prompt — the server rejects them and the rejection
		// is silently dropped, so the user sees nothing. They must be intercepted.
		const fake = new FakeClient();
		fake.commandsResult = [
			{ name: "new", description: "New session", source: "builtin" },
			{ name: "quit", description: "Quit", source: "builtin", dashboard: false },
			{ name: "review", source: "extension" },
		];
		const controller = makeController(fake);
		await controller.start();

		// A dashboard-visible builtin appears in the dropdown with source "builtin".
		const knew = controller.getCommandList().find((c) => c.name === "new");
		expect(knew?.source).toBe("builtin");
		// dashboard:false builtins are hidden from the dropdown.
		expect(controller.getCommandList().some((c) => c.name === "quit")).toBe(false);

		await controller.submit("/new");
		expect(fake.prompts).toHaveLength(0); // never forwarded to prompt
		expect(controller.getTranscript().statusText).toMatch(/isn't available yet/);
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

	it("surfaces a notice for unwired builtins without calling the client", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		await controller.start();

		await controller.submit("/model");

		expect(fake.prompts).toHaveLength(0);
		expect(fake.compactions).toHaveLength(0);
		expect(controller.getTranscript().statusText).toMatch(/model/);
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

	it("drops a submit with a notice when the client is not started yet", async () => {
		const fake = new FakeClient();
		const controller = makeController(fake);
		// No start() — client is not created yet.
		await controller.submit("hello");
		expect(fake.prompts).toHaveLength(0);
		expect(controller.getTranscript().statusText).toMatch(/starting up/);
	});
});
