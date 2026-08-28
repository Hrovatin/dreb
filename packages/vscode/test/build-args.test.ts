import { shouldProjectRpcEvents } from "@dreb/coding-agent/rpc";
import { describe, expect, it } from "vitest";
import { buildArgs, type ConfigReader } from "../src/host/build-args.js";

/** A {@link ConfigReader} backed by a plain record. */
function config(values: Record<string, string> = {}): ConfigReader {
	return {
		get<T>(section: string): T | undefined {
			return values[section] as T | undefined;
		},
	};
}

/** Return the value passed to the `--ui` flag, or undefined if absent. */
function uiFlag(args: string[]): string | undefined {
	const i = args.indexOf("--ui");
	return i >= 0 ? args[i + 1] : undefined;
}

describe("buildArgs (issue 84 wiring)", () => {
	it("always emits --ui vscode so the RPC child bounds the message_update stream", () => {
		const args = buildArgs(config());
		expect(uiFlag(args)).toBe("vscode");
	});

	it("emits --ui before provider/model", () => {
		const args = buildArgs(config({ provider: "openai", model: "gpt-x" }));
		expect(args.slice(0, 2)).toEqual(["--ui", "vscode"]);
		expect(args).toEqual(["--ui", "vscode", "--provider", "openai", "--model", "gpt-x"]);
	});

	it("omits provider/model when unset or blank", () => {
		expect(buildArgs(config({ provider: "  ", model: "" }))).toEqual(["--ui", "vscode"]);
	});

	// Cross-package drift guard: the `--ui` value buildArgs emits MUST be one the
	// coding-agent RPC layer projects. If either side is renamed/typo'd, this
	// fails CI instead of silently reverting VSCode to the O(n^2) crash (issue 84).
	it("emits a --ui value the RPC layer actually projects", () => {
		const ui = uiFlag(buildArgs(config()));
		expect(ui).toBeDefined();
		expect(shouldProjectRpcEvents(ui)).toBe(true);
	});
});
