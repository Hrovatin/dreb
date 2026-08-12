import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findModel } from "@dreb/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { type AgentTypeConfig, createSubagentToolDefinition, scopeAgentsReadOnly } from "../src/core/tools/subagent.js";

async function makeSession(tempDir: string, agentDir: string) {
	const settingsManager = SettingsManager.create(tempDir, agentDir);
	const sessionManager = SessionManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir,
		model: findModel("anthropic", "sonnet")!,
		settingsManager,
		sessionManager,
		resourceLoader,
	});
	return session;
}

describe("AgentSession — read-only Ask mode", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `dreb-ask-mode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("defaults to OFF", async () => {
		const session = await makeSession(tempDir, agentDir);
		expect(session.askModeEnabled).toBe(false);
	});

	it("enabling scopes out edit/write and disabling restores them", async () => {
		const session = await makeSession(tempDir, agentDir);
		const before = session.getActiveToolNames();
		expect(before).toContain("edit");
		expect(before).toContain("write");

		session.enableAskMode();
		expect(session.askModeEnabled).toBe(true);
		const active = session.getActiveToolNames();
		expect(active).not.toContain("edit");
		expect(active).not.toContain("write");
		// bash (the shell) is dropped in Ask mode — replaced by the typed git tool.
		expect(active).not.toContain("bash");
		// Read-only + gated tools remain.
		expect(active).toContain("read");
		expect(active).toContain("git");
		expect(active).toContain("subagent");

		session.disableAskMode();
		expect(session.askModeEnabled).toBe(false);
		const restored = session.getActiveToolNames();
		expect(restored).toContain("edit");
		expect(restored).toContain("write");
	});

	it("setAskMode is idempotent and reports state", async () => {
		const session = await makeSession(tempDir, agentDir);
		expect(session.setAskMode(true)).toBe(true);
		expect(session.setAskMode(true)).toBe(true); // no-op
		expect(session.getActiveToolNames()).not.toContain("write");
		expect(session.setAskMode(false)).toBe(false);
		expect(session.getActiveToolNames()).toContain("write");
	});

	it("injects the Ask-mode persona into the system prompt and removes it on disable", async () => {
		const session = await makeSession(tempDir, agentDir);
		const marker = "Read-only Ask mode is ACTIVE";
		expect(session.state.systemPrompt).not.toContain(marker);

		session.enableAskMode();
		expect(session.state.systemPrompt).toContain(marker);

		session.disableAskMode();
		expect(session.state.systemPrompt).not.toContain(marker);
	});
});

/**
 * End-to-end tests for the `beforeToolCall` guard while Ask mode is active.
 * These exercise the actual installed hook (not just the pure allowlist
 * function or the tool-name set), so a regression in the wiring is caught.
 */
describe("AgentSession — Ask mode beforeToolCall guard", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `dreb-ask-guard-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	// Retrieve the installed beforeToolCall hook from the underlying agent.
	function getGuard(session: Awaited<ReturnType<typeof makeSession>>) {
		const hook = (session as unknown as { agent: { _beforeToolCall?: unknown } }).agent._beforeToolCall as
			| ((ctx: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>)
			| undefined;
		if (!hook) throw new Error("beforeToolCall hook not installed");
		return (name: string, args: unknown) => hook({ toolCall: { name }, args });
	}

	it("hard-blocks the bash tool entirely while Ask mode is on (no shell)", async () => {
		const session = await makeSession(tempDir, agentDir);
		const guard = getGuard(session);

		// Off: bash is not blocked by Ask mode.
		expect(await guard("bash", { command: "npm install" })).toBeUndefined();
		expect(await guard("bash", { command: "git log --oneline" })).toBeUndefined();

		session.enableAskMode();
		// On: EVERY bash command is blocked — there is no shell in Ask mode,
		// including commands that would previously have been "read-only".
		const blocked = await guard("bash", { command: "npm install" });
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain('"bash" tool is disabled');

		const blockedRead = await guard("bash", { command: "git log --oneline" });
		expect(blockedRead?.block).toBe(true);
		expect(blockedRead?.reason).toContain('"bash" tool is disabled');
	});

	it("does NOT block the typed git tool while Ask mode is on", async () => {
		const session = await makeSession(tempDir, agentDir);
		const guard = getGuard(session);

		session.enableAskMode();
		// The git tool is the read-only replacement for `bash git ...`; the
		// beforeToolCall guard must not block it (its own validator enforces
		// read-only args).
		expect(await guard("git", { subcommand: "log", args: ["--oneline"] })).toBeUndefined();
	});

	it("hard-blocks edit and write while Ask mode is on, even if invoked directly", async () => {
		const session = await makeSession(tempDir, agentDir);
		const guard = getGuard(session);

		expect(await guard("edit", { path: "x", oldText: "a", newText: "b" })).toBeUndefined();

		session.enableAskMode();
		const editBlocked = await guard("edit", { path: "x", oldText: "a", newText: "b" });
		expect(editBlocked?.block).toBe(true);
		expect(editBlocked?.reason).toContain('"edit" tool is disabled');

		const writeBlocked = await guard("write", { path: "x", content: "y" });
		expect(writeBlocked?.block).toBe(true);
		expect(writeBlocked?.reason).toContain('"write" tool is disabled');
	});

	it("warns but does NOT auto-off or block on an implicit model-invoked skill tool call", async () => {
		const session = await makeSession(tempDir, agentDir);
		const guard = getGuard(session);
		const warnings: string[] = [];
		session.warnInSession = ((message: string) => {
			warnings.push(message);
		}) as typeof session.warnInSession;

		session.enableAskMode();
		const result = await guard("skill", { skill: "mach6-push" });

		// Not blocked, mode stays ON, and a read-only warning was surfaced.
		expect(result).toBeUndefined();
		expect(session.askModeEnabled).toBe(true);
		expect(warnings.some((w) => w.includes("Ask mode is ON") && w.includes("read-only"))).toBe(true);
	});
});

