/**
 * Geometry for the composer's drag-to-resize handle, extracted as a pure
 * function so it can be unit-tested without a DOM/layout engine.
 *
 * The composer is docked at the bottom of the chat panel and the handle sits on
 * its *top* edge, so dragging the pointer up should make the input taller and
 * dragging down should shrink it. Callers pass `deltaY = startPointerY -
 * currentPointerY` (positive when the pointer moved up); the resulting height is
 * clamped to `[min, max]`.
 */
export interface ComposerHeightInput {
	/** Input height in px captured at pointer-down. */
	startHeight: number;
	/** Upward drag distance in px (`startPointerY - currentPointerY`). */
	deltaY: number;
	/** Smallest allowed height in px (the compact default). */
	min: number;
	/** Largest allowed height in px (roughly the panel-height budget). */
	max: number;
}

/**
 * Compute the clamped composer height for a drag gesture.
 *
 * Guarantees a sane result even for a degenerate range: when the panel is so
 * short that `max` falls below `min`, the effective ceiling is raised to `min`
 * so the return value is always within `[min, max']` and never `min > max`.
 */
export function clampComposerHeight({ startHeight, deltaY, min, max }: ComposerHeightInput): number {
	const ceiling = Math.max(min, max);
	const desired = startHeight + deltaY;
	return Math.min(ceiling, Math.max(min, desired));
}
