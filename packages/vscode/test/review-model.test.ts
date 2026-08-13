import { describe, expect, it } from "vitest";
import { type ChangedFile, ReviewModel } from "../src/host/review-model.js";

const changed = (path: string, status: ChangedFile["status"] = "modified", hunkCount = 1): ChangedFile => ({
	path,
	status,
	hunkCount,
});

describe("ReviewModel", () => {
	it("starts idle with no cycle", () => {
		const m = new ReviewModel();
		expect(m.hasCycle()).toBe(false);
		expect(m.baselineRef()).toBeUndefined();
		expect(m.pending([changed("a.ts")])).toEqual([]);
	});

	it("beginCycle records the baseline and is idempotent (changes compound)", () => {
		const m = new ReviewModel();
		m.beginCycle("tree1");
		expect(m.hasCycle()).toBe(true);
		expect(m.baselineRef()).toBe("tree1");
		// A second begin does not replace the baseline — later turns compound.
		m.beginCycle("tree2");
		expect(m.baselineRef()).toBe("tree1");
	});

	it("derives pending as changed-minus-accepted, sorted by path", () => {
		const m = new ReviewModel();
		m.beginCycle("t");
		const files = [changed("b.ts", "modified", 2), changed("a.ts", "added", 1)];
		expect(m.pending(files).map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
		expect(m.pending(files)[0]).toEqual({ path: "a.ts", status: "added", hunkCount: 1 });
	});

	it("accept hides a file from the pending list", () => {
		const m = new ReviewModel();
		m.beginCycle("t");
		m.accept("a.ts");
		const pending = m.pending([changed("a.ts"), changed("b.ts")]);
		expect(pending.map((f) => f.path)).toEqual(["b.ts"]);
	});

	it("unaccept re-shows a previously accepted file", () => {
		const m = new ReviewModel();
		m.beginCycle("t");
		m.accept("a.ts");
		m.unaccept("a.ts");
		expect(m.pending([changed("a.ts")]).map((f) => f.path)).toEqual(["a.ts"]);
	});

	it("reset ends the cycle and clears accept markers", () => {
		const m = new ReviewModel();
		m.beginCycle("t");
		m.accept("a.ts");
		m.reset();
		expect(m.hasCycle()).toBe(false);
		expect(m.baselineRef()).toBeUndefined();
		// After reset, a fresh cycle shows the file again (accept markers gone).
		m.beginCycle("t2");
		expect(m.pending([changed("a.ts")]).map((f) => f.path)).toEqual(["a.ts"]);
	});
});
