/// <reference types="vscode" />

/**
 * vscode-backed SourceLinkUi — opens a clicked code reference (Phase 5b).
 *
 * Resolution order, best-effort and non-throwing:
 *  1. If a `symbol` is present, prefer its real *definition* via the workspace
 *     symbol provider (language-server accurate). Multiple candidates surface a
 *     quick pick; an exact-name match is preferred over fuzzy hits.
 *  2. Otherwise (or if the provider found nothing) fall back to the concrete
 *     `path`/`line` — for a symbol link that path/line is the grounded *usage*
 *     location captured from the tool hit that produced the link.
 *  3. If nothing resolves, show an unobtrusive notice (never a broken jump).
 *
 * Line/column from the webview are 1-based (tool-output convention); vscode
 * `Position` is 0-based, converted here.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import * as vscode from "vscode";
import type { OpenSourceRef } from "../shared/protocol.js";
import type { SourceLinkUi } from "./source-link-ui.js";

export function createVscodeSourceLinkUi(cwd: string): SourceLinkUi {
	return {
		async openSource(ref: OpenSourceRef): Promise<void> {
			if (ref.symbol) {
				const loc = await resolveSymbol(ref.symbol);
				if (loc) {
					await reveal(loc.uri, loc.range.start.line + 1, loc.range.start.character + 1);
					return;
				}
			}
			if (ref.path) {
				await openPath(cwd, ref.path, ref.line, ref.column);
				return;
			}
			if (ref.symbol) {
				void vscode.window.showInformationMessage(`dreb: couldn't locate “${ref.symbol}”.`);
			}
		},
	};
}

/** Resolve a symbol to a definition location via the workspace symbol provider,
 * disambiguating multiple candidates with a quick pick. Best-effort: a symbol
 * provider that throws degrades to `undefined` (caller falls back to the path). */
async function resolveSymbol(symbol: string): Promise<vscode.Location | undefined> {
	let hits: vscode.SymbolInformation[];
	try {
		hits =
			(await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
				"vscode.executeWorkspaceSymbolProvider",
				symbol,
			)) ?? [];
	} catch {
		return undefined;
	}
	if (hits.length === 0) return undefined;
	const exact = hits.filter((h) => h.name === symbol);
	const pool = exact.length > 0 ? exact : hits;
	if (pool.length === 1) return pool[0].location;

	const pick = await vscode.window.showQuickPick(
		pool.map((h) => ({
			label: h.name,
			description: `${vscode.SymbolKind[h.kind]} · ${vscode.workspace.asRelativePath(h.location.uri)}`,
			location: h.location,
		})),
		{ title: `Go to ${symbol}`, matchOnDescription: true },
	);
	return pick?.location;
}

/** Open a concrete file path (relative to the session cwd) at an optional
 * 1-based line/column. Missing files degrade to a notice. */
async function openPath(cwd: string, path: string, line?: number, column?: number): Promise<void> {
	const abs = isAbsolute(path) ? path : resolve(cwd, path);
	if (!existsSync(abs)) {
		void vscode.window.showInformationMessage(`dreb: ${path} not found in the workspace.`);
		return;
	}
	await reveal(vscode.Uri.file(abs), line, column);
}

/** Open the document and, when a 1-based line is given, select+reveal it. An
 * open failure (file deleted after the existsSync check, a binary/undecodable
 * file, permission error) degrades to an unobtrusive notice rather than a silent
 * no-op — honoring the "never a broken jump" contract. */
async function reveal(uri: vscode.Uri, line?: number, column?: number): Promise<void> {
	try {
		const doc = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(doc, { preview: true });
		if (line && line > 0) {
			const pos = new vscode.Position(line - 1, Math.max(0, (column ?? 1) - 1));
			editor.selection = new vscode.Selection(pos, pos);
			editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
		}
	} catch (err) {
		const detail = err instanceof Error ? `: ${err.message}` : "";
		void vscode.window.showInformationMessage(`dreb: couldn't open ${uri.fsPath}${detail}.`);
	}
}
