import { describe, expect, it } from "vitest";
import { routeInput, stripSlash } from "../src/host/slash-router.js";
import type { SlashCommandDto } from "../src/shared/protocol.js";

const agentCommands: SlashCommandDto[] = [
	{ name: "review", description: "Review a PR", source: "agent" },
	{ name: "compact", description: "shadowed builtin name", source: "agent" },
];

describe("slash-router", () => {
	it("treats plain text as a prompt", () => {
		expect(routeInput("hello world")).toEqual({ kind: "prompt", message: "hello world" });
	});

	it("returns empty for blank input", () => {
		expect(routeInput("   ")).toEqual({ kind: "empty" });
		expect(routeInput("")).toEqual({ kind: "empty" });
	});

	it("routes builtins to their command with an optional argument", () => {
		expect(routeInput("/compact")).toEqual({ kind: "builtin", command: "compact", arg: undefined });
		expect(routeInput("/compact keep the tests")).toEqual({
			kind: "builtin",
			command: "compact",
			arg: "keep the tests",
		});
		expect(routeInput("/model")).toEqual({ kind: "builtin", command: "model", arg: undefined });
	});

	it("prefers the builtin mapping over a same-named agent command", () => {
		// A builtin like /compact must map to the RPC method, never be sent as a
		// prompt, even if get_commands also advertised it.
		expect(routeInput("/compact", agentCommands)).toEqual({ kind: "builtin", command: "compact", arg: undefined });
	});

	it("forwards a registered agent command verbatim through prompt", () => {
		expect(routeInput("/review 42", agentCommands)).toEqual({ kind: "prompt", message: "/review 42" });
	});

	it("intercepts an advertised builtin (not a wired one) instead of prompting", () => {
		// `/new` is a server builtin (source "builtin") the host doesn't wire yet.
		// It must be intercepted — never forwarded to prompt (which the server
		// rejects and silently drops) — so `submit` can surface a notice.
		const withBuiltin: SlashCommandDto[] = [{ name: "new", description: "New session", source: "builtin" }];
		expect(routeInput("/new", withBuiltin)).toEqual({ kind: "builtin", command: "new", arg: undefined });
	});

	it("intercepts wired-fallback, deferred, and terminal-only builtins by name", () => {
		// Even without a get_commands advertisement, the router recognizes every
		// builtin name (wired fallback + deferred + terminal-only) and intercepts
		// it so submit never forwards it to prompt.
		expect(routeInput("/export a.html")).toEqual({ kind: "builtin", command: "export", arg: "a.html" });
		expect(routeInput("/fork")).toEqual({ kind: "builtin", command: "fork", arg: undefined });
		expect(routeInput("/login")).toEqual({ kind: "builtin", command: "login", arg: undefined });
	});

	it("flags an unknown slash command", () => {
		expect(routeInput("/bogus now")).toEqual({ kind: "unknown-command", name: "bogus" });
	});

	it("treats a lone slash as prompt text", () => {
		expect(routeInput("/")).toEqual({ kind: "prompt", message: "/" });
	});

	it("normalizes command names", () => {
		expect(stripSlash("/compact")).toBe("compact");
		expect(stripSlash("compact")).toBe("compact");
	});
});
