import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.js";

/**
 * Regression coverage for issue 75: renaming a session must persist to disk so
 * the new name is reflected in `SessionManager.list` (the VSCode sidebar source)
 * and `/resume`. The session file is normally deferred until the first assistant
 * reply so abandoned/empty sessions don't litter the directory; an explicit
 * rename (`session_info`) is durable user intent and must be written immediately.
 */

const assistantMessage = (text: string) =>
	({
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 2,
	}) as unknown as Parameters<SessionManager["appendMessage"]>[0];

/** Parse a JSONL session file into its entries. */
function readEntries(file: string): Array<{ type: string; id?: string }> {
	return readFileSync(file, "utf-8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

describe("SessionManager rename persistence (issue 75)", () => {
	let dir: string;
	const cwd = "/tmp/rename-persistence-cwd";

	beforeEach(() => {
		dir = join(tmpdir(), `rename-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("persists an explicit rename made before the first assistant reply", async () => {
		const sm = SessionManager.create(cwd, dir);
		sm.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		sm.appendSessionInfo("My Named Chat");

		const file = sm.getSessionFile();
		expect(file).toBeTruthy();
		expect(existsSync(file as string)).toBe(true);
		expect(sm.getSessionName()).toBe("My Named Chat");

		// The name is visible to the sidebar/`/resume` listing, which reads from disk.
		const list = await SessionManager.list(cwd, dir);
		expect(list).toHaveLength(1);
		expect(list[0].name).toBe("My Named Chat");
	});

	it("still defers persistence for an un-named session with no assistant reply", async () => {
		const sm = SessionManager.create(cwd, dir);
		sm.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		// No rename and no assistant reply: nothing should hit disk yet.
		expect(existsSync(sm.getSessionFile() as string)).toBe(false);
		const list = await SessionManager.list(cwd, dir);
		expect(list).toHaveLength(0);
	});

	it("does not duplicate earlier entries when an assistant reply follows a pre-reply rename", async () => {
		const sm = SessionManager.create(cwd, dir);
		sm.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		sm.appendSessionInfo("Named Early");
		// The assistant reply flushes via the append path, not a full re-flush.
		sm.appendMessage(assistantMessage("hi there"));

		const file = sm.getSessionFile() as string;
		const entries = readEntries(file);

		// Each persisted entry appears exactly once (header + user + session_info + assistant).
		const ids = entries.filter((e) => e.id).map((e) => e.id as string);
		expect(new Set(ids).size).toBe(ids.length);
		expect(entries.filter((e) => e.type === "session").length).toBe(1);
		expect(entries.filter((e) => e.type === "message").length).toBe(2);
		expect(entries.filter((e) => e.type === "session_info").length).toBe(1);

		const list = await SessionManager.list(cwd, dir);
		expect(list[0].name).toBe("Named Early");
		expect(list[0].messageCount).toBe(2);
	});

	it("persists a rename on an already-flushed session without duplication", async () => {
		const sm = SessionManager.create(cwd, dir);
		sm.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		sm.appendMessage(assistantMessage("hi there"));

		// Renaming after the session already has content still lands on disk.
		sm.appendSessionInfo("Renamed Later");

		const entries = readEntries(sm.getSessionFile() as string);
		const ids = entries.filter((e) => e.id).map((e) => e.id as string);
		expect(new Set(ids).size).toBe(ids.length);
		expect(entries.filter((e) => e.type === "message").length).toBe(2);

		const list = await SessionManager.list(cwd, dir);
		expect(list[0].name).toBe("Renamed Later");
	});

	it("reflects the latest rename when a resumed session is renamed (disk-only path)", async () => {
		// Seed a persisted session with a real exchange.
		const seed = SessionManager.create(cwd, dir);
		seed.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		seed.appendMessage(assistantMessage("hi there"));
		const file = seed.getSessionFile() as string;

		// Resume it in a fresh manager (mirrors the sidebar's headless-resume rename)
		// and rename.
		const resumed = SessionManager.open(file, dir);
		expect(resumed.getSessionName()).toBeUndefined();
		resumed.appendSessionInfo("Resumed Rename");

		const list = await SessionManager.list(cwd, dir);
		expect(list).toHaveLength(1);
		expect(list[0].name).toBe("Resumed Rename");
	});
});
