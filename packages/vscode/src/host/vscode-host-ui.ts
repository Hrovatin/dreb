/// <reference types="vscode" />

/**
 * vscode-backed HostUi — wraps `vscode.window.*` prompts behind the `HostUi`
 * port so the SessionController stays vscode-free and unit-testable. Only the
 * extension host constructs this (via `extension.ts`).
 */

import * as vscode from "vscode";
import { escapeGlob } from "../shared/mention.js";
import type { HostUi, HostUiPickItem, PickedFile, WorkspaceSearchResult } from "./host-ui.js";

/** A quick-pick item carrying our opaque `value` alongside vscode's fields. */
interface ValuedQuickPickItem extends vscode.QuickPickItem {
	value: string;
}

export function createVscodeHostUi(): HostUi {
	return {
		async quickPick(items: HostUiPickItem[], options): Promise<string | undefined> {
			const picks: ValuedQuickPickItem[] = items.map((item) => ({
				label: item.label,
				description: item.description,
				detail: item.detail,
				value: item.value,
			}));
			const chosen = await vscode.window.showQuickPick(picks, {
				placeHolder: options?.placeholder,
				matchOnDescription: true,
				matchOnDetail: true,
			});
			return chosen?.value;
		},
		async inputBox(options): Promise<string | undefined> {
			return vscode.window.showInputBox({
				prompt: options?.prompt,
				value: options?.value,
				placeHolder: options?.placeholder,
			});
		},
		async saveDialog(options): Promise<string | undefined> {
			const uri = await vscode.window.showSaveDialog({
				defaultUri: options?.defaultName ? vscode.Uri.file(options.defaultName) : undefined,
				filters: options?.filters,
			});
			return uri?.fsPath;
		},
		async openDialog(options): Promise<string | undefined> {
			const uris = await vscode.window.showOpenDialog({
				canSelectMany: false,
				openLabel: "Select",
				filters: options?.filters,
			});
			return uris?.[0]?.fsPath;
		},
		async pickWorkspaceFiles(): Promise<PickedFile[] | undefined> {
			const uris = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: true,
				canSelectMany: true,
				openLabel: "Add to chat",
				defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
			});
			if (!uris || uris.length === 0) return undefined;
			return Promise.all(
				uris.map(async (uri) => ({
					fsPath: uri.fsPath,
					isDirectory: await isDirectory(uri),
				})),
			);
		},
		async searchWorkspace(query: string): Promise<WorkspaceSearchResult[]> {
			const q = query.trim();
			// Run the three sources concurrently; the webview ranks + trims. Folders
			// and symbols need a query (an empty `@` lists a bounded file set only).
			const [folders, files, symbols] = await Promise.all([
				q.length > 0 ? searchFolders(q) : Promise.resolve<WorkspaceSearchResult[]>([]),
				searchFiles(q),
				q.length > 0 ? searchSymbols(q) : Promise.resolve<WorkspaceSearchResult[]>([]),
			]);
			return [...folders, ...files, ...symbols];
		},
	};
}

/** Upper bound on files fetched per inline search before webview-side ranking. */
const SEARCH_FETCH_CAP = 200;
/** Upper bound on unique folders derived per inline search. */
const FOLDER_RESULT_CAP = 50;
/** Upper bound on workspace symbols fetched per inline search. */
const SYMBOL_RESULT_CAP = 50;

/** Files whose name matches the query, respecting the workspace's
 * `files.exclude`/`search.exclude`. An empty query lists a bounded workspace
 * set. Uses a recursive `**` + `*query*` filename include. */
async function searchFiles(query: string): Promise<WorkspaceSearchResult[]> {
	const include = query.length > 0 ? `**/*${escapeGlob(query)}*` : "**/*";
	const uris = await vscode.workspace.findFiles(include, undefined, SEARCH_FETCH_CAP);
	return uris.map((uri) => ({ kind: "file", fsPath: uri.fsPath }));
}

/** Folders whose name matches the query, derived from the files nested under a
 * matching directory segment (a recursive `**` + `*query*` directory + `**`
 * include). `findFiles` returns files only, so we walk each hit's ancestors and
 * keep the unique directories whose basename matches the query. */
async function searchFolders(query: string): Promise<WorkspaceSearchResult[]> {
	const uris = await vscode.workspace.findFiles(`**/*${escapeGlob(query)}*/**`, undefined, SEARCH_FETCH_CAP);
	const q = query.toLowerCase();
	const folders = new Map<string, WorkspaceSearchResult>();
	for (const uri of uris) {
		const parts = uri.path.split("/");
		// Skip the final segment (the file itself); test each ancestor directory.
		for (let i = 1; i < parts.length - 1; i++) {
			const seg = parts[i];
			if (!seg || !seg.toLowerCase().includes(q)) continue;
			const folderUri = uri.with({ path: parts.slice(0, i + 1).join("/") });
			if (!folders.has(folderUri.fsPath))
				folders.set(folderUri.fsPath, { kind: "folder", fsPath: folderUri.fsPath });
			if (folders.size >= FOLDER_RESULT_CAP) return [...folders.values()];
		}
	}
	return [...folders.values()];
}

/** Code symbols (classes/functions/methods/…) matching the query, via the
 * workspace symbol provider. Filtered to structural kinds so the dropdown stays
 * classes-and-functions, not every variable. */
async function searchSymbols(query: string): Promise<WorkspaceSearchResult[]> {
	const symbols =
		(await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
			"vscode.executeWorkspaceSymbolProvider",
			query,
		)) ?? [];
	const results: WorkspaceSearchResult[] = [];
	for (const sym of symbols) {
		const label = SYMBOL_KIND_LABELS.get(sym.kind);
		if (!label) continue;
		results.push({
			kind: "symbol",
			name: sym.name,
			symbolKind: label,
			fsPath: sym.location.uri.fsPath,
			line: sym.location.range.start.line + 1,
		});
		if (results.length >= SYMBOL_RESULT_CAP) break;
	}
	return results;
}

/** Structural symbol kinds surfaced in the inline dropdown, mapped to a
 * human-readable label. Non-structural kinds (variables, fields, constants, …)
 * are intentionally omitted so the list stays classes/functions-focused. */
const SYMBOL_KIND_LABELS = new Map<vscode.SymbolKind, string>([
	[vscode.SymbolKind.Class, "class"],
	[vscode.SymbolKind.Interface, "interface"],
	[vscode.SymbolKind.Enum, "enum"],
	[vscode.SymbolKind.Struct, "struct"],
	[vscode.SymbolKind.Function, "function"],
	[vscode.SymbolKind.Method, "method"],
	[vscode.SymbolKind.Constructor, "constructor"],
	[vscode.SymbolKind.Namespace, "namespace"],
	[vscode.SymbolKind.Module, "module"],
]);

/** Whether `uri` points at a directory (defaults to false when it can't be
 * stat'd, so the tag still folds as a plain file reference). */
async function isDirectory(uri: vscode.Uri): Promise<boolean> {
	try {
		const stat = await vscode.workspace.fs.stat(uri);
		return (stat.type & vscode.FileType.Directory) !== 0;
	} catch {
		return false;
	}
}
