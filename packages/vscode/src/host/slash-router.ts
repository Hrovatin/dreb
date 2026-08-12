/**
 * Pure slash-command routing. Given the composer text and the set of commands
 * advertised by the agent (`get_commands`), decide how to dispatch:
 *
 *   - plain text            → send to the agent via `prompt`
 *   - a registered command  → send verbatim via `prompt` (dreb expands it)
 *   - a known TUI builtin    → route to a dedicated RPC method (host-handled)
 *   - anything else          → an unknown command
 *
 * Built-in TUI commands (`/model`, `/compact`, `/tree`, `/resume`, `/settings`)
 * are NOT returned by `get_commands` and would be no-ops if sent through
 * `prompt`, so they must be recognized here and mapped to RPC equivalents.
 * No DOM/vscode/@dreb imports — unit-testable in plain node.
 */

import type { SlashCommandDto } from "../shared/protocol.js";

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
	| { kind: "builtin"; command: BuiltinCommand; arg?: string }
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

	if (BUILTIN_NAMES.has(name as BuiltinCommand)) {
		return { kind: "builtin", command: name as BuiltinCommand, arg: rest.length > 0 ? rest : undefined };
	}

	// A command dreb advertised (extension/prompt/skill) is expanded server-side,
	// so forward the raw input through prompt.
	const known = commands.some((c) => stripSlash(c.name) === name && c.source === "agent");
	if (known) return { kind: "prompt", message: input };

	return { kind: "unknown-command", name };
}
