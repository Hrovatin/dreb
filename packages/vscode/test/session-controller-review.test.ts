/**
 * Controller-level change-review wiring, exercised against a real temp git repo.
 * Verifies the turn_start → capture, agent_end → detect flow, the emitted
 * `review` updates, and the accept/revert methods — with a recording ReviewUi
 * fake standing in for the native SCM surface.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReviewUi } from "../src/host/review-ui.js";
import { type ControllerUpdate, type RpcClientLike, SessionController } from "../src/host/session-controller.js";
import type { ReviewFileDto } from "../src/shared/protocol.js";

/** Minimal RpcClient fake: connects, streams events, returns benign status. */
class MiniClient implements RpcClientLike {
	private ev: ((e: any) => void) | undefined;
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {}
	async abort(): Promise<void> {}
	async compact(): Promise<unknown> {
		return {};
	}
	async getCommands() {
		return [];
	}
	sendExtensionUIResponse(): void {}
	onEvent(listener: (event: any) => void): () => void {
		this.ev = listener;
		return () => {
			this.ev = undefined;
		};
	}
	onExit(): () => void {
		return () => {};
	}
	async getState() {
		return {};
	}
	async getDailyCost(): Promise<number> {
		return 0;
	}
	async getSessionStats() {
		return { cost: 0 };
	}
	async getAvailableModels() {
		return [];
	}
	async setModel(provider: string, modelId: string) {
		return { provider, id: modelId };
	}
	async setThinkingLevel(): Promise<void> {}
	async newSession() {
		return { cancelled: false };
	}
	async reload(): Promise<void> {}
	async dream() {
		return { message: "" };
	}
	async setSessionName(): Promise<void> {}
	async exportHtml() {
		return { path: "" };
	}
	async importJsonl() {
		return { cancelled: false };
	}
	emit(event: unknown): void {
		this.ev?.(event);
	}
}

/** Recording ReviewUi. */
class RecordingReviewUi implements ReviewUi {
	baselines = new Map<string, string | null>();
	pending: ReviewFileDto[] = [];
	opened: string[] = [];
	clears = 0;
	setBaseline(path: string, content: string | null): void {
		this.baselines.set(path, content);
	}
	setPending(files: ReviewFileDto[]): void {
		this.pending = files;
	}
	async openDiff(path: string): Promise<void> {
		this.opened.push(path);
	}
	clear(): void {
		this.clears += 1;
		this.pending = [];
	}
}

function git(args: string[], cwd: string): void {
	const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function initRepo(dir: string): void {
	git(["init", "--initial-branch=main"], dir);
	git(["config", "--local", "user.email", "t@t.com"], dir);
	git(["config", "--local", "user.name", "Test"], dir);
	git(["config", "--local", "commit.gpgsign", "false"], dir);
}

const body = (n = 20) => `${Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n")}\n`;

async function startController(
	cwd: string,
	review: ReviewUi,
): Promise<{ controller: SessionController; client: MiniClient; updates: ControllerUpdate[] }> {
	const client = new MiniClient();
	const controller = new SessionController({
		cwd,
		cliPath: "unused",
		clientFactory: () => client,
		review,
	});
	const updates: ControllerUpdate[] = [];
	controller.onUpdate((u) => updates.push(u));
	await controller.start();
	return { controller, client, updates };
}

/** Let queued microtasks (the async status refresh) settle. */
const flush = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("SessionController change review", () => {
	let repo: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "dreb-ctrl-review-"));
		initRepo(repo);
		writeFileSync(join(repo, "file.txt"), body());
		git(["add", "file.txt"], repo);
		git(["commit", "-m", "init"], repo);
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("captures on turn_start and publishes the changed file on agent_end", async () => {
		const review = new RecordingReviewUi();
		const { controller, client, updates } = await startController(repo, review);

		client.emit({ type: "turn_start" });
		// Agent edits a file mid-turn.
		const edited = body().replace("line3", "AGENT3");
		writeFileSync(join(repo, "file.txt"), edited);
		client.emit({ type: "agent_end", messages: [] });
		await flush();

		const reviewUpdate = updates.filter((u) => u.kind === "review").at(-1);
		expect(reviewUpdate).toBeDefined();
		expect(controller.getReviewState().files).toEqual([{ path: "file.txt", status: "modified", hunkCount: 1 }]);
		expect(review.pending.map((f) => f.path)).toEqual(["file.txt"]);
		expect(review.baselines.get("file.txt")).toBe(body());
	});

	it("reverting the file discards the change and clears the pending set", async () => {
		const review = new RecordingReviewUi();
		const { controller, client } = await startController(repo, review);

		client.emit({ type: "turn_start" });
		writeFileSync(join(repo, "file.txt"), body().replace("line3", "AGENT3"));
		client.emit({ type: "agent_end", messages: [] });
		await flush();
		expect(controller.getReviewState().files).toHaveLength(1);

		await controller.reviewRevertFile("file.txt");
		expect(readFileSync(join(repo, "file.txt"), "utf-8")).toBe(body());
		expect(controller.getReviewState().files).toEqual([]);
	});

	it("acceptAll clears review state and the surface without touching the file", async () => {
		const review = new RecordingReviewUi();
		const { controller, client } = await startController(repo, review);

		client.emit({ type: "turn_start" });
		const edited = body().replace("line3", "AGENT3");
		writeFileSync(join(repo, "file.txt"), edited);
		client.emit({ type: "agent_end", messages: [] });
		await flush();

		await controller.reviewAcceptAll();
		expect(controller.getReviewState().files).toEqual([]);
		expect(review.clears).toBeGreaterThanOrEqual(1);
		// Accept keeps the change on disk (no commit, no revert).
		expect(readFileSync(join(repo, "file.txt"), "utf-8")).toBe(edited);
	});

	it("rejectHunkAtLine reverts only the hunk at that line", async () => {
		const review = new RecordingReviewUi();
		const { controller, client } = await startController(repo, review);

		client.emit({ type: "turn_start" });
		const edited = body().replace("line3", "AGENT3").replace("line16", "AGENT16");
		writeFileSync(join(repo, "file.txt"), edited);
		client.emit({ type: "agent_end", messages: [] });
		await flush();

		// Line 3 is in the first hunk.
		expect(await controller.reviewRejectHunkAtLine("file.txt", 3)).toBe(true);
		const after = readFileSync(join(repo, "file.txt"), "utf-8").split("\n");
		expect(after[2]).toBe("line3"); // reverted
		expect(after[15]).toBe("AGENT16"); // preserved
	});

	it("disables review outside a git repo", async () => {
		const plain = mkdtempSync(join(tmpdir(), "dreb-ctrl-plain-"));
		try {
			const review = new RecordingReviewUi();
			const { controller, client } = await startController(plain, review);
			client.emit({ type: "turn_start" });
			writeFileSync(join(plain, "file.txt"), "x");
			client.emit({ type: "agent_end", messages: [] });
			await flush();
			expect(controller.getReviewState().enabled).toBe(false);
			expect(controller.getReviewState().files).toEqual([]);
			expect(review.pending).toEqual([]);
			expect(existsSync(join(plain, "file.txt"))).toBe(true);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});
});
