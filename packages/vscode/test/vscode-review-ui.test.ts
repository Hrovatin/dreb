/**
 * vscode-backed ReviewUi — SCM SourceControl lifecycle (issue 56).
 *
 * `vscode` is mocked so the lazy create/dispose behavior of the
 * "dreb — pending review" SourceControl is exercised without a real editor:
 * it must appear only while files are pending and be disposed the moment the
 * set empties (accept-all / clear), so no stale or accumulating empty providers
 * are left in the Source Control view.
 */

import { describe, expect, it, vi } from "vitest";
import type { ReviewFileDto } from "../src/shared/protocol.js";

const hoisted = vi.hoisted(() => ({
	sourceControls: [] as MockSourceControl[],
	providerRegs: [] as MockDisposable[],
	contentProviders: [] as MockContentProviderReg[],
}));

interface MockDisposable {
	disposed: boolean;
	dispose(): void;
}
interface MockGroup extends MockDisposable {
	id: string;
	resourceStates: unknown[];
}
interface MockSourceControl extends MockDisposable {
	id: string;
	label: string;
	count: number;
	quickDiffProvider: unknown;
	groups: MockGroup[];
	createResourceGroup(id: string, label: string): MockGroup;
}

/** The `dreb-baseline:` content provider registered on the workspace, captured so
 * tests can invoke it directly (it serves the left side of every diff / gutter). */
interface MockContentProviderReg {
	scheme: string;
	provider: { provideTextDocumentContent(uri: { query: string }): string };
}
/** Registered quick-diff provider, exposed on the SourceControl. */
interface MockQuickDiff {
	provideOriginalResource(uri: unknown): unknown;
}
/** Shape of a single pending-file SCM resource state produced by `setPending`. */
interface MockResourceState {
	resourceUri: { scheme: string; fsPath: string; path: string };
	decorations: { tooltip: string; strikeThrough: boolean };
	command: { command: string; title: string; arguments: unknown[] };
}

vi.mock("vscode", () => {
	class EventEmitter {
		event = () => ({ dispose() {} });
		fire() {}
		dispose() {}
	}
	return {
		EventEmitter,
		Uri: {
			file: (p: string) => ({ scheme: "file", fsPath: p, path: p }),
			from: (o: unknown) => ({ ...(o as object) }),
		},
		scm: {
			createSourceControl: (id: string, label: string): MockSourceControl => {
				const groups: MockGroup[] = [];
				const sc: MockSourceControl = {
					id,
					label,
					count: 0,
					quickDiffProvider: undefined,
					disposed: false,
					groups,
					createResourceGroup(gid: string) {
						const g: MockGroup = {
							id: gid,
							resourceStates: [],
							disposed: false,
							dispose() {
								this.disposed = true;
							},
						};
						groups.push(g);
						return g;
					},
					dispose() {
						this.disposed = true;
					},
				};
				hoisted.sourceControls.push(sc);
				return sc;
			},
		},
		workspace: {
			registerTextDocumentContentProvider: (scheme: string, provider: unknown): MockDisposable => {
				hoisted.contentProviders.push({ scheme, provider } as MockContentProviderReg);
				const reg: MockDisposable = {
					disposed: false,
					dispose() {
						this.disposed = true;
					},
				};
				hoisted.providerRegs.push(reg);
				return reg;
			},
		},
		commands: { executeCommand: vi.fn(async () => {}) },
	};
});

import { createVscodeReviewUi } from "../src/host/vscode-review-ui.js";

function reset() {
	hoisted.sourceControls = [];
	hoisted.providerRegs = [];
	hoisted.contentProviders = [];
}

const file = (path: string): ReviewFileDto => ({ path, status: "modified", hunkCount: 1 });

/** The most-recently registered `dreb-baseline:` content provider. */
function latestContentProvider(): MockContentProviderReg["provider"] {
	const reg = hoisted.contentProviders.at(-1);
	if (reg === undefined) throw new Error("no dreb-baseline content provider was registered");
	return reg.provider;
}

