/// <reference types="vscode" />

/**
 * vscode-backed HostUi — wraps `vscode.window.*` prompts behind the `HostUi`
 * port so the SessionController stays vscode-free and unit-testable. Only the
 * extension host constructs this (via `extension.ts`).
 */

import * as vscode from "vscode";
import type { HostUi, HostUiPickItem } from "./host-ui.js";

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
	};
}
