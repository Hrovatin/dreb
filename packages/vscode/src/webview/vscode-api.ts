import type { HostToWebview, WebviewToHost } from "../shared/protocol.js";

/**
 * Thin wrapper around the VS Code webview messaging API. `acquireVsCodeApi` is
 * injected into the webview global scope by VS Code and may be called only once.
 */
interface VsCodeApi {
	postMessage(message: WebviewToHost): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function postToHost(message: WebviewToHost): void {
	api.postMessage(message);
}

export function onHostMessage(handler: (message: HostToWebview) => void): () => void {
	const listener = (event: MessageEvent) => handler(event.data as HostToWebview);
	window.addEventListener("message", listener);
	return () => window.removeEventListener("message", listener);
}
