/**
 * HostUi — the small port through which the (vscode-free, unit-testable)
 * SessionController drives native VS Code prompts: quick picks (model / thinking
 * selection), input boxes (`/name`), and open/save dialogs (`/import`,
 * `/export`). The real implementation lives in `vscode-host-ui.ts` (which imports
 * `vscode`); tests inject a fake. This module deliberately imports nothing from
 * `vscode` so the controller and its tests stay node-only.
 */

/** One selectable entry in a quick pick; `value` is the opaque payload returned. */
export interface HostUiPickItem {
	label: string;
	description?: string;
	detail?: string;
	/** Returned by `quickPick` when this item is chosen. */
	value: string;
}

/** A file or folder chosen via the native workspace picker (`@` context tag). */
export interface PickedFile {
	/** Absolute filesystem path. */
	fsPath: string;
	/** True when the picked path is a directory. */
	isDirectory: boolean;
}

export interface HostUi {
	/** Show a quick pick; resolves to the chosen item's `value`, or undefined if dismissed. */
	quickPick(items: HostUiPickItem[], options?: { placeholder?: string }): Promise<string | undefined>;
	/** Show an input box; resolves to the entered text, or undefined if dismissed. */
	inputBox(options?: { prompt?: string; value?: string; placeholder?: string }): Promise<string | undefined>;
	/** Show a save dialog; resolves to the chosen filesystem path, or undefined. */
	saveDialog(options?: { defaultName?: string; filters?: Record<string, string[]> }): Promise<string | undefined>;
	/** Show an open dialog (single file); resolves to the chosen path, or undefined. */
	openDialog(options?: { filters?: Record<string, string[]> }): Promise<string | undefined>;
	/** Show the native file/folder picker (multi-select) for tagging context;
	 * resolves to the chosen files/folders, or undefined if dismissed. */
	pickWorkspaceFiles(): Promise<PickedFile[] | undefined>;
}

/** No-op HostUi: every prompt resolves to undefined (as if dismissed). Used as
 * the default when no UI is injected (tests, headless), so interactive builtins
 * simply cancel rather than throw. */
export const noopHostUi: HostUi = {
	async quickPick() {
		return undefined;
	},
	async inputBox() {
		return undefined;
	},
	async saveDialog() {
		return undefined;
	},
	async openDialog() {
		return undefined;
	},
	async pickWorkspaceFiles() {
		return undefined;
	},
};