describe("scopeAgentsReadOnly", () => {
	it("strips write tools (edit/write/bash) and keeps read-only ones", () => {
		const agents = new Map<string, AgentTypeConfig>([
			[
				"Explore",
				{
					name: "Explore",
					description: "",
					tools: "read,grep,bash,edit,write,search",
					readonly: true,
					systemPrompt: "",
				},
			],
		]);
		const scoped = scopeAgentsReadOnly(agents);
		const tools = scoped.get("Explore")?.tools ?? "";
		expect(tools).toContain("read");
		expect(tools).toContain("grep");
		expect(tools).not.toContain("edit");
		expect(tools).not.toContain("write");
		expect(tools).not.toContain("bash");
		// readonly flag preserved
		expect(scoped.get("Explore")?.readonly).toBe(true);
	});

	it("falls back to a safe read-only set when no read-only tools remain", () => {
		const agents = new Map<string, AgentTypeConfig>([
			["Writer", { name: "Writer", description: "", tools: "edit,write,bash", systemPrompt: "" }],
		]);
		const scoped = scopeAgentsReadOnly(agents);
		expect(scoped.get("Writer")?.tools).toBe("read,grep,find,git,ls");
	});
});

describe("subagent tool — read-only gate", () => {
	const makeTool = (readOnly: boolean) =>
		createSubagentToolDefinition(process.cwd(), {
			isReadOnlyMode: () => readOnly,
			// no onBackgroundComplete: readonly agents pass the gate then hit the
			// "requires background support" path — which is fine for gate assertions.
		});

	it("rejects a non-read-only agent type when in read-only mode", async () => {
		const tool = makeTool(true);
		const result = await tool.execute(
			"id",
			{ task: "do work", agent: "feature-dev" } as never,
			undefined as never,
			() => {},
			undefined as never,
		);
		const text = result.content.map((c) => ("text" in c ? c.text : "")).join(" ");
		expect(text).toContain("cannot delegate to non-read-only agent");
		expect(text).toContain("feature-dev");
	});

	it("allows a read-only agent type (Explore) through the gate", async () => {
		const tool = makeTool(true);
		const result = await tool.execute(
			"id",
			{ task: "explore", agent: "Explore" } as never,
			undefined as never,
			() => {},
			undefined as never,
		);
		const text = result.content.map((c) => ("text" in c ? c.text : "")).join(" ");
		expect(text).not.toContain("cannot delegate to non-read-only agent");
	});

	it("does not gate agent types when not in read-only mode", async () => {
		const tool = makeTool(false);
		const result = await tool.execute(
			"id",
			{ task: "do work", agent: "feature-dev" } as never,
			undefined as never,
			() => {},
			undefined as never,
		);
		const text = result.content.map((c) => ("text" in c ? c.text : "")).join(" ");
		expect(text).not.toContain("cannot delegate to non-read-only agent");
	});
});
