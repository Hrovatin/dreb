/// <reference types="vscode" />

/**
 * vscode-backed ReviewUi — the native change-review surface.
 *
 * Three vscode pieces, all owned here so the controller stays vscode-free:
 *  - a `TextDocumentContentProvider` on the `dreb-baseline:` scheme that serves
 *    each reviewed file's baseline content (the left/original side of a diff and
 *    the quick-diff gutter reference);
 *  - a `QuickDiffProvider` on an SCM `SourceControl` ("dreb — pending review")
 *    whose resource group lists the pending files, so VS Code draws inline
 *    change gutters against our baseline for free. The SourceControl is created
 *    lazily (only while files are pending) and disposed the moment the set
 *    empties, so an accepted/empty cycle never leaves a stale entry in the
 *    Source Control view and idle sessions don't accumulate empty providers;
 *  - `openDiff`, which opens the built-in diff editor (baseline ↔ working file).
 *
 * The per-hunk *revert* itself is NOT done here — the controller performs it via
 * git (`git apply --reverse`); this surface only visualizes and lists.
 */

import { isAbsolute, join, relative, sep } from "node:path";
import * as vscode from "vscode";
import type { ReviewFileDto } from "../shared/protocol.js";
import { findGitRoot } from "./git-snapshot.js";
import type { ReviewUi } from "./review-ui.js";

export const BASELINE_SCHEME = "dreb-baseline";

/** Build the `dreb-baseline:` URI that mirrors a working-tree path. The working
 * path rides in the query so the content provider can look up its baseline. */
function baselineUri(path: string): vscode.Uri {
	return vscode.Uri.from({ scheme: BASELINE_SCHEME, path: `/${path}`, query: path });
}

export function createVscodeReviewUi(cwd: string): ReviewUi & vscode.Disposable {
	// Change-review paths are repo-root-relative (they come from diffing git tree
	// objects), so every path join / URI must be anchored to the repository root,
	// not the workspace cwd — otherwise a workspace opened at a subdirectory of
	// the repo would build wrong file URIs and quick-diff would never match.
	const root = findGitRoot(cwd) ?? cwd;
	const baselines = new Map<string, string>();
	const changeEmitter = new vscode.EventEmitter<vscode.Uri>();

	const contentProvider: vscode.TextDocumentContentProvider = {
		onDidChange: changeEmitter.event,
		provideTextDocumentContent(uri) {
			return baselines.get(uri.query) ?? "";
		},
	};

	const quickDiff: vscode.QuickDiffProvider = {
		provideOriginalResource(uri) {
			const rel = toRepoRelative(root, uri);
			if (rel === undefined || !baselines.has(rel)) return undefined;
			return baselineUri(rel);
		},
	};

	// The SCM SourceControl (the "dreb — pending review" entry in the Source
	// Control view) is created lazily and disposed as soon as nothing is pending,
	// so an accepted/empty cycle never leaves a stale entry behind and idle
	// sessions don't accumulate empty providers. The quick-diff + baseline content
	// provider stay registered for the session (they never appear in the SCM view
	// and only matter while a diff/gutter is actually shown).
	let scm: vscode.SourceControl | undefined;
	let group: vscode.SourceControlResourceGroup | undefined;

	function ensureSourceControl(): { scm: vscode.SourceControl; group: vscode.SourceControlResourceGroup } {
		if (scm === undefined || group === undefined) {
			scm = vscode.scm.createSourceControl("drebReview", "dreb — pending review", vscode.Uri.file(root));
			scm.quickDiffProvider = quickDiff;
			group = scm.createResourceGroup("pending", "Pending review");
		}
		return { scm, group };
	}

	function disposeSourceControl(): void {
		group?.dispose();
		scm?.dispose();
		group = undefined;
		scm = undefined;
	}

	const providerReg = vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, contentProvider);

	const ui: ReviewUi & vscode.Disposable = {
		setBaseline(path, content) {
			baselines.set(path, content ?? "");
			changeEmitter.fire(baselineUri(path));
		},
		setPending(files: ReviewFileDto[]) {
			// Nothing pending → tear the SCM entry down entirely rather than leaving
			// an empty "dreb — pending review" provider lingering in the view.
			if (files.length === 0) {
				disposeSourceControl();
				return;
			}
			const { scm: sourceControl, group: pending } = ensureSourceControl();
			pending.resourceStates = files.map((f) => {
				const resourceUri = vscode.Uri.file(join(root, f.path));
				return {
					resourceUri,
					decorations: {
						tooltip: describe(f),
						strikeThrough: f.status === "deleted",
					},
					command: {
						command: "dreb.review.openDiff",
						title: "Open Diff",
						arguments: [f.path],
					},
				} satisfies vscode.SourceControlResourceState;
			});
			sourceControl.count = files.length;
		},
		async openDiff(path) {
			const left = baselineUri(path);
			const right = vscode.Uri.file(join(root, path));
			await vscode.commands.executeCommand("vscode.diff", left, right, `${path} (dreb review)`);
		},
		clear() {
			baselines.clear();
			disposeSourceControl();
		},
		dispose() {
			changeEmitter.dispose();
			disposeSourceControl();
			providerReg.dispose();
		},
	};

	return ui;
}

/** Resolve a working-tree URI to its repo-relative path, or undefined if it is
 * not under `cwd`. */
function toRepoRelative(cwd: string, uri: vscode.Uri): string | undefined {
	if (uri.scheme !== "file") return undefined;
	const rel = relative(cwd, uri.fsPath);
	if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return rel.split(sep).join("/");
}

function describe(f: ReviewFileDto): string {
	const kind = f.status === "binary" ? "binary change" : f.status;
	const hunks = f.hunkCount > 0 ? ` · ${f.hunkCount} hunk${f.hunkCount === 1 ? "" : "s"}` : "";
	return `${kind}${hunks} — pending dreb review`;
}
