import { describe, expect, it, vi } from "vitest";
import { type SelectionSnapshot, type TagTarget, tagSelectionToChat } from "../src/host/tag-selection.js";
import type { TaggedContextDto } from "../src/shared/protocol.js";

/** A recording TagTarget with the fields the orchestrator threads through. */
function makeTarget(cwd: string) {
	const tagged: TaggedContextDto[] = [];
	let revealed = 0;
	const target: TagTarget = {
		cwd,
		tagContext: (ctx) => tagged.push(ctx),
		reveal: () => {
			revealed += 1;
		},
	};
	return { target, tagged, revealed: () => revealed };
}

const snapshot: SelectionSnapshot = {
	fsPath: "/home/me/proj/src/app.ts",
	startLine: 10,
	endLine: 12,
	language: "typescript",
	text: "const x = 1;",
};

describe("tagSelectionToChat", () => {
	it("notifies and does nothing when there is no selection", async () => {
		const onNoSelection = vi.fn();
		const openTarget = vi.fn(async () => undefined);

		await tagSelectionToChat({
			captureSelection: () => undefined,
			openTarget,
			onNoSelection,
		});

		expect(onNoSelection).toHaveBeenCalledTimes(1);
		expect(openTarget).not.toHaveBeenCalled();
	});

	it("tags the selection into the target and reveals it, relativizing the path", async () => {
		const { target, tagged, revealed } = makeTarget("/home/me/proj");

		await tagSelectionToChat({
			captureSelection: () => snapshot,
			openTarget: async () => target,
			onNoSelection: vi.fn(),
		});

		expect(tagged).toEqual([
			{ path: "src/app.ts", startLine: 10, endLine: 12, language: "typescript", text: "const x = 1;" },
		]);
		expect(revealed()).toBe(1);
	});

	it("aborts quietly (no tag, no reveal) when the chat could not be opened", async () => {
		const { target, tagged, revealed } = makeTarget("/home/me/proj");
		const spy = vi.spyOn(target, "tagContext");

		await tagSelectionToChat({
			captureSelection: () => snapshot,
			openTarget: async () => undefined,
			onNoSelection: vi.fn(),
		});

		expect(spy).not.toHaveBeenCalled();
		expect(tagged).toHaveLength(0);
		expect(revealed()).toBe(0);
	});

	it("captures the selection BEFORE awaiting openTarget (focus-shift guard)", async () => {
		const order: string[] = [];
		const { target } = makeTarget("/home/me/proj");

		await tagSelectionToChat({
			captureSelection: () => {
				order.push("capture");
				return snapshot;
			},
			openTarget: async () => {
				order.push("open");
				return target;
			},
			onNoSelection: vi.fn(),
		});

		expect(order).toEqual(["capture", "open"]);
	});
});
