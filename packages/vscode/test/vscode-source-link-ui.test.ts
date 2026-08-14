/**
 * vscode-backed SourceLinkUi (Phase 5b) — open/resolve behavior.
 *
 * `vscode` and `node:fs` are mocked so the resolution logic (path reveal, symbol
 * → definition via the workspace symbol provider, grounded fallback, and the
 * not-found notice) is exercised without a real editor or filesystem.
 */

import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
	exists: new Set<string>(),
	symbolHits: [] as any[],
	pickResult: undefined as any,
	shown: [] as { uri: any; selection?: any; revealed: boolean }[],
	info: [] as string[],
}));

vi.mock("node:fs", () => ({
	existsSync: (p: string) => hoisted.exists.has(p),
}));

vi.mock("vscode", () => {
	class Position {
		constructor(
			public line: number,
			public character: number,
		) {}
	}
	class Selection {
		constructor(
			public anchor: Position,
			public active: Position,
		) {}
	}
	class Range {
		constructor(
			public start: Position,
			public end: Position,
		) {}
	}
	return {
		Position,
		Selection,
		Range,
		TextEditorRevealType: { InCenter: 2 },
		SymbolKind: { Class: 4, Function: 11 },
		Uri: { file: (p: string) => ({ scheme: "file", fsPath: p, path: p }) },
		commands: {
			executeCommand: vi.fn(async () => hoisted.symbolHits),
		},
		window: {
			showQuickPick: vi.fn(async () => hoisted.pickResult),
			showInformationMessage: vi.fn(async (m: string) => {
				hoisted.info.push(m);
			}),
			showTextDocument: vi.fn(async (doc: any) => {
				const record = { uri: doc.uri, selection: undefined as any, revealed: false };
				const editor = {
					get selection() {
						return record.selection;
					},
					set selection(v: any) {
						record.selection = v;
					},
					revealRange: () => {
						record.revealed = true;
					},
				};
				hoisted.shown.push(record);
				return editor;
			}),
		},
		workspace: {
			openTextDocument: vi.fn(async (uri: any) => ({ uri })),
			asRelativePath: (uri: any) => uri.fsPath,
		},
	};
});

import { createVscodeSourceLinkUi } from "../src/host/vscode-source-link-ui.js";

function reset() {
	hoisted.exists = new Set();
	hoisted.symbolHits = [];
	hoisted.pickResult = undefined;
	hoisted.shown = [];
	hoisted.info = [];
}

describe("createVscodeSourceLinkUi", () => {
	it("opens a concrete path at a 0-based converted line/column", async () => {
		reset();
		hoisted.exists.add("/proj/src/a.ts");
		const ui = createVscodeSourceLinkUi("/proj");

		await ui.openSource({ path: "src/a.ts", line: 42, column: 3 });

		expect(hoisted.shown).toHaveLength(1);
		expect(hoisted.shown[0].uri.fsPath).toBe("/proj/src/a.ts");
		expect(hoisted.shown[0].selection.active.line).toBe(41);
		expect(hoisted.shown[0].selection.active.character).toBe(2);
		expect(hoisted.shown[0].revealed).toBe(true);
	});

	it("shows a notice and opens nothing when the path does not exist", async () => {
		reset();
		const ui = createVscodeSourceLinkUi("/proj");

		await ui.openSource({ path: "src/missing.ts", line: 1 });

		expect(hoisted.shown).toHaveLength(0);
		expect(hoisted.info[0]).toContain("not found");
	});

	it("prefers a symbol's definition (workspace symbol provider) over the grounded path", async () => {
		reset();
		hoisted.exists.add("/proj/src/usage.ts");
		hoisted.symbolHits = [
			{
				name: "Widget",
				kind: 4,
				location: { uri: { fsPath: "/proj/src/widget.ts" }, range: { start: { line: 9, character: 4 } } },
			},
		];
		const ui = createVscodeSourceLinkUi("/proj");

		// A grounded usage path/line is provided, but the definition should win.
		await ui.openSource({ symbol: "Widget", path: "src/usage.ts", line: 3 });

		expect(hoisted.shown).toHaveLength(1);
		expect(hoisted.shown[0].uri.fsPath).toBe("/proj/src/widget.ts");
		expect(hoisted.shown[0].selection.active.line).toBe(9);
	});

	it("disambiguates multiple symbol hits with a quick pick", async () => {
		reset();
		const hitB = {
			name: "Widget",
			kind: 4,
			location: { uri: { fsPath: "/proj/b.ts" }, range: { start: { line: 1, character: 0 } } },
		};
		hoisted.symbolHits = [
			{
				name: "Widget",
				kind: 4,
				location: { uri: { fsPath: "/proj/a.ts" }, range: { start: { line: 0, character: 0 } } },
			},
			hitB,
		];
		hoisted.pickResult = { location: hitB.location };
		const ui = createVscodeSourceLinkUi("/proj");

		await ui.openSource({ symbol: "Widget" });

		expect(hoisted.shown).toHaveLength(1);
		expect(hoisted.shown[0].uri.fsPath).toBe("/proj/b.ts");
	});

	it("falls back to the grounded path/line when the provider finds nothing", async () => {
		reset();
		hoisted.exists.add("/proj/src/usage.ts");
		hoisted.symbolHits = [];
		const ui = createVscodeSourceLinkUi("/proj");

		await ui.openSource({ symbol: "Widget", path: "src/usage.ts", line: 3 });

		expect(hoisted.shown).toHaveLength(1);
		expect(hoisted.shown[0].uri.fsPath).toBe("/proj/src/usage.ts");
		expect(hoisted.shown[0].selection.active.line).toBe(2);
	});

	it("shows a notice when a symbol resolves nowhere and no path is given", async () => {
		reset();
		hoisted.symbolHits = [];
		const ui = createVscodeSourceLinkUi("/proj");

		await ui.openSource({ symbol: "Nope" });

		expect(hoisted.shown).toHaveLength(0);
		expect(hoisted.info[0]).toContain("couldn't locate");
	});
});
