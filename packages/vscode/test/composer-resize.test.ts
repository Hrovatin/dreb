import { describe, expect, it } from "vitest";
import { clampComposerHeight } from "../src/webview/composer-resize.js";

/**
 * Pure geometry for the composer's top drag handle. The component wiring (real
 * pointer events on the rendered handle) is covered in `composer.test.tsx`; this
 * file pins the clamping math independent of any DOM/layout engine.
 */
describe("clampComposerHeight", () => {
	const bounds = { min: 44, max: 600 };

	it("grows the input when dragged up (positive delta)", () => {
		expect(clampComposerHeight({ startHeight: 100, deltaY: 120, ...bounds })).toBe(220);
	});

	it("shrinks the input when dragged down (negative delta)", () => {
		expect(clampComposerHeight({ startHeight: 300, deltaY: -120, ...bounds })).toBe(180);
	});

	it("clamps to the compact minimum when dragged far down", () => {
		expect(clampComposerHeight({ startHeight: 100, deltaY: -500, ...bounds })).toBe(44);
	});

	it("clamps to the maximum when dragged far up", () => {
		expect(clampComposerHeight({ startHeight: 500, deltaY: 500, ...bounds })).toBe(600);
	});

	it("respects a smaller panel-height ceiling", () => {
		expect(clampComposerHeight({ startHeight: 100, deltaY: 400, min: 44, max: 200 })).toBe(200);
	});

	it("never returns below min for a degenerate range (max < min)", () => {
		// A very short panel where the computed ceiling falls below the floor.
		expect(clampComposerHeight({ startHeight: 30, deltaY: 100, min: 44, max: 20 })).toBe(44);
	});
});
