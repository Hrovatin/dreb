import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findModel } from "@dreb/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

// Remove GIT_* env vars that leak from git hooks
const { GIT_DIR: _, GIT_INDEX_FILE: __, GIT_WORK_TREE: ___, ...cleanEnv } = process.env;

function git(cwd: string, args: string): void {
	execSync(`git ${args}`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], env: cleanEnv });
}

describe("AgentSession chdir integration", () => {
	let tempDir: string;
	let agentDir: string;
	let repoDir: string;
	let subDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `dreb-chdir-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		repoDir = join(tempDir, "repo");
		subDir = join(repoDir, "subdir");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(subDir, { recursive: true });

		// Initialize a git repo
		git(repoDir, "init -q");
		git(repoDir, "config user.email test@test.com");
		git(repoDir, "config user.name Test");
		git(repoDir, "config commit.gpgsign false");
		writeFileSync(join(repoDir, "README.md"), "hello\n");
		git(repoDir, "add README.md");
		git(repoDir, "commit -q -m init");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("chdir tool is active in default session", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: repoDir,
			agentDir,
			settingsManager,
			extensionFactories: [],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: repoDir,
			agentDir,
			model: findModel("anthropic", "sonnet")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		expect(session.getActiveToolNames()).toContain("chdir");
	});

	it("_changeCwd updates session cwd and rebuilds tools", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: repoDir,
			agentDir,
			settingsManager,
			extensionFactories: [],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: repoDir,
			agentDir,
			model: findModel("anthropic", "sonnet")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		// Verify initial cwd
		expect((session as any)._cwd).toBe(repoDir);

		// Invoke the chdir tool directly via its definition
		const chdirDef = session.getToolDefinition("chdir");
		expect(chdirDef).toBeDefined();

		const result = await chdirDef!.execute("test-call-id", { path: subDir }, undefined, undefined, undefined as any);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Changed working directory"),
		});

		// Verify cwd was updated
		expect((session as any)._cwd).toBe(subDir);

		// Verify system prompt reflects new cwd
		expect(session.systemPrompt).toContain(subDir);
	});

	it("after chdir, rebuilt tools resolve paths against new cwd", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: repoDir,
			agentDir,
			settingsManager,
			extensionFactories: [],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: repoDir,
			agentDir,
			model: findModel("anthropic", "sonnet")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		// Verify initial cwd
		expect((session as any)._cwd).toBe(repoDir);

		// Get edit tool before chdir — it should resolve relative paths against repoDir
		const editBefore = session.getToolDefinition("edit");
		expect(editBefore).toBeDefined();

		// Execute chdir to subDir
		const chdirDef = session.getToolDefinition("chdir");
		await chdirDef!.execute("test-call-id", { path: subDir }, undefined, undefined, undefined as any);

		// Verify cwd was updated
		expect((session as any)._cwd).toBe(subDir);

		// Get edit tool AFTER chdir — it should be a new instance with the new cwd
		const editAfter = session.getToolDefinition("edit");
		expect(editAfter).toBeDefined();

		// The tool instances should be different (rebuilt)
		expect(editAfter).not.toBe(editBefore);

		// Verify the new edit tool resolves paths against the new cwd by executing
		// an edit on a file in subDir. Create a file in subDir first.
		writeFileSync(join(subDir, "test-file.txt"), "old content\n");

		const editResult = await editAfter!.execute(
			"edit-call-id",
			{ path: "test-file.txt", oldText: "old content\n", newText: "new content\n" },
			undefined,
			undefined,
			undefined as any,
		);

		// Should succeed — resolves "test-file.txt" against subDir (new cwd)
		expect(editResult.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("test-file.txt"),
		});

		// Verify the file was actually edited in subDir
		const { readFileSync } = await import("node:fs");
		expect(readFileSync(join(subDir, "test-file.txt"), "utf-8")).toBe("new content\n");
	});

	it("_changeCwd rolls back on _buildRuntime failure", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: repoDir,
			agentDir,
			settingsManager,
			extensionFactories: [],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: repoDir,
			agentDir,
			model: findModel("anthropic", "sonnet")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		// Sabotage _buildRuntime to throw
		const _originalBuildRuntime = (session as any)._buildRuntime.bind(session);
		let buildCalled = false;
		(session as any)._buildRuntime = () => {
			buildCalled = true;
			throw new Error("simulated _buildRuntime failure");
		};

		// Attempt to change cwd — should throw and rollback
		expect(() => (session as any)._changeCwd(subDir)).toThrow("simulated _buildRuntime failure");
		expect(buildCalled).toBe(true);

		// Verify cwd was rolled back
		expect((session as any)._cwd).toBe(repoDir);
	});
});
