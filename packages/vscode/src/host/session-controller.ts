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

import { applyEvent, createTranscriptState, type TranscriptState } from "../shared/projection.js";
import type { HostStatus, SlashCommandDto, UiResponse } from "../shared/protocol.js";
import { BUILTIN_COMMANDS, routeInput, stripSlash } from "./slash-router.js";

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
	/** Override the RpcClient constructor (tests inject a fake). */
	clientFactory?: RpcClientFactory;
	logger?: (line: string) => void;
}

export type ControllerUpdate = { kind: "event"; event: unknown } | { kind: "status"; status: HostStatus };

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

export class SessionController {
	private readonly state: TranscriptState = createTranscriptState();
	private readonly listeners = new Set<(update: ControllerUpdate) => void>();
	private readonly factory: RpcClientFactory;
	private readonly logger: (line: string) => void;
	private readonly options: SessionControllerOptions;
	private client: RpcClientLike | undefined;
	private commands: SlashCommandDto[] = [...BUILTIN_COMMANDS];
	private status: HostStatus;
	private unsubEvent: (() => void) | undefined;
	private unsubExit: (() => void) | undefined;
	private disposed = false;

	constructor(options: SessionControllerOptions) {
		this.options = options;
		this.factory = options.clientFactory ?? defaultClientFactory;
		this.logger = options.logger ?? (() => {});
		this.status = { connected: false, cwd: options.cwd };
	}

	get cwd(): string {
		return this.options.cwd;
	}

	getTranscript(): TranscriptState {
		return this.state;
	}

	getStatus(): HostStatus {
		return this.status;
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
		const client = await this.factory({
			cliPath: this.options.cliPath,
			cwd: this.options.cwd,
			args: this.options.args ?? [],
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
		await this.refreshCommands();
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
	async submit(text: string): Promise<void> {
		if (!this.client || !this.status.connected) {
			this.emitNotice(
				this.status.error
					? "dreb isn't connected — reopen the chat to restart it."
					: "dreb is still starting up — try again in a moment.",
			);
			return;
		}
		const decision = routeInput(text, this.commands);
		if (decision.kind === "empty") return;
		try {
			switch (decision.kind) {
				case "prompt":
					await this.client.prompt(decision.message);
					return;
				case "builtin":
					if (decision.command === "compact") {
						await this.client.compact(decision.arg);
						return;
					}
					this.emitNotice(`The /${decision.command} command isn't available yet in this early build.`);
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

	async dispose(): Promise<void> {
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

	private handleEvent(event: unknown): void {
		applyEvent(this.state, event);
		this.emit({ kind: "event", event });
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
