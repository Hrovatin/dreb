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
			registerTextDocumentContentProvider: (): MockDisposable => {
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
}

const file = (path: string): ReviewFileDto => ({ path, status: "modified", hunkCount: 1 });

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
