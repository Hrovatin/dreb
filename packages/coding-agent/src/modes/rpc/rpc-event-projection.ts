/**
 * RPC event projection for consumers that don't read the cumulative fields.
 *
 * `message_update` events carry two cumulative copies of the growing assistant
 * message: the top-level `message` field and `assistantMessageEvent.partial`.
 * Serializing both for every token makes the child->parent JSONL pipe quadratic
 * in response length and floods the stdout queue (see issue 448).
 *
 * Consumers that rebuild the transcript from the delta fields (`delta`,
 * `content`, `toolCall`, `contentIndex`) plus `message_end` never read those
 * cumulative fields, so stripping them is lossless for them. This currently
 * covers two consumers:
 *   - the dashboard, whose browser reducer consumes only deltas and whose
 *     authoritative transcript comes from `message_end` plus
 *     `get_dashboard_snapshot` responses (its own EventHub already strips the
 *     same fields at the browser SSE boundary via projectDashboardEvent);
 *   - the VSCode extension, whose projection reducer likewise reads only the
 *     `assistantMessageEvent` delta fields (see packages/vscode
 *     src/shared/projection.ts). Without this bounding a long reply overruns
 *     the child's 16 MiB stdout queue and kills it mid-reply before
 *     `message_end` persists the reply (issue 84).
 * This module applies the removal one boundary earlier than the dashboard's
 * EventHub — before JSONL serialization in runRpcMode.
 *
 * Generic RPC consumers (`uiType === "rpc"`) may still rely on the cumulative
 * fields and are left untouched; see `shouldProjectRpcEvents`.
 *
 * Only the quadratic `message_update` fields are removed here. Broader bounding
 * (agent_end messages, tool_execution_update args, retry discardedPartial,
 * images) remains the EventHub's browser-facing concern.
 */

/**
 * uiTypes whose consumers rebuild the transcript from delta fields + message_end
 * and therefore never read the cumulative `message`/`partial` fields. Their RPC
 * event stream is projected (bounded) before serialization. Generic RPC
 * consumers (`"rpc"`) are intentionally excluded so their protocol is unchanged.
 */
export function shouldProjectRpcEvents(uiType: string | undefined): boolean {
	return uiType === "dashboard" || uiType === "vscode";
}

function omit(event: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
	const copy = { ...event };
	for (const key of keys) delete copy[key];
	return copy;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Project a single agent session event for dashboard-mode RPC transport.
 *
 * Unknown event types are returned exactly as received (same reference) so
 * extensions and future event types remain forward-safe. Projected events are
 * shallow copies — the input event is never mutated, because other session
 * subscribers (and the session's own state) share the same object.
 */
export function projectDashboardRpcEvent(event: Record<string, unknown>): Record<string, unknown> {
	switch (event.type) {
		case "message_update": {
			const projected = omit(event, "message");
			const streamEvent = event.assistantMessageEvent;
			return isPlainObject(streamEvent)
				? { ...projected, assistantMessageEvent: omit(streamEvent, "partial") }
				: projected;
		}
		case "background_agent_event": {
			const child = event.event;
			return isPlainObject(child) ? { ...event, event: projectDashboardRpcEvent(child) } : event;
		}
		default:
			return event;
	}
}
