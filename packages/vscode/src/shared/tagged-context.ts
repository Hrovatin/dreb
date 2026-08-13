/**
 * Pure helpers for editor-selection context tags (Phase 4).
 *
 * A "tagged context" is a snippet the user pulled from an editor selection into
 * the chat. This module builds the {@link TaggedContextDto}, formats the chip
 * label the composer shows, and folds attachments into the prompt text the host
 * sends to the agent.
 *
 * It is intentionally free of `vscode` AND of any `node:` builtins so the same
 * code can be bundled into the webview (for `taggedContextLabel`) and imported
 * by the host (for `buildTaggedContext` / `buildPromptWithContext`), and unit
 * tested in plain node — mirroring `shared/format.ts`.
 */

import type { TaggedContextDto } from "./protocol.js";

/** Inputs the host captures from the active editor to build a context tag. */
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

/** Last path segment of a slash/back-slash separated path. */
function basename(path: string): string {
	const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
	return parts.at(-1) ?? path;
}

/** `fsPath` relative to `cwd` with forward slashes; falls back to the basename
 * when the file is outside the workspace (so the chip still has a sane label). */
function toWorkspaceRelative(fsPath: string, cwd: string): string {
	const file = fsPath.replace(/\\/g, "/");
	const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	if (root.length > 0 && file === root) return basename(file);
	if (root.length > 0 && file.startsWith(`${root}/`)) return file.slice(root.length + 1);
	return basename(file);
}

/** Build the DTO carried across the host↔webview boundary and folded into the
 * prompt. The `path` is workspace-relative so the agent knows the source. */
export function buildTaggedContext(input: TaggedContextInput): TaggedContextDto {
	return {
		path: toWorkspaceRelative(input.fsPath, input.cwd),
		startLine: input.startLine,
		endLine: input.endLine,
		language: input.language,
		text: input.text,
	};
}

/** Short chip label shown in the composer: `basename:line` or
 * `basename:start-end` (Copilot-style). */
export function taggedContextLabel(context: TaggedContextDto): string {
	const name = basename(context.path);
	return context.endLine > context.startLine
		? `${name}:${context.startLine}-${context.endLine}`
		: `${name}:${context.startLine}`;
}

/** One attachment as a located, fenced code block for the prompt. */
export function formatTaggedContext(context: TaggedContextDto): string {
	const location =
		context.endLine > context.startLine
			? `lines ${context.startLine}-${context.endLine}`
			: `line ${context.startLine}`;
	const fence = context.language && context.language.length > 0 ? context.language : "";
	return `\`${context.path}\` (${location}):\n\`\`\`${fence}\n${context.text}\n\`\`\``;
}

/** Fold tagged attachments into the message sent to the agent: the located
 * code blocks first, then the user's text. Returns `text` unchanged when there
 * are no attachments; returns just the blocks when the text is empty. */
export function buildPromptWithContext(text: string, attachments?: readonly TaggedContextDto[]): string {
	if (!attachments || attachments.length === 0) return text;
	const blocks = attachments.map(formatTaggedContext).join("\n\n");
	const trimmed = text.trim();
	return trimmed.length > 0 ? `${blocks}\n\n${trimmed}` : blocks;
}
