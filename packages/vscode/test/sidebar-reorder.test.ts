import { describe, expect, it } from "vitest";
import { computeReorder } from "../src/webview/sidebar/reorder.js";

describe("computeReorder", () => {
	const keys = ["a", "b", "c", "d"];

	it("moves a row before the target", () => {
		expect(computeReorder(keys, "d", "b", false)).toEqual(["a", "d", "b", "c"]);
	});

	it("moves a row after the target", () => {
		expect(computeReorder(keys, "d", "b", true)).toEqual(["a", "b", "d", "c"]);
	});

	it("moves an earlier row later", () => {
		expect(computeReorder(keys, "a", "c", true)).toEqual(["b", "c", "a", "d"]);
	});

	it("moving before the first row puts it at the top", () => {
		expect(computeReorder(keys, "c", "a", false)).toEqual(["c", "a", "b", "d"]);
	});

	it("is a no-op when dragging onto itself", () => {
		expect(computeReorder(keys, "b", "b", false)).toEqual(keys);
	});

	it("is a no-op when either key is missing", () => {
		expect(computeReorder(keys, "z", "b", false)).toEqual(keys);
		expect(computeReorder(keys, "b", "z", true)).toEqual(keys);
	});
});
