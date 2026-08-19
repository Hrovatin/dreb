/**
 * Pure image-paste helpers (`isImageClipboardItem`, `parseImageDataUrl`).
 *
 * The DOM glue that reads a clipboard blob to a data URL lives in the composer
 * (`app.tsx`) and is exercised in `composer.test.tsx`; the detection + parsing
 * logic here is DOM-free, so it's unit-tested in isolation.
 */

import { describe, expect, it } from "vitest";
import { isImageClipboardItem, parseImageDataUrl } from "../src/webview/image-paste.js";

describe("isImageClipboardItem", () => {
	it("accepts a file item with an image MIME type", () => {
		expect(isImageClipboardItem({ kind: "file", type: "image/png" })).toBe(true);
		expect(isImageClipboardItem({ kind: "file", type: "image/jpeg" })).toBe(true);
		expect(isImageClipboardItem({ kind: "file", type: "image/gif" })).toBe(true);
	});

	it("rejects text items and non-image files (so a normal paste is untouched)", () => {
		expect(isImageClipboardItem({ kind: "string", type: "text/plain" })).toBe(false);
		expect(isImageClipboardItem({ kind: "string", type: "image/png" })).toBe(false);
		expect(isImageClipboardItem({ kind: "file", type: "application/pdf" })).toBe(false);
		expect(isImageClipboardItem({ kind: "file", type: "" })).toBe(false);
	});
});

describe("parseImageDataUrl", () => {
	it("parses a base64 image data URL into data + mimeType", () => {
		expect(parseImageDataUrl("data:image/png;base64,iVBORw0KGgo=")).toEqual({
			data: "iVBORw0KGgo=",
			mimeType: "image/png",
		});
		expect(parseImageDataUrl("data:image/jpeg;base64,/9j/4AAQSkZJRg==")).toEqual({
			data: "/9j/4AAQSkZJRg==",
			mimeType: "image/jpeg",
		});
	});

	it("tolerates surrounding whitespace", () => {
		expect(parseImageDataUrl("  data:image/webp;base64,UklGRg==  ")).toEqual({
			data: "UklGRg==",
			mimeType: "image/webp",
		});
	});

	it("returns null for non-image, non-base64, or empty-data URLs", () => {
		expect(parseImageDataUrl("data:text/plain;base64,aGVsbG8=")).toBeNull();
		expect(parseImageDataUrl("data:image/png,notbase64")).toBeNull();
		expect(parseImageDataUrl("data:image/png;base64,")).toBeNull();
		expect(parseImageDataUrl("https://example.com/a.png")).toBeNull();
		expect(parseImageDataUrl("")).toBeNull();
	});
});
