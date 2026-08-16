/**
 * Pure slash-command routing. Given the composer text and the set of commands
 * advertised by the agent (`get_commands`), decide how to dispatch:
 *
 *   - plain text            → send to the agent via `prompt`
 *   - a resource command    → send verbatim via `prompt` (dreb expands it)
 *   - a built-in command     → route to a host-handled RPC method (never `prompt`)
 *   - anything else          → an unknown command
 *
 * Built-in commands (`/compact`, `/new`, `/quit`, `/model`, …) ARE returned by
 * `get_commands` with `source: "builtin"`, but the server *rejects* them when
 * sent through `prompt` (the rejection is silently discarded by the RPC client),
 * so every builtin must be intercepted here and routed to a host handler rather
 * than forwarded as a prompt. The controller dispatches wired builtins to their
 * RPC method / native UI; recognized-but-unwired builtins surface a notice.
 * No DOM/vscode/@dreb imports — unit-testable in plain node.
 */

import type { SlashCommandDto } from "../shared/protocol.js";

/** Builtin commands the host dispatches to an RPC method / native UI. */
export const BUILTIN_COMMANDS: SlashCommandDto[] = [
	{ name: "model", description: "Switch the active model", source: "builtin" },
	{ name: "compact", description: "Summarize and compact the conversation context", source: "builtin" },
	{ name: "ask", description: "Toggle read-only Ask mode (on/off)", source: "builtin" },
	{ name: "new", description: "Start a new session", source: "builtin" },
	{ name: "reload", description: "Reload skills, extensions, prompts, and settings", source: "builtin" },
	{ name: "dream", description: "Consolidate and prune memories", source: "builtin" },
	{ name: "session", description: "Show session info and stats", source: "builtin" },
	{ name: "name", description: "Set the session display name", source: "builtin" },
	{ name: "export", description: "Export the session to HTML", source: "builtin" },
	{ name: "import", description: "Import and resume a session from JSONL", source: "builtin" },
	{ name: "quit", description: "End the session", source: "builtin" },
];

/** Builtins recognized but not yet wired — dispatched with a "later phase"
 * notice. They need UI surfaces owned by later phases (settings/sessions/tree). */
export const DEFERRED_BUILTINS = new Set(["settings", "scoped-models", "fork", "tree", "resume"]);

/** Builtins with no RPC equivalent — only meaningful in the terminal UI. */
export const TERMINAL_ONLY_BUILTINS = new Set(["login", "logout", "copy", "hotkeys", "buddy"]);

/** All builtin names the router intercepts even without a server advertisement
 * (the wired fallback list plus the recognized-but-unwired ones). */
const BUILTIN_NAMES = new Set<string>([
	...BUILTIN_COMMANDS.map((c) => c.name),
	...DEFERRED_BUILTINS,
	...TERMINAL_ONLY_BUILTINS,
]);

export type RouteDecision =
	| { kind: "empty" }
	| { kind: "prompt"; message: string }
	| { kind: "builtin"; command: string; arg?: string }
	| { kind: "unknown-command"; name: string };

/** Strip a single leading slash so command names compare uniformly. */
export function stripSlash(name: string): string {
	return name.startsWith("/") ? name.slice(1) : name;
}

export function routeInput(input: string, commands: readonly SlashCommandDto[] = []): RouteDecision {
	const trimmed = input.trim();
	if (trimmed.length === 0) return { kind: "empty" };
	if (!trimmed.startsWith("/")) return { kind: "prompt", message: input };

	const match = /^\/(\S+)\s*([\s\S]*)$/.exec(trimmed);
	// A lone "/" (or "/ ") is not a command — treat as normal prompt text.
	if (!match) return { kind: "prompt", message: input };

	const name = match[1];
	const rest = match[2].trim();
	const arg = rest.length > 0 ? rest : undefined;

	const advertised = commands.find((c) => stripSlash(c.name) === name);

	// Built-ins are host-handled: forwarding them via `prompt` is rejected
	// server-side and the rejection is silently swallowed, so intercept every
	// builtin here (whether advertised by get_commands or a hardcoded fallback).
	if (advertised?.source === "builtin" || BUILTIN_NAMES.has(name)) {
		return { kind: "builtin", command: name, arg };
	}

	// A resource command dreb advertised (extension/prompt/skill) is expanded
	// server-side, so forward the raw input through prompt.
	if (advertised?.source === "agent") return { kind: "prompt", message: input };

	return { kind: "unknown-command", name };
}
