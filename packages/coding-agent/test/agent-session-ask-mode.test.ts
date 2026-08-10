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
		// Read-only + gated tools remain.
		expect(active).toContain("read");
		expect(active).toContain("bash");
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
		expect(scoped.get("Writer")?.tools).toBe("read,grep,find,ls");
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
