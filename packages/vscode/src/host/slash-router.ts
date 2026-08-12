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
 * than forwarded as a prompt. Only `/compact` is wired in this early build; the
 * rest surface a "not available yet" notice instead of silently doing nothing.
 * No DOM/vscode/@dreb imports — unit-testable in plain node.
 */

import type { SlashCommandDto } from "../shared/protocol.js";

/** Built-ins the host has a dedicated handler for (the rest emit a notice). */
export type BuiltinCommand = "compact" | "model" | "tree" | "resume" | "settings";

/** Builtin commands surfaced in the composer dropdown alongside agent commands. */
export const BUILTIN_COMMANDS: SlashCommandDto[] = [
	{ name: "compact", description: "Summarize and compact the conversation context", source: "builtin" },
	{ name: "model", description: "Switch the active model", source: "builtin" },
	{ name: "tree", description: "Browse and navigate the session tree", source: "builtin" },
	{ name: "resume", description: "Resume a previous session", source: "builtin" },
	{ name: "settings", description: "Open dreb settings", source: "builtin" },
];

const BUILTIN_NAMES = new Set<BuiltinCommand>(BUILTIN_COMMANDS.map((c) => c.name as BuiltinCommand));

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
	if (advertised?.source === "builtin" || BUILTIN_NAMES.has(name as BuiltinCommand)) {
		return { kind: "builtin", command: name, arg };
	}

	// A resource command dreb advertised (extension/prompt/skill) is expanded
	// server-side, so forward the raw input through prompt.
	if (advertised?.source === "agent") return { kind: "prompt", message: input };

	return { kind: "unknown-command", name };
}
