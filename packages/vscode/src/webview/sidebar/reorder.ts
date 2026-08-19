/**
 * Pure helper for the sidebar's drag-to-reorder: given a group's current row
 * order and a drag from one row onto another, produce the new top-to-bottom key
 * order. Kept `vscode`- and DOM-free so it is unit-testable in plain node.
 */

/**
 * Move `draggingKey` to sit immediately before (or after, when `placeAfter`) the
 * `targetKey` within `keys`, returning the new order. Returns the input order
 * unchanged when the drag is a no-op (same key, or either key missing).
 */
export function computeReorder(
	keys: readonly string[],
	draggingKey: string,
	targetKey: string,
	placeAfter: boolean,
): string[] {
	if (draggingKey === targetKey) return keys.slice();
	if (!keys.includes(draggingKey) || !keys.includes(targetKey)) return keys.slice();
	const without = keys.filter((k) => k !== draggingKey);
	const targetIndex = without.indexOf(targetKey);
	const insertAt = placeAfter ? targetIndex + 1 : targetIndex;
	without.splice(insertAt, 0, draggingKey);
	return without;
}
