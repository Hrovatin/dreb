import { describe, expect, it } from "vitest";
import {
	folderNameMatches,
	type RawSymbolHit,
	selectMatchingFolders,
	selectSymbols,
} from "../src/host/workspace-search.js";

describe("folderNameMatches", () => {
	it("matches a case-insensitive substring of the directory name", () => {
		expect(folderNameMatches("MyApp", "app")).toBe(true);
		expect(folderNameMatches("components", "compo")).toBe(true);
	});

	it("does not match when the query is absent from the name", () => {
		expect(folderNameMatches("src", "app")).toBe(false);
	});

	it("never matches an empty (or whitespace-only) query, keeping the folder source query-gated", () => {
		expect(folderNameMatches("anything", "")).toBe(false);
		expect(folderNameMatches("anything", "   ")).toBe(false);
	});
});

describe("selectMatchingFolders", () => {
	it("keeps folders whose basename matches, regardless of whether they contain files", () => {
		// An empty folder is just a discovered directory path with no file
		// children — the walk lists it via readDirectory, and it surfaces here.
		const dirs = ["/home/me/proj/src/empty-widgets", "/home/me/proj/src/utils"];
		expect(selectMatchingFolders(dirs, "widget", 50)).toEqual(["/home/me/proj/src/empty-widgets"]);
	});

	it("matches on the basename only, not an ancestor segment", () => {
		const dirs = ["/home/me/app/src/models"];
		// "app" appears only in an ancestor, not the leaf → not a folder match.
		expect(selectMatchingFolders(dirs, "app", 50)).toEqual([]);
	});

	it("matches case-insensitively", () => {
		expect(selectMatchingFolders(["/home/me/proj/src/MyApp"], "myapp", 50)).toEqual(["/home/me/proj/src/MyApp"]);
	});

	it("dedupes repeated paths, preserving first-seen order", () => {
		const dirs = ["/p/app", "/p/lib/app", "/p/app"];
		expect(selectMatchingFolders(dirs, "app", 50)).toEqual(["/p/app", "/p/lib/app"]);
	});

	it("caps the number of results", () => {
		const dirs = Array.from({ length: 10 }, (_, i) => `/p/app${i}`);
		expect(selectMatchingFolders(dirs, "app", 3)).toHaveLength(3);
	});

	it("returns nothing for an empty query", () => {
		expect(selectMatchingFolders(["/p/app"], "", 50)).toEqual([]);
	});

	it("tolerates back-slashed (Windows) paths when taking the basename", () => {
		expect(selectMatchingFolders(["C:\\proj\\src\\widgets"], "widget", 50)).toEqual(["C:\\proj\\src\\widgets"]);
	});
});

describe("selectSymbols", () => {
	// A representative structural-kind map (numeric keys mirror vscode.SymbolKind).
	const LABELS = new Map<number, string>([
		[4, "class"],
		[11, "function"],
		[5, "method"],
	]);

	const hit = (kind: number, name: string, line0 = 0, fsPath = "/proj/src/app.ts"): RawSymbolHit => ({
		kind,
		name,
		fsPath,
		line0,
	});

	it("keeps structural kinds and maps them to 1-based symbol results", () => {
		const results = selectSymbols([hit(4, "AppRunner", 3)], LABELS, 50);
		expect(results).toEqual([
			{ kind: "symbol", name: "AppRunner", symbolKind: "class", fsPath: "/proj/src/app.ts", line: 4 },
		]);
	});

	it("drops kinds absent from the label map (variables, fields, …)", () => {
		// 12 = SymbolKind.Variable, not in LABELS.
		const results = selectSymbols([hit(12, "counter"), hit(11, "run")], LABELS, 50);
		expect(results.map((r) => r.kind === "symbol" && r.name)).toEqual(["run"]);
	});

	it("converts a 0-based provider line to a 1-based line", () => {
		const [result] = selectSymbols([hit(5, "handle", 0)], LABELS, 50);
		expect(result).toMatchObject({ kind: "symbol", line: 1 });
	});

	it("caps the number of symbols after filtering", () => {
		const hits = Array.from({ length: 10 }, (_, i) => hit(11, `fn${i}`));
		expect(selectSymbols(hits, LABELS, 3)).toHaveLength(3);
	});

	it("returns an empty list when nothing matches a structural kind", () => {
		expect(selectSymbols([hit(12, "a"), hit(13, "b")], LABELS, 50)).toEqual([]);
	});

	it("returns an empty list for no symbols", () => {
		expect(selectSymbols([], LABELS, 50)).toEqual([]);
	});
});
