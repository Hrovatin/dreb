import type { HostToSidebar, SidebarToHost } from "../../shared/sidebar-protocol.js";

/**
 * Thin wrapper around the VS Code webview messaging API, typed to the sidebar
 * protocol. `acquireVsCodeApi` is injected into the webview global scope by VS
 * Code and may be called only once.
 */
interface VsCodeApi {
	postMessage(message: SidebarToHost): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function postToHost(message: SidebarToHost): void {
	api.postMessage(message);
}

export function onHostMessage(handler: (message: HostToSidebar) => void): () => void {
	const listener = (event: MessageEvent) => handler(event.data as HostToSidebar);
	window.addEventListener("message", listener);
	return () => window.removeEventListener("message", listener);
}
