/**
 * CLI argument construction for the RPC child the extension spawns.
 *
 * Kept vscode-free (structural {@link ConfigReader} instead of
 * `vscode.WorkspaceConfiguration`) so it is directly unit-testable in the node
 * test environment without a VS Code API mock — the `--ui vscode` wiring is the
 * actual fix for issue 84 and must be regression-tested.
 */

/** Minimal structural view of `vscode.WorkspaceConfiguration` used here. */
export interface ConfigReader {
	get<T>(section: string): T | undefined;
}

/**
 * Build the CLI args for the RPC child.
 *
 * Always emits `--ui vscode` first so the child projects (bounds) the
 * `message_update` event stream. Without it the child receives the full
 * O(n^2) cumulative stream and a long reply overruns the 16 MiB stdout queue,
 * killing the child mid-reply before the reply is persisted (issue 84). The
 * `"vscode"` literal must match `shouldProjectRpcEvents`'s accepted set in
 * `@dreb/coding-agent/rpc`; the build-args test cross-checks that agreement so
 * a drift on either side fails CI instead of silently reverting the fix.
 */
export function buildArgs(config: ConfigReader): string[] {
	const args: string[] = [];
	args.push("--ui", "vscode");
	const provider = config.get<string>("provider")?.trim();
	const model = config.get<string>("model")?.trim();
	if (provider) args.push("--provider", provider);
	if (model) args.push("--model", model);
	return args;
}