/** SourceControls that are currently registered (created but not yet disposed). */
function liveSourceControls(): MockSourceControl[] {
	return hoisted.sourceControls.filter((sc) => !sc.disposed);
}

describe("createVscodeReviewUi — SCM lifecycle", () => {
	it("does not create a SourceControl until something is pending", () => {
		reset();
		createVscodeReviewUi("/proj");
		expect(hoisted.sourceControls).toHaveLength(0);
	});

	it("creates a single SourceControl and lists files on a non-empty setPending", () => {
		reset();
		const ui = createVscodeReviewUi("/proj");
		ui.setPending([file("a.ts"), file("b.ts")]);

		expect(hoisted.sourceControls).toHaveLength(1);
		const sc = hoisted.sourceControls[0];
		expect(sc.disposed).toBe(false);
		expect(sc.count).toBe(2);
		expect(sc.quickDiffProvider).toBeDefined();
		expect(sc.groups[0].resourceStates).toHaveLength(2);
	});

	it("disposes the SourceControl when pending becomes empty (no lingering entry)", () => {
		reset();
		const ui = createVscodeReviewUi("/proj");
		ui.setPending([file("a.ts")]);
		ui.setPending([]);

		expect(hoisted.sourceControls).toHaveLength(1);
		expect(hoisted.sourceControls[0].disposed).toBe(true);
		expect(liveSourceControls()).toHaveLength(0);
	});

	it("disposes the SourceControl on clear() (accept-all)", () => {
		reset();
		const ui = createVscodeReviewUi("/proj");
		ui.setPending([file("a.ts")]);
		ui.clear();

		expect(hoisted.sourceControls[0].disposed).toBe(true);
		expect(liveSourceControls()).toHaveLength(0);
	});

	it("recreates a fresh SourceControl on the next non-empty pending, never reusing a disposed one", () => {
		reset();
		const ui = createVscodeReviewUi("/proj");
		ui.setPending([file("a.ts")]);
		ui.setPending([]);
		ui.setPending([file("c.ts")]);

		expect(hoisted.sourceControls).toHaveLength(2);
		expect(hoisted.sourceControls[0].disposed).toBe(true);
		expect(hoisted.sourceControls[1].disposed).toBe(false);
		// At most one live entry at any time — no accumulation.
		expect(liveSourceControls()).toHaveLength(1);
		expect(liveSourceControls()[0].groups[0].resourceStates).toHaveLength(1);
	});

	it("reuses the same live SourceControl across successive non-empty updates", () => {
		reset();
		const ui = createVscodeReviewUi("/proj");
		ui.setPending([file("a.ts")]);
		ui.setPending([file("a.ts"), file("b.ts")]);

		expect(hoisted.sourceControls).toHaveLength(1);
		expect(hoisted.sourceControls[0].count).toBe(2);
	});

	it("setPending([]) on a UI that never had pending files creates nothing", () => {
		reset();
		const ui = createVscodeReviewUi("/proj");
		ui.setPending([]);
		expect(hoisted.sourceControls).toHaveLength(0);
	});

	it("dispose() tears down the content provider and any live SourceControl without throwing", () => {
		reset();
		const ui = createVscodeReviewUi("/proj");
		ui.setPending([file("a.ts")]);
		expect(() => ui.dispose()).not.toThrow();

		expect(hoisted.sourceControls[0].disposed).toBe(true);
		expect(hoisted.providerRegs[0].disposed).toBe(true);
	});

	it("dispose() is safe when no SourceControl was ever created", () => {
		reset();
		const ui = createVscodeReviewUi("/proj");
		expect(() => ui.dispose()).not.toThrow();

		expect(hoisted.sourceControls).toHaveLength(0);
		expect(hoisted.providerRegs[0].disposed).toBe(true);
	});
});

