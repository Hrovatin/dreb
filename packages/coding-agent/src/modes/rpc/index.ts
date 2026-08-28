/**
 * RPC client and types for programmatic access to the coding agent.
 *
 * Usage:
 *   import { RpcClient } from "@dreb/coding-agent/rpc";
 */

export type { ModelInfo, RpcClientOptions, RpcEventListener, RpcExitInfo, RpcExitListener } from "./rpc-client.js";
export { RpcClient } from "./rpc-client.js";
// Projection gate + canonical uiType constants, so RPC consumers (e.g. the
// VSCode host) reference one source of truth for the "vscode" opt-in string
// rather than re-typing a literal that could silently drift (issue 84).
export {
	DASHBOARD_UI_TYPE,
	PROJECTED_UI_TYPES,
	shouldProjectRpcEvents,
	VSCODE_UI_TYPE,
} from "./rpc-event-projection.js";
export type {
	RpcAgentTypeInfo,
	RpcBackgroundAgentInfo,
	RpcCommand,
	RpcCommandType,
	RpcContextTrustEvaluation,
	RpcContextTrustMutationResult,
	RpcDashboardSnapshot,
	RpcDashboardSnapshotBarrierEvent,
	RpcEvent,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcPendingMessages,
	RpcPerformanceStats,
	RpcQueuedMessage,
	RpcResources,
	RpcResponse,
	RpcScopedModel,
	RpcSessionInfo,
	RpcSessionState,
	RpcSessionTask,
	RpcSettingsSetResult,
	RpcSettingsSnapshot,
	RpcSettingsUpdate,
	RpcSlashCommand,
	RpcTreeNode,
	RpcTrustedFolderRemovalResult,
} from "./rpc-types.js";
