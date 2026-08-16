/**
 * Pure, vscode-free helpers backing the inline `@`-mention workspace search.
 *
 * The `vscode.workspace.findFiles` / `executeWorkspaceSymbolProvider` calls live
 * in `vscode-host-ui.ts`; the derivation logic (which ancestor directories to
 * surface, which symbols to keep) lives here so it is unit-testable without the
 * VSCode module — the same split that `escapeGlob` uses.
 */

import type { WorkspaceSearchResult } from "./host-ui.js";

/** Strip a single trailing slash so root comparisons are consistent. */
function stripTrailingSlash(path: string): string {
	return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Whether `folderPath` is one of the workspace roots or a descendant of one.
 * Ancestors above every root (e.g. the user's home directory) are excluded so
 * the dropdown only ever offers folders inside the open project. */
function isWithinRoots(folderPath: string, roots: readonly string[]): boolean {
	return roots.some((root) => folderPath === root || folderPath.startsWith(`${root}/`));
}

/**
 * Derive the in-project folders whose name matches `query`, from the POSIX
 * `uri.path`s of the matching files. `findFiles` returns files only, so each
 * hit's ancestor directories are walked and the unique ones whose segment
 * matches the (case-insensitive) query are kept — but only those inside a
 * workspace root, so ancestors above the project (whose absolute path segments
 * can also match) are never surfaced. Returns POSIX folder paths, capped.
 */
export function deriveFolderPaths(
	filePaths: readonly string[],
	query: string,
	workspaceRoots: readonly string[],
	cap: number,
): string[] {
	const q = query.toLowerCase();
	const roots = workspaceRoots.map(stripTrailingSlash);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const filePath of filePaths) {
		const parts = filePath.split("/");
		// Skip the final segment (the file itself); test each ancestor directory.
		for (let i = 1; i < parts.length - 1; i++) {
			const seg = parts[i];
			if (!seg || !seg.toLowerCase().includes(q)) continue;
			const folderPath = parts.slice(0, i + 1).join("/");
			if (!isWithinRoots(folderPath, roots)) continue;
			if (seen.has(folderPath)) continue;
			seen.add(folderPath);
			out.push(folderPath);
			if (out.length >= cap) return out;
		}
	}
	return out;
}

/** A raw workspace-symbol hit, already flattened out of `vscode.SymbolInformation`
 * so this module stays vscode-free. `line0` is the provider's 0-based line. */
export interface RawSymbolHit {
	kind: number;
	name: string;
	fsPath: string;
	line0: number;
}

/**
 * Filter raw workspace symbols to the structural kinds present in `labels`
 * (classes/functions/…), mapping each to a `symbol` result with a 1-based line
 * and capping the list. Kinds absent from `labels` (variables, fields, …) are
 * dropped so the dropdown stays classes-and-functions.
 */
export function selectSymbols(
	symbols: readonly RawSymbolHit[],
	labels: ReadonlyMap<number, string>,
	cap: number,
): WorkspaceSearchResult[] {
	const out: WorkspaceSearchResult[] = [];
	for (const sym of symbols) {
		const label = labels.get(sym.kind);
		if (!label) continue;
		out.push({ kind: "symbol", name: sym.name, symbolKind: label, fsPath: sym.fsPath, line: sym.line0 + 1 });
		if (out.length >= cap) break;
	}
	return out;
}