describe("createVscodeReviewUi — baseline content", () => {
	it("serves content set via setBaseline (keyed by the URI query) and empty for unknown paths", () => {
		reset();
		const ui = createVscodeReviewUi("/proj");
		ui.setBaseline("a.ts", "old contents\n");

		const provider = latestContentProvider();
		// The `dreb-baseline:` URI carries the working path in its query — that's the lookup key.
		expect(provider.provideTextDocumentContent({ query: "a.ts" })).toBe("old contents\n");
		// Unknown path → "" (never undefined), so the diff's left side stays stable.
		expect(provider.provideTextDocumentContent({ query: "missing.ts" })).toBe("");
	});

	it("treats a nullish baseline as empty content", () => {
		reset();
		const ui = createVscodeReviewUi("/proj");
		ui.setBaseline("a.ts", null);
		expect(latestContentProvider().provideTextDocumentContent({ query: "a.ts" })).toBe("");
	});

	it("exposes a quick-diff original resource only for files that have a known baseline", () => {
		reset();
		const ui = createVscodeReviewUi("/proj");
		ui.setBaseline("a.ts", "old\n");
		ui.setPending([file("a.ts")]);

		const quickDiff = hoisted.sourceControls[0].quickDiffProvider as MockQuickDiff;
		// Working-tree file under the repo root with a baseline → the dreb-baseline URI
		// (not the working file itself and not null): VS Code dispatches content
		// resolution by scheme, and the query carries the path the content provider keys on.
		expect(quickDiff.provideOriginalResource({ scheme: "file", fsPath: "/proj/a.ts" })).toMatchObject({
			scheme: "dreb-baseline",
			query: "a.ts",
		});
		// File without a baseline → undefined (no phantom gutter).
		expect(quickDiff.provideOriginalResource({ scheme: "file", fsPath: "/proj/b.ts" })).toBeUndefined();
	});

	it("clear() drops baselines so a later review cycle can't leak the previous left side", () => {
		reset();
		const ui = createVscodeReviewUi("/proj");
		ui.setBaseline("a.ts", "old contents\n");
		ui.clear();
		// Same content provider (it survives clear); its map must have been emptied.
		expect(latestContentProvider().provideTextDocumentContent({ query: "a.ts" })).toBe("");
	});
});

describe("createVscodeReviewUi — pending resource states", () => {
	it("wires each pending file's resourceUri, click-to-diff command, tooltip and strikeThrough", () => {
		reset();
		const ui = createVscodeReviewUi("/proj");
		ui.setPending([
			{ path: "src/a.ts", status: "modified", hunkCount: 1 },
			{ path: "src/gone.ts", status: "deleted", hunkCount: 0 },
		]);

		const states = hoisted.sourceControls[0].groups[0].resourceStates as MockResourceState[];
		expect(states).toHaveLength(2);
		const [modified, deleted] = states;

		// resourceUri is anchored at the repo root, not a bare relative path.
		expect(modified.resourceUri.fsPath).toBe("/proj/src/a.ts");
		// Clicking the entry opens our diff, passing the repo-relative path as the arg.
		expect(modified.command.command).toBe("dreb.review.openDiff");
		expect(modified.command.arguments[0]).toBe("src/a.ts");
		// Tooltip summarizes status + hunk count; modified files are not struck through.
		expect(modified.decorations.tooltip).toBe("modified · 1 hunk — pending dreb review");
		expect(modified.decorations.strikeThrough).toBe(false);

		// Deleted files are struck through; with no hunks the tooltip omits the hunk suffix.
		expect(deleted.resourceUri.fsPath).toBe("/proj/src/gone.ts");
		expect(deleted.decorations.strikeThrough).toBe(true);
		expect(deleted.decorations.tooltip).toBe("deleted — pending dreb review");
	});

	it("pluralizes the hunk count in the tooltip", () => {
		reset();
		const ui = createVscodeReviewUi("/proj");
		ui.setPending([{ path: "a.ts", status: "modified", hunkCount: 3 }]);
		const states = hoisted.sourceControls[0].groups[0].resourceStates as MockResourceState[];
		expect(states[0].decorations.tooltip).toBe("modified · 3 hunks — pending dreb review");
	});
});
