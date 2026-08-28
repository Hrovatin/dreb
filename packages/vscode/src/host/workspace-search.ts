/**
 * Pure, vscode-free helpers backing the inline `@`-mention workspace search.
 *
 * The `vscode.workspace.fs.readDirectory` / `findFiles` /
 * `executeWorkspaceSymbolProvider` calls live in `vscode-host-ui.ts`; the
 * derivation logic (which discovered directories to surface, which symbols to
 * keep) lives here so it is unit-testable without the VSCode module — the same
 * split that `escapeGlob` uses. Folders are discovered by directory listing (not
 * derived from file hits) so **empty** subfolders surface too.
 */

import type { WorkspaceSearchResult } from "./host-ui.js";

/** Last path segment of a `/`- or `\`-separated path (no `node:path`, so this
 * stays vscode/node-free and runs in the webview bundle + plain-node tests). */
function basename(path: string): string {
	const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
	return parts.at(-1) ?? path;
}

/**
 * Directory names skipped while walking the workspace for the `@`-mention folder
 * source. These are heavy or noise directories whose contents should never
 * appear in the picker (and would otherwise dominate the traversal budget). The
 * host walk consults this set; kept here so it is part of the unit-tested,
 * vscode-free surface.
 */
export const DEFAULT_FOLDER_WALK_IGNORES: ReadonlySet<string> = new Set([
	"node_modules",
	".git",
	".hg",
	".svn",
	"dist",
	"out",
	"build",
	".next",
	".cache",
	".turbo",
	".venv",
	"venv",
	"__pycache__",
	".idea",
	".vscode-test",
	"coverage",
]);

/**
 * Whether a directory's `name` matches the (case-insensitive) `query`. An empty
 * query never matches, so the folder source stays query-gated (an empty `@`
 * lists files only). Pure predicate shared by the host walk and its tests.
 */
export function folderNameMatches(name: string, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (q.length === 0) return false;
	return name.toLowerCase().includes(q);
}

/**
 * From directory paths discovered by walking the workspace (via
 * `vscode.workspace.fs.readDirectory` — which lists **all** subdirectories,
 * including empty ones the old file-ancestor derivation missed), keep those
 * whose basename matches `query`, deduped in first-seen order and capped. The
 * host only descends inside workspace roots, so every input path is already
 * in-project; this function just applies the query/dedupe/cap. Pure (no
 * `vscode`) so the "which folders surface" logic is unit-testable.
 */
export function selectMatchingFolders(dirPaths: readonly string[], query: string, cap: number): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const dirPath of dirPaths) {
		if (seen.has(dirPath)) continue;
		if (!folderNameMatches(basename(dirPath), query)) continue;
		seen.add(dirPath);
		out.push(dirPath);
		if (out.length >= cap) break;
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
