/**
 * Pure helpers for chat context tags.
 *
 * A "tagged context" is something the user pulled into the chat as context:
 * either an editor **selection** (Phase 4) or a **file/folder** reference
 * (Phase 4b, via the `@` picker). This module builds the {@link TaggedContextDto}
 * variants, formats the chip label/title the composer shows, and folds
 * attachments into the prompt text the host sends to the agent.
 *
 * Selections are inlined as a located fenced code block when small, but degrade
 * to a path + line-span reference once they exceed {@link MAX_INLINE_SELECTION_LINES}
 * or {@link MAX_INLINE_SELECTION_CHARS} (keeping the prompt short). File/folder
 * tags are **always** a path reference only — never the contents.
 *
 * It is intentionally free of `vscode` AND of any `node:` builtins so the same
 * code can be bundled into the webview (for the chip label/title) and imported
 * by the host (for the builders / `buildPromptWithContext`), and unit tested in
 * plain node — mirroring `shared/format.ts`.
 */

import type { FileContextDto, SelectionContextDto, TaggedContextDto } from "./protocol.js";

/** A selection larger than this many lines folds as a reference, not a block. */
export const MAX_INLINE_SELECTION_LINES = 40;
/** A selection larger than this many characters folds as a reference (a safety
 * cap so a few very long lines can't blow up the prompt under the line limit). */
export const MAX_INLINE_SELECTION_CHARS = 2000;

/** Inputs the host captures from the active editor to build a selection tag. */
export interface TaggedContextInput {
	/** Absolute filesystem path of the selection's document. */
	fsPath: string;
	/** The session's working directory, used to relativize `fsPath`. */
	cwd: string;
	/** 1-based inclusive start line of the selection. */
	startLine: number;
	/** 1-based inclusive end line of the selection. */
	endLine: number;
	/** The document's language id (e.g. "typescript"), for the fenced block. */
	language: string;
	/** The selected text. */
	text: string;
}

/** Inputs the host captures from the `@` picker to build a file/folder tag. */
export interface FileContextInput {
	/** Absolute filesystem path of the picked file or folder. */
	fsPath: string;
	/** The session's working directory, used to relativize `fsPath`. */
	cwd: string;
	/** True when the picked path is a directory. */
	isDirectory?: boolean;
}

/** Last path segment of a slash/back-slash separated path. */
function basename(path: string): string {
	const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
	return parts.at(-1) ?? path;
}

/** `fsPath` relative to `cwd` with forward slashes; falls back to the basename
 * when the file is outside the workspace (so the chip still has a sane label). */
function toWorkspaceRelative(fsPath: string, cwd: string): string {
	const file = fsPath.replace(/\\/g, "/").replace(/\/+$/, "");
	const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	if (root.length > 0 && file === root) return basename(file);
	if (root.length > 0 && file.startsWith(`${root}/`)) return file.slice(root.length + 1);
	return basename(file);
}

/** Build a selection context DTO carried across the host↔webview boundary and
 * folded into the prompt. The `path` is workspace-relative so the agent knows
 * the source. */
export function buildTaggedContext(input: TaggedContextInput): SelectionContextDto {
	return {
		kind: "selection",
		path: toWorkspaceRelative(input.fsPath, input.cwd),
		startLine: input.startLine,
		endLine: input.endLine,
		language: input.language,
		text: input.text,
	};
}

/** Build a file/folder context DTO. Folded into the prompt as a path reference
 * only (never the contents). */
export function buildFileContext(input: FileContextInput): FileContextDto {
	const dto: FileContextDto = {
		kind: "file",
		path: toWorkspaceRelative(input.fsPath, input.cwd),
	};
	if (input.isDirectory) dto.isDirectory = true;
	return dto;
}

/** 1-based inclusive line span of a selection (`line N` or `lines A-B`). */
function selectionSpan(context: SelectionContextDto): string {
	return context.endLine > context.startLine
		? `lines ${context.startLine}-${context.endLine}`
		: `line ${context.startLine}`;
}

/** Whether a selection is small enough to inline as a fenced code block. */
function fitsInline(context: SelectionContextDto): boolean {
	const lineCount = context.endLine - context.startLine + 1;
	return lineCount <= MAX_INLINE_SELECTION_LINES && context.text.length <= MAX_INLINE_SELECTION_CHARS;
}

/** Short chip label shown in the composer. Selection: `basename:line` or
 * `basename:start-end` (Copilot-style). File: `basename`. Folder: `basename/`. */
export function taggedContextLabel(context: TaggedContextDto): string {
	const name = basename(context.path);
	if (context.kind === "file") return context.isDirectory ? `${name}/` : name;
	return context.endLine > context.startLine
		? `${name}:${context.startLine}-${context.endLine}`
		: `${name}:${context.startLine}`;
}

/** Hover title for the composer chip: the full path + a kind-specific note. */
export function taggedContextTitle(context: TaggedContextDto): string {
	if (context.kind === "file") return context.isDirectory ? `${context.path}/ (directory)` : context.path;
	return `${context.path} (${selectionSpan(context)})`;
}

/** One attachment folded into the prompt. Small selections inline a located
 * fenced code block; large selections and all file/folder tags fold to a path
 * reference only. */
export function formatTaggedContext(context: TaggedContextDto): string {
	if (context.kind === "file") {
		return context.isDirectory ? `\`${context.path}/\` (directory)` : `\`${context.path}\``;
	}
	const span = selectionSpan(context);
	if (!fitsInline(context)) return `\`${context.path}\` (${span})`;
	const fence = context.language && context.language.length > 0 ? context.language : "";
	return `\`${context.path}\` (${span}):\n\`\`\`${fence}\n${context.text}\n\`\`\``;
}

/** Fold tagged attachments into the message sent to the agent: the located
 * blocks/references first, then the user's text. Returns `text` unchanged when
 * there are no attachments; returns just the blocks when the text is empty. */
export function buildPromptWithContext(text: string, attachments?: readonly TaggedContextDto[]): string {
	if (!attachments || attachments.length === 0) return text;
	const blocks = attachments.map(formatTaggedContext).join("\n\n");
	const trimmed = text.trim();
	return trimmed.length > 0 ? `${blocks}\n\n${trimmed}` : blocks;
}
