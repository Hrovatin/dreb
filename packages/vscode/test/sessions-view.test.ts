import { describe, expect, it, vi } from "vitest";

// The sidebar view only needs `Uri` (joinPath/file) from vscode to build its
// resource root + HTML. A minimal path-joining Uri is enough to prove the root
// is re-resolved from the injected thunk on every view resolve (the self-heal),
// rather than captured once at construction.
vi.mock("vscode", () => {
	class Uri {
		constructor(public fsPath: string) {}
		static file(p: string): Uri {
			return new Uri(p);
		}
		static joinPath(base: Uri, ...segs: string[]): Uri {
			return new Uri([base.fsPath, ...segs].join("/"));
		}
		toString(): string {
			return this.fsPath;
		}
	}
	return { Uri };
});

import * as vscode from "vscode";
import { SessionsViewProvider } from "../src/host/sessions-view.js";

/** Minimal fake WebviewView capturing the options + HTML the provider sets. */
function makeView() {
	let html = "";
	let options: { localResourceRoots?: vscode.Uri[] } | undefined;
	const view = {
		webview: {
			get options() {
				return options;
			},
			set options(v: any) {
				options = v;
			},
			get html() {
				return html;
			},
			set html(v: string) {
				html = v;
			},
			asWebviewUri: (u: vscode.Uri) => u,
			cspSource: "vscode-webview:",
			onDidReceiveMessage: () => ({ dispose() {} }),
		},
		onDidDispose: () => ({ dispose() {} }),
	};
	return {
		view: view as unknown as vscode.WebviewView,
		root: () => options?.localResourceRoots?.[0]?.fsPath,
		html: () => html,
	};
}

// The provider constructs a SessionsViewModel from these, but `resolveWebviewView`
// never touches the model, so a bare stub cast is sufficient for this test.
const stubDeps = {} as any;

describe("SessionsViewProvider — resource root self-heal", () => {
	it("resolves the extension root from the thunk at view-resolve time (not captured at construction)", () => {
		const resolve = vi.fn(() => vscode.Uri.file("/real/monorepo/packages/vscode"));
		const provider = new SessionsViewProvider(resolve, stubDeps);

		// Constructing the provider must NOT eagerly resolve the root.
		expect(resolve).not.toHaveBeenCalled();

		const { view, root, html } = makeView();
		provider.resolveWebviewView(view);

		expect(resolve).toHaveBeenCalledTimes(1);
		expect(root()).toBe("/real/monorepo/packages/vscode/dist/webview-sidebar");
		expect(html()).toContain("/real/monorepo/packages/vscode/dist/webview-sidebar/main.js");
	});

	it("re-resolves on a later view resolve, so a recovered realpath heals a prior symlink fallback", () => {
		// First resolve returns the raw symlink fallback (realpath had failed);
		// a later resolve returns the recovered real path.
		const FALLBACK = "/Users/me/.vscode/extensions/pub.name";
		const REAL = "/Users/me/Documents/code/dreb/packages/vscode";
		const resolve = vi
			.fn<[], vscode.Uri>()
			.mockReturnValueOnce(vscode.Uri.file(FALLBACK))
			.mockReturnValue(vscode.Uri.file(REAL));
		const provider = new SessionsViewProvider(resolve, stubDeps);

		const first = makeView();
		provider.resolveWebviewView(first.view);
		expect(first.root()).toBe(`${FALLBACK}/dist/webview-sidebar`);

		// The view is disposed and re-created (e.g. collapse/expand or reload);
		// the sidebar picks up the recovered path instead of pinning the fallback.
		const second = makeView();
		provider.resolveWebviewView(second.view);
		expect(resolve).toHaveBeenCalledTimes(2);
		expect(second.root()).toBe(`${REAL}/dist/webview-sidebar`);
		expect(second.html()).toContain(`${REAL}/dist/webview-sidebar/main.js`);
	});
});
