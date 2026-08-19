/**
 * Pure helpers for pasting images into the composer.
 *
 * The DOM-facing part (reading a clipboard `Blob` to a data URL via `FileReader`)
 * lives in `app.tsx`; the parsing and item-detection logic here is DOM-free so it
 * can be unit-tested without jsdom — the same split used by `composer-resize.ts`.
 */

import type { ImageAttachmentDto } from "../shared/protocol.js";

/** Minimal shape of a `DataTransferItem` we care about — kept structural so
 * tests don't need real clipboard objects. */
export interface ClipboardItemLike {
	/** `"file"` for pasted binary blobs (images), `"string"` for text. */
	kind: string;
	/** MIME type, e.g. "image/png" or "text/plain". */
	type: string;
}

/** True when a clipboard item is a pasted image blob (a file item with an
 * `image/*` MIME type). Text items (`kind: "string"`) are never images, so a
 * normal text paste is left untouched. */
export function isImageClipboardItem(item: ClipboardItemLike): boolean {
	return item.kind === "file" && item.type.startsWith("image/");
}

/** Parse a `data:<mime>;base64,<data>` URL (as produced by
 * `FileReader.readAsDataURL`) into an {@link ImageAttachmentDto}. Returns `null`
 * for anything that isn't a base64 image data URL, or that carries no data, so a
 * malformed / empty read is dropped rather than sent as a broken attachment. */
export function parseImageDataUrl(dataUrl: string): ImageAttachmentDto | null {
	const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
	if (!match) return null;
	const mimeType = match[1];
	const data = match[2];
	if (data.length === 0) return null;
	return { data, mimeType };
}
