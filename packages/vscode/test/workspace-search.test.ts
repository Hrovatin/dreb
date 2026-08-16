import { describe, expect, it } from "vitest";
import { deriveFolderPaths, type RawSymbolHit, selectSymbols } from "../src/host/workspace-search.js";

describe("deriveFolderPaths", () => {
	const ROOT = "/home/me/proj";

	it("surfaces an in-project ancestor folder whose segment matches the query", () => {
		const hits = ["/home/me/proj/src/app/utils.ts"];
		expect(deriveFolderPaths(hits, "app", [ROOT], 50)).toEqual(["/home/me/proj/src/app"]);
	});

	it("excludes ancestors ABOVE the workspace root even when their name matches", () => {
		// Project lives under ~/code; typing "code" must NOT surface /home/me/code
		// (the parent), only the in-project `codegen` folder.
		const root = "/home/me/code/proj";
		const hits = ["/home/me/code/proj/src/codegen/parser.ts"];
		expect(deriveFolderPaths(hits, "code", [root], 50)).toEqual(["/home/me/code/proj/src/codegen"]);
	});

	it("returns nothing when the only matches are outside the project", () => {
		const hits = ["/home/me/code/proj/src/app.ts"];
		// "me" matches the /home/me ancestor, which is above the root → dropped.
		expect(deriveFolderPaths(hits, "me", ["/home/me/code/proj"], 50)).toEqual([]);
	});

	it("matches case-insensitively on a substring of the segment", () => {
		const hits = ["/home/me/proj/src/MyApp/index.ts"];
		expect(deriveFolderPaths(hits, "myapp", [ROOT], 50)).toEqual(["/home/me/proj/src/MyApp"]);
	});

	it("skips the final (file) segment so a matching filename is not treated as a folder", () => {
		const hits = ["/home/me/proj/src/app.ts"];
		// "app" appears only in the file name; there is no matching directory.
		expect(deriveFolderPaths(hits, "app", [ROOT], 50)).toEqual([]);
	});

	it("surfaces every matching ancestor along one path (nested folders)", () => {
		const hits = ["/home/me/proj/app/appmodule/x.ts"];
		expect(deriveFolderPaths(hits, "app", [ROOT], 50)).toEqual(["/home/me/proj/app", "/home/me/proj/app/appmodule"]);
	});

	it("dedupes a folder reached via multiple file hits, preserving first-seen order", () => {
		const hits = ["/home/me/proj/src/app/a.ts", "/home/me/proj/src/app/b.ts", "/home/me/proj/lib/app/c.ts"];
		expect(deriveFolderPaths(hits, "app", [ROOT], 50)).toEqual(["/home/me/proj/src/app", "/home/me/proj/lib/app"]);
	});

	it("caps the number of derived folders", () => {
		const hits = Array.from({ length: 10 }, (_, i) => `/home/me/proj/app${i}/f.ts`);
		expect(deriveFolderPaths(hits, "app", [ROOT], 3)).toHaveLength(3);
	});

	it("includes the workspace root itself when its name matches", () => {
		const hits = ["/home/me/proj/src/x.ts"];
		expect(deriveFolderPaths(hits, "proj", [ROOT], 50)).toEqual(["/home/me/proj"]);
	});

	it("tolerates a trailing slash on the workspace root", () => {
		const hits = ["/home/me/proj/src/app/utils.ts"];
		expect(deriveFolderPaths(hits, "app", ["/home/me/proj/"], 50)).toEqual(["/home/me/proj/src/app"]);
	});

	it("honors multiple workspace roots (multi-root workspace)", () => {
		const roots = ["/home/me/api", "/home/me/web"];
		const hits = ["/home/me/api/app/x.ts", "/home/me/web/app/y.ts", "/home/me/other/app/z.ts"];
		// The /home/me/other hit is outside every root → excluded.
		expect(deriveFolderPaths(hits, "app", roots, 50)).toEqual(["/home/me/api/app", "/home/me/web/app"]);
	});

	it("returns nothing when there are no workspace roots", () => {
		const hits = ["/home/me/proj/src/app/x.ts"];
		expect(deriveFolderPaths(hits, "app", [], 50)).toEqual([]);
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
