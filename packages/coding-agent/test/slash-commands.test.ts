import { describe, expect, it } from "vitest";
import {
	askArgumentCompletions,
	BUILTIN_SLASH_COMMANDS,
	parseBuiltinSlashCommand,
} from "../src/core/slash-commands.js";

describe("built-in slash commands", () => {
	it.each([
		["/fork", "fork", ""],
		["/fork anything here", "fork", "anything here"],
		["  /compact summarize tests  ", "compact", "summarize tests"],
		["/dream backup /tmp/archive", "dream", "backup /tmp/archive"],
	])("parses %s on the first token", (text, name, args) => {
		expect(parseBuiltinSlashCommand(text)).toMatchObject({ command: { name }, args });
	});

	it.each(["/forklift", "/unknown", "fork", "/", "", "   "])("does not misclassify %j", (text) => {
		expect(parseBuiltinSlashCommand(text)).toBeUndefined();
	});

	it("keeps hidden development commands outside the public registry", () => {
		expect(parseBuiltinSlashCommand("/debug")).toBeUndefined();
		expect(parseBuiltinSlashCommand("/arminsayshi")).toBeUndefined();
	});

	it("opts only copy, hotkeys, and buddy out of dashboard autocomplete", () => {
		expect(
			BUILTIN_SLASH_COMMANDS.filter((command) => command.dashboard === false).map((command) => command.name),
		).toEqual(["copy", "hotkeys", "buddy"]);
	});

	it("registers /ask in the public autocomplete registry", () => {
		const ask = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "ask");
		expect(ask).toBeDefined();
		expect(ask?.dashboard).not.toBe(false); // offered in autocomplete
		expect(ask?.description.toLowerCase()).toContain("ask mode");
		expect(parseBuiltinSlashCommand("/ask on")).toMatchObject({ command: { name: "ask" }, args: "on" });
	});
});

describe("askArgumentCompletions", () => {
	it("offers both on and off with no prefix", () => {
		expect(askArgumentCompletions("")).toEqual([
			{ value: "on", label: "on", description: "Enable read-only Ask mode" },
			{ value: "off", label: "off", description: "Disable read-only Ask mode" },
		]);
	});

	it("filters by a case-insensitive prefix", () => {
		expect(askArgumentCompletions("on")).toEqual([
			{ value: "on", label: "on", description: "Enable read-only Ask mode" },
		]);
		expect(askArgumentCompletions("OF")).toEqual([
			{ value: "off", label: "off", description: "Disable read-only Ask mode" },
		]);
	});

	it("returns null when nothing matches", () => {
		expect(askArgumentCompletions("xyz")).toBeNull();
	});
});
