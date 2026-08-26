/**
 * Pure transcript projection — folds dreb RPC session events into a render
 * model. No DOM, no framework, and NO `@dreb/coding-agent` import: this module
 * is shared verbatim by the extension host (which keeps the authoritative
 * state) and the webview (which applies the same events for live rendering),
 * so it must stay dependency-free and unit-testable in plain node.
 *
 * Model: an append-only list of transcript items. A "response" groups one agent
 * run's streamed output, separating the collapsible *activity* (thinking +
 * tool calls) from the clean *answer* (assistant text). Events are typed
 * structurally (`any`) on purpose — dispatch on `type`, ignore unknown values.
 */

export interface ThinkingActivity {
	kind: "thinking";
	text: string;
}

export interface ToolActivity {
	kind: "tool";
	toolCallId: string;
	toolName: string;
	args: unknown;
	status: "running" | "done" | "error";
	/** Result text (or partial output while running). */
	resultText: string;
}

export type ActivityItem = ThinkingActivity | ToolActivity;

/** One collapsible activity box: a contiguous run of thinking + tool calls that
 * arrived with no answer text between them. These `items` are the sole store of
 * the run's activity — the flat aggregate ({@link runActivity}) is derived from
 * them — so a tool-result update mutates exactly the object the box renders. */
export interface ActivitySegment {
	kind: "activity";
	items: ActivityItem[];
	/** Per-box collapse state: a box auto-collapses once the next segment (an
	 * answer block, or the run's end) opens after it. */
	collapsed: boolean;
}

/** One clean answer block: a contiguous run of assistant text with no activity
 * between deltas. */
export interface AnswerSegment {
	kind: "answer";
	text: string;
}

/** Ordered piece of a response run. Segments interleave in true arrival order so
 * the transcript renders `activity → answer → activity → answer` as it actually
 * streamed, instead of hoisting all activity above all answer text. This is what
 * {@link ResponseView} iterates. */
export type ResponseSegment = ActivitySegment | AnswerSegment;

export interface ResponseGroup {
	kind: "response";
	id: number;
	/** Ordered interleaving of activity boxes and answer blocks for this run —
	 * the single render source of truth *and* the sole store of activity items.
	 * The flat activity aggregate used by grounded refs / the summary is DERIVED
	 * from these segments via {@link runActivity}, so there is never a second copy
	 * to fall out of sync (see the mid-stream-snapshot regression this avoids: a
	 * JSON-serialized snapshot would duplicate a shared reference, leaving a
	 * separately-stored aggregate frozen while the rendered segment updated). */
	segments: ResponseSegment[];
	/** Accumulated final-answer markdown aggregated across the whole run. Used for
	 * persistence/crash-recovery bookkeeping (offset math), not for rendering. */
	answer: string;
	/** Internal: activity-item count when the last answer text was appended. Used to
	 * detect a new narration block (activity arrived since the last text) so
	 * consecutive text blocks in one run are separated instead of concatenated in
	 * the `answer` aggregate. Not rendered. */
	answerActivityMark?: number;
	/** True between agent_start and agent_end for this run. */
	streaming: boolean;
	/** Run-level state: set true once the run ends (a coarse "this run is
	 * finished" flag, e.g. asserted in tests). Individual activity boxes carry
	 * their own {@link ActivitySegment.collapsed}, which is what the renderer
	 * actually reads to fold each box. */
	collapsed: boolean;
	/** Provider failure text, if this run ended in an error. */
	error?: string;
	/** True when the run's last assistant message ended interrupted
	 * (`stopReason: "aborted"`) — user-cancelled or recovered after a child crash.
	 * Rendered as a subtle marker so a truncated answer isn't mistaken for a
	 * complete one. */
	aborted?: boolean;
}

export interface UserItem {
	kind: "user";
	text: string;
}

/** Host-emitted informational line kept in the transcript (e.g. `/session` stats). */
export interface SystemItem {
	kind: "system";
	text: string;
}

/** Host-emitted notice shown after the RPC child crashed and was auto-recovered:
 * the transcript was rebuilt but the in-flight reply was lost, so the session is
 * idle. `canRetry` is true when the host retained a last prompt that can be
 * resent via the existing `{ type: "retry" }` path. */
export interface RecoveryItem {
	kind: "recovery";
	text: string;
	canRetry: boolean;
}

export type TranscriptItem = UserItem | ResponseGroup | SystemItem | RecoveryItem;

/** The agent's end-of-turn next-step suggestion (`suggest_next` tool). Mirrors
 * the TUI's ghost-text affordance: a single command the user most likely wants
 * to run next, plus an optional markdown recap of the work just done. The
 * command arrives on the `suggest_next` event; the `summary` (when present) is
 * folded in from the `suggest_next` tool result's `details`. Cleared at the
 * start of the next turn so it never lingers stale. */
export interface SuggestionState {
	command: string;
	summary?: string;
}

/**
 * An inline restore/fork control descriptor (Phase 6). Maps a rendered response
 * group to the session entry the webview forks from / navigates to. Kept out of
 * `TranscriptState` because it is host-derived (from the session tree) and
 * refreshes independently of the streamed transcript.
 */
export interface Checkpoint {
	/** The {@link ResponseGroup.id} this control attaches to. */
	responseId: number;
	/** Session entry id (the assistant turn) to fork from / restore to. */
	entryId: string;
	/** Whether "Restore Checkpoint" is offered — false for the latest turn,
	 * where restoring to where you already are is a no-op. */
	canRestore: boolean;
	/** Whether "Fork" is offered — false for turns the backend refuses to fork
	 * from (errored/aborted turns, and turns containing tool calls whose results
	 * live in descendant entries a branch cannot carry). Sourced from the
	 * `get_fork_messages` RPC so the control only appears where forking works. */
	canFork: boolean;
}

/** One question inside an `ask` wizard request, mirroring RpcAskQuestion. */
export interface AskQuestion {
	/** The question prompt (rendered as Markdown). */
	question: string;
	/** Optional per-question heading. */
	title?: string;
	/** Selectable options, if any. */
	options?: string[];
	/** Offer a free-text field (defaults true). */
	allowFreeText?: boolean;
	/** Render options as checkboxes instead of radios. */
	multiSelect?: boolean;
	/** Use a multi-line text area for free text. */
	multiline?: boolean;
}

/** A pending, blocking extension-UI request the user must answer. */
export interface UiRequest {
	id: string;
	method: "select" | "confirm" | "input" | "editor" | "ask";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	/** ask: one or more questions asked together as a single wizard. */
	questions?: AskQuestion[];
	/** ask: absolute runtime deadline (ms epoch); survives reload. */
	expiresAt?: number;
}

export interface TranscriptState {
	items: TranscriptItem[];
	/** True while an agent run is in flight (drives the composer/stop button). */
	streaming: boolean;
	/** Blocking extension-UI requests awaiting a response. */
	uiRequests: UiRequest[];
	/** Registry ids of background agents currently running for this session (added
	 * on `background_agent_start`, removed on `background_agent_end`). A non-empty
	 * set while the main turn is idle means work is still happening in the
	 * background — see {@link deriveSessionStatus}. */
	backgroundAgentIds: string[];
	/** Transient non-fatal status (retry/compaction); MVP surfaces a single line. */
	statusText?: string;
	/** Fatal host-side error (e.g. the RPC child process exited). */
	hostError?: string;
	/** The agent's end-of-turn next-step suggestion (`suggest_next`), surfaced as
	 * a dismissable bar above the composer. Undefined when there is none. */
	suggestion?: SuggestionState;
	/** Monotonic id source for response groups. */
	nextResponseId: number;
	/** Internal streaming bookkeeping: true once a `text_delta` arrived for the
	 * current text block, so `text_end` knows the block's content is already
	 * reflected in the answer. Non-streaming providers emit only `text_end` per
	 * block, so a false value means the block content still needs adopting. */
	sawTextDeltaInBlock: boolean;
}

export function createTranscriptState(): TranscriptState {
	return {
		items: [],
		streaming: false,
		uiRequests: [],
		backgroundAgentIds: [],
		nextResponseId: 1,
		sawTextDeltaInBlock: false,
	};
}

/** Flatten message content (string or content-part array) to plain text. */
function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const raw of content) {
		const part = raw as { text?: unknown };
		if (typeof part?.text === "string") parts.push(part.text);
	}
	return parts.join("\n");
}

/**
 * The active response is the last item when it is a still-streaming response
 * group. Everything a single agent run streams (thinking, tools, answer text)
 * lands in that one group. When `create` is set and there is none, a new group
 * is appended — this also covers runs that begin without a preceding
 * `agent_start` (defensive) and steered mid-run user turns.
 */
function activeResponse(state: TranscriptState, create: boolean): ResponseGroup | undefined {
	const last = state.items[state.items.length - 1];
	if (last && last.kind === "response" && last.streaming) return last;
	if (!create) return undefined;
	const group: ResponseGroup = {
		kind: "response",
		id: state.nextResponseId++,
		segments: [],
		answer: "",
		streaming: true,
		collapsed: false,
	};
	state.items.push(group);
	return group;
}

/** All activity items of a run, flattened across its activity segments in arrival
 * order. Derived on demand from {@link ResponseGroup.segments} (the sole store),
 * so grounded refs and the summary always read the same live objects the boxes
 * render — never a separately-stored copy that a snapshot round-trip could
 * freeze. */
export function runActivity(group: ResponseGroup): ActivityItem[] {
	const items: ActivityItem[] = [];
	for (const segment of group.segments) if (segment.kind === "activity") items.push(...segment.items);
	return items;
}

/** Count of a run's activity items without materializing the flattened array
 * (used for the answer-aggregate's narration-block bookkeeping). */
function activityCount(group: ResponseGroup): number {
	let n = 0;
	for (const segment of group.segments) if (segment.kind === "activity") n += segment.items.length;
	return n;
}

function lastThinking(group: ResponseGroup): ThinkingActivity | undefined {
	// The most recent activity item overall lives at the end of the trailing
	// activity segment (a later answer segment would mean a new thinking starts a
	// fresh box, so there is no in-flight thought to extend).
	const last = group.segments[group.segments.length - 1];
	if (!last || last.kind !== "activity") return undefined;
	const item = last.items[last.items.length - 1];
	return item?.kind === "thinking" ? item : undefined;
}

/** Append an activity item to the run: extend the trailing activity segment, or
 * open a new box when the last segment is an answer block (or there is none).
 * Items live only here (in {@link ResponseGroup.segments}); the flat aggregate is
 * derived via {@link runActivity}, so there is no second copy to keep in sync. */
function pushActivity(group: ResponseGroup, item: ActivityItem): void {
	const last = group.segments[group.segments.length - 1];
	if (last && last.kind === "activity") last.items.push(item);
	else group.segments.push({ kind: "activity", items: [item], collapsed: false });
}

/** Append assistant answer text. Extends the trailing answer segment, or opens a
 * new answer block (collapsing the activity box that preceded it, since that box
 * is now finished). Also maintains the flat {@link ResponseGroup.answer} aggregate
 * used for crash-recovery offset math — with the historical blank-line separator
 * so the recovered suffix keeps narration blocks readable. */
function appendAnswerText(group: ResponseGroup, text: string): void {
	if (!text) return;
	// Aggregate (persistence bookkeeping only — not rendered).
	const mark = group.answerActivityMark ?? 0;
	if (group.answer.length > 0 && activityCount(group) > mark && !group.answer.endsWith("\n\n")) {
		group.answer += group.answer.endsWith("\n") ? "\n" : "\n\n";
	}
	group.answer += text;
	group.answerActivityMark = activityCount(group);
	// Ordered segments (render source of truth).
	const last = group.segments[group.segments.length - 1];
	if (last && last.kind === "answer") {
		last.text += text;
	} else {
		if (last && last.kind === "activity") last.collapsed = true;
		group.segments.push({ kind: "answer", text });
	}
}

function findTool(group: ResponseGroup, toolCallId: string): ToolActivity | undefined {
	// Scan the segments (the sole store) newest-first so the returned object is
	// the exact one the box renders — a status/result mutation therefore always
	// reaches the DOM, even after a snapshot round-trip.
	for (let s = group.segments.length - 1; s >= 0; s--) {
		const segment = group.segments[s];
		if (segment.kind !== "activity") continue;
		for (let i = segment.items.length - 1; i >= 0; i--) {
			const item = segment.items[i];
			if (item.kind === "tool" && item.toolCallId === toolCallId) return item;
		}
	}
	return undefined;
}

/** End the in-flight response (if any): stop streaming and collapse its activity
 * box, optionally stamping a first-seen error. Shared by `agent_end` (clean end)
 * and `host_error` (fatal end). */
function closeActiveResponse(state: TranscriptState, error?: string): void {
	state.streaming = false;
	const group = activeResponse(state, false);
	if (group) {
		group.streaming = false;
		group.collapsed = true;
		// Collapse every activity box now that the run has ended.
		for (const segment of group.segments) if (segment.kind === "activity") segment.collapsed = true;
		if (error) group.error = group.error ?? error;
	}
}

function partialResultText(payload: unknown): string | undefined {
	if (typeof payload === "string") return payload;
	if (payload && typeof payload === "object") {
		const content = (payload as { content?: unknown }).content;
		if (content !== undefined) return contentToText(content);
	}
	return undefined;
}

/** Fold a `suggest_next` tool result into `state.suggestion`, reading the
 * command and (optional) recap out of the result's `details`. The `details`
 * cross the RPC boundary intact (the generic RPC output serializes the whole
 * event), so this is where the `summary` — absent from the lean `suggest_next`
 * event — becomes available to the webview. Defensive throughout: a missing or
 * oddly-shaped `details` simply contributes nothing and never throws. Merges,
 * so a command already set by the `suggest_next` event is preserved. */
function captureSuggestionFromToolResult(state: TranscriptState, result: unknown): void {
	const details = result && typeof result === "object" ? (result as { details?: unknown }).details : undefined;
	if (!details || typeof details !== "object") return;
	const d = details as { suggestion?: unknown; summary?: unknown };
	const command =
		typeof d.suggestion === "string" && d.suggestion.trim().length > 0 ? d.suggestion : state.suggestion?.command;
	const summary = typeof d.summary === "string" && d.summary.trim().length > 0 ? d.summary : state.suggestion?.summary;
	if (command) state.suggestion = { command, summary };
}

function providerErrorText(message: {
	role?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
}): string | undefined {
	if (message?.role !== "assistant" || message.stopReason !== "error") return undefined;
	return typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0
		? message.errorMessage
		: "Unknown error";
}

function uiRequestFromEvent(event: any): UiRequest | undefined {
	const method = event?.method as string | undefined;
	const id = String(event.id);
	const options = Array.isArray(event.options) ? event.options.map((o: unknown) => String(o)) : undefined;
	if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
		return {
			id,
			method,
			title: String(event.title ?? ""),
			message: typeof event.message === "string" ? event.message : undefined,
			options,
			placeholder: typeof event.placeholder === "string" ? event.placeholder : undefined,
			prefill: typeof event.prefill === "string" ? event.prefill : undefined,
		};
	}
	if (method === "ask") {
		const rawQuestions = Array.isArray(event.questions) ? event.questions : undefined;
		const questions: AskQuestion[] = rawQuestions
			? rawQuestions.map((q: any) => normalizeAskQuestion(q))
			: // Defensive fallback for a legacy single flat-question event shape so an
				// older RPC child still renders one question rather than an empty widget.
				[normalizeAskQuestion(event)];
		return {
			id,
			method: "ask",
			title: String(event.title ?? "Question"),
			questions,
			expiresAt: typeof event.expiresAt === "number" ? event.expiresAt : undefined,
		};
	}
	return undefined;
}

/** Coerce an untrusted RPC ask-question payload into a typed {@link AskQuestion}. */
function normalizeAskQuestion(q: any): AskQuestion {
	return {
		question: typeof q?.question === "string" ? q.question : "",
		title: typeof q?.title === "string" ? q.title : undefined,
		options: Array.isArray(q?.options) ? q.options.map((o: unknown) => String(o)) : undefined,
		allowFreeText: typeof q?.allowFreeText === "boolean" ? q.allowFreeText : undefined,
		multiSelect: typeof q?.multiSelect === "boolean" ? q.multiSelect : undefined,
		multiline: typeof q?.multiline === "boolean" ? q.multiline : undefined,
	};
}

/** Apply one session event (or synthetic host event) to the transcript state. */
export function applyEvent(state: TranscriptState, event: any): void {
	switch (event?.type) {
		case "agent_start": {
			state.streaming = true;
			state.statusText = undefined;
			// A new run resolves any prior blocking UI requests server-side.
			state.uiRequests = [];
			// The previous turn's next-step suggestion is stale once a new run
			// begins — clear it so it never lingers into the next turn.
			state.suggestion = undefined;
			break;
		}
		case "agent_end": {
			closeActiveResponse(state);
			break;
		}
		case "background_agent_start": {
			// A background subagent began running for this session. Track its id so
			// the sidebar can show "working in background" once the main turn ends.
			const agentId = event.agentId !== undefined ? String(event.agentId) : undefined;
			if (agentId && !state.backgroundAgentIds.includes(agentId)) {
				state.backgroundAgentIds.push(agentId);
			}
			break;
		}
		case "background_agent_end": {
			// A background subagent finished (success/failure/cancel all clear it).
			const agentId = event.agentId !== undefined ? String(event.agentId) : undefined;
			if (agentId) state.backgroundAgentIds = state.backgroundAgentIds.filter((id) => id !== agentId);
			break;
		}
		case "message_start": {
			const message = event.message as { role?: string; content?: unknown } | undefined;
			if (message?.role === "user") {
				state.items.push({ kind: "user", text: contentToText(message.content) });
				// A user message opens a new exchange — any pending suggestion from
				// the previous turn is now stale.
				state.suggestion = undefined;
			} else if (message?.role === "assistant") {
				state.sawTextDeltaInBlock = false;
				activeResponse(state, true);
			}
			break;
		}
		case "message_update": {
			const stream = event.assistantMessageEvent as { type: string; delta?: string; content?: string } | undefined;
			if (!stream) break;
			const group = activeResponse(state, true);
			if (!group) break;
			switch (stream.type) {
				case "text_delta":
					state.sawTextDeltaInBlock = true;
					appendAnswerText(group, stream.delta ?? "");
					break;
				case "text_end":
					// text_end carries the authoritative block content; streaming
					// providers already delivered it via deltas, but a non-streaming
					// provider emits only text_end per block. Adopt whenever no delta
					// was seen for this block — not just when the answer is empty —
					// so later blocks of a multi-block non-streaming reply aren't
					// silently dropped.
					if (typeof stream.content === "string" && !state.sawTextDeltaInBlock)
						appendAnswerText(group, stream.content);
					state.sawTextDeltaInBlock = false;
					break;
				case "thinking_start":
					pushActivity(group, { kind: "thinking", text: "" });
					break;
				case "thinking_delta": {
					const thinking = lastThinking(group);
					if (thinking) thinking.text += stream.delta ?? "";
					else pushActivity(group, { kind: "thinking", text: stream.delta ?? "" });
					break;
				}
				case "thinking_end": {
					const thinking = lastThinking(group);
					if (thinking && typeof stream.content === "string") thinking.text = stream.content;
					break;
				}
				default:
					// text_start / toolcall_* — tools are tracked via tool_execution_* below.
					break;
			}
			break;
		}
		case "message_end": {
			const message = event.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
			if (message) {
				const error = providerErrorText(message);
				if (error) {
					const group = activeResponse(state, true);
					if (group) group.error = error;
				}
				// Mark interrupted turns so a truncated answer isn't mistaken for a
				// complete one (mirrors the fold path, so a rebuilt transcript renders
				// identically to the live one).
				if (message.role === "assistant" && message.stopReason === "aborted") {
					const group = activeResponse(state, true);
					if (group) group.aborted = true;
				}
			}
			break;
		}
		case "tool_execution_start": {
			const group = activeResponse(state, true);
			if (!group) break;
			const toolCallId = String(event.toolCallId);
			const existing = findTool(group, toolCallId);
			if (existing) {
				existing.toolName = String(event.toolName);
				existing.args = event.args;
				existing.status = "running";
				existing.resultText = "";
			} else {
				pushActivity(group, {
					kind: "tool",
					toolCallId,
					toolName: String(event.toolName),
					args: event.args,
					status: "running",
					resultText: "",
				});
			}
			break;
		}
		case "tool_execution_update": {
			const group = activeResponse(state, false);
			const tool = group ? findTool(group, String(event.toolCallId)) : undefined;
			if (tool) {
				const text = partialResultText(event.partialResult);
				if (text !== undefined) tool.resultText = text;
			}
			break;
		}
		case "tool_execution_end": {
			const group = activeResponse(state, false);
			const tool = group ? findTool(group, String(event.toolCallId)) : undefined;
			if (tool) {
				tool.status = event.isError ? "error" : "done";
				const text = partialResultText(event.result);
				if (text !== undefined) tool.resultText = text;
			}
			// The next-step suggestion's recap (`summary`) rides the tool result's
			// `details`, not the lean `suggest_next` event — fold it in here.
			if (event.toolName === "suggest_next" && !event.isError) {
				captureSuggestionFromToolResult(state, event.result);
			}
			break;
		}
		case "extension_ui_request": {
			const request = uiRequestFromEvent(event);
			if (request) {
				// Replace any stale request with the same id, then append.
				state.uiRequests = state.uiRequests.filter((r) => r.id !== request.id);
				state.uiRequests.push(request);
			} else if (event.method === "setStatus") {
				state.statusText = typeof event.statusText === "string" ? event.statusText : undefined;
			}
			break;
		}
		case "extension_ui_response_handled": {
			state.uiRequests = state.uiRequests.filter((r) => r.id !== String(event.id));
			break;
		}
		case "auto_compaction_start": {
			state.statusText = "compacting context…";
			break;
		}
		case "auto_compaction_end": {
			if (state.statusText === "compacting context…") state.statusText = undefined;
			break;
		}
		case "auto_retry_start": {
			state.statusText = `retrying (${event.attempt}/${event.maxAttempts})…`;
			break;
		}
		case "auto_retry_end": {
			state.statusText = undefined;
			break;
		}
		case "host_error": {
			// Synthetic event emitted by the SessionController on RPC child exit.
			state.hostError = String(event.message ?? "dreb process exited");
			closeActiveResponse(state, state.hostError);
			break;
		}
		case "host_notice": {
			// Synthetic event for host-side, non-fatal feedback (e.g. an unwired
			// builtin or an unknown command).
			state.statusText = String(event.message ?? "");
			break;
		}
		case "suggest_next": {
			// The agent's end-of-turn next-step command. The recap (`summary`) is
			// folded in separately from the tool result (see tool_execution_end);
			// preserve it if it arrived first (event ordering is not guaranteed).
			const command = typeof event.command === "string" ? event.command.trim() : "";
			if (command) state.suggestion = { command, summary: state.suggestion?.summary };
			break;
		}
		case "host_system": {
			// Synthetic event for host-side output that should persist in the
			// transcript (e.g. `/session` stats), not a transient status line.
			state.items.push({ kind: "system", text: String(event.text ?? "") });
			break;
		}
		case "host_recovery": {
			// Synthetic event emitted by the SessionController after a successful
			// auto-recovery from an unexpected RPC child crash. Persistent transcript
			// item: the conversation was rebuilt from disk but the in-flight reply was
			// never persisted, so it's gone and the session is now idle. `canRetry`
			// gates the one-click Retry (resends the retained last prompt).
			const message = String(event.message ?? "");
			const trimmedCause = typeof event.cause === "string" ? event.cause.trim() : "";
			const text = trimmedCause ? `${message} Cause: ${trimmedCause}.` : message;
			state.items.push({ kind: "recovery", text, canRetry: event.canRetry === true });
			break;
		}
		default:
			break;
	}
}

/** One-line summary of a set of activity items for a box's collapsed header. */
export function activityItemsSummary(items: readonly ActivityItem[]): string {
	const toolCount = items.filter((a) => a.kind === "tool").length;
	const thoughtCount = items.filter((a) => a.kind === "thinking").length;
	const parts: string[] = [];
	if (thoughtCount > 0) parts.push(`${thoughtCount} thought${thoughtCount === 1 ? "" : "s"}`);
	if (toolCount > 0) parts.push(`${toolCount} tool call${toolCount === 1 ? "" : "s"}`);
	return parts.length > 0 ? parts.join(" · ") : "no activity";
}

/**
 * The id of the response group eligible for a **Retry** control, or `undefined`
 * when none is. Only the *most recent* turn qualifies, and only when it ended in
 * a provider error (`error` set) and is no longer streaming — so a stale errored
 * turn buried above later successful turns never offers a misleading resend, and
 * an in-flight turn never offers one while it may still succeed. Kept pure and
 * dependency-free so both the webview (to render the button) and unit tests can
 * use it. Retrying a fatal host error (dead RPC child) is out of scope — that
 * path surfaces its own reopen banner, so when `hostError` is set (e.g. crash
 * recovery gave up and stamped the active group's `error`) no Retry is offered:
 * the child is gone and a resend would only hit the disconnected guard.
 */
export function retryableResponseId(state: TranscriptState): number | undefined {
	if (state.hostError) return undefined;
	const last = state.items[state.items.length - 1];
	if (last && last.kind === "response" && !last.streaming && last.error) return last.id;
	return undefined;
}

/**
 * Minimal structural view of a persisted provider message (from the `get_messages`
 * RPC). Typed structurally on purpose — this module must not import
 * `@dreb/coding-agent`, so message/content shapes are duck-typed by field.
 */
interface RebuildMessage {
	role?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

/** Fold one assistant message's content parts into a response group: text parts
 * accumulate into the clean answer; `thinking` parts and `toolCall` parts become
 * activity items (tools start "running" until their `toolResult` message resolves
 * them). Mirrors the live event projection so a rebuilt run renders identically. */
function foldAssistantContent(group: ResponseGroup, content: unknown): void {
	if (typeof content === "string") {
		appendAnswerText(group, content);
		return;
	}
	if (!Array.isArray(content)) return;
	for (const raw of content) {
		const part = raw as {
			type?: string;
			text?: unknown;
			thinking?: unknown;
			id?: unknown;
			name?: unknown;
			arguments?: unknown;
		};
		if (part?.type === "text" && typeof part.text === "string") {
			appendAnswerText(group, part.text);
		} else if (part?.type === "thinking" && typeof part.thinking === "string") {
			pushActivity(group, { kind: "thinking", text: part.thinking });
		} else if (part?.type === "toolCall") {
			pushActivity(group, {
				kind: "tool",
				toolCallId: String(part.id ?? ""),
				toolName: String(part.name ?? "tool"),
				args: part.arguments,
				status: "running",
				resultText: "",
			});
		}
	}
}

/**
 * Replace `state`'s transcript in place with the full conversation rebuilt from a
 * branch's provider messages (Phase 6 — after a restore/fork moved the leaf, or a
 * resume that never replayed live events). Mutates the state's properties, not the
 * reference, so a holder of the state object (the host's snapshot source) stays
 * valid.
 *
 * Unlike the retired preview-based rebuild, this reconstructs the same
 * {@link ResponseGroup} model the live event stream produces: one group per agent
 * *run* (a run is delimited by user messages; consecutive assistant + toolResult
 * messages fold into the open group), with full answer markdown plus a collapsible
 * activity box of thinking and tool calls. Tool results are paired back to their
 * `toolCall` by id. A provider-error turn stamps the group's `error`; aborted/empty
 * turns simply produce an empty group rather than a fake placeholder. The result is
 * a restored/forked/resumed chat that renders identically to a fresh live chat.
 */
export function foldMessagesIntoState(state: TranscriptState, messages: readonly unknown[]): void {
	state.items = [];
	state.streaming = false;
	state.uiRequests = [];
	state.statusText = undefined;
	state.hostError = undefined;
	state.nextResponseId = 1;
	state.sawTextDeltaInBlock = false;

	// The open response group for the current run, or undefined between runs (i.e.
	// right after a user turn, before the next assistant message reopens one).
	let group: ResponseGroup | undefined;
	const openGroup = (): ResponseGroup => {
		if (group) return group;
		const created: ResponseGroup = {
			kind: "response",
			id: state.nextResponseId++,
			segments: [],
			answer: "",
			streaming: false,
			collapsed: true,
		};
		state.items.push(created);
		group = created;
		return created;
	};

	for (const raw of messages) {
		const message = raw as RebuildMessage;
		const role = message?.role;
		if (role === "user") {
			state.items.push({ kind: "user", text: contentToText(message.content) });
			group = undefined; // a user turn closes the current run
		} else if (role === "assistant") {
			const active = openGroup();
			foldAssistantContent(active, message.content);
			if (message.stopReason === "error") {
				const text =
					typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0
						? message.errorMessage
						: "Unknown error";
				active.error = active.error ?? text;
			}
			// Interrupted turns (user-cancelled, or recovered after a child crash)
			// keep their persisted marker so the rebuilt transcript renders the same
			// "interrupted" cue the live projection shows.
			if (message.stopReason === "aborted") active.aborted = true;
		} else if (role === "toolResult") {
			// Attach the result to its pending tool item in the open run's activity.
			const tool = group ? findTool(group, String(message.toolCallId)) : undefined;
			if (tool) {
				tool.status = message.isError ? "error" : "done";
				tool.resultText = contentToText(message.content);
			}
		}
		// Other/unknown roles (defensive): ignored — they never render a turn.
	}

	// Rebuilt turns are all historical/complete, so collapse every activity box —
	// matching the live projection, where `agent_end` collapses them.
	for (const item of state.items) {
		if (item.kind !== "response") continue;
		for (const segment of item.segments) if (segment.kind === "activity") segment.collapsed = true;
	}
}

/**
 * Align session entry ids to the transcript's completed response groups, keyed by
 * the stable {@link ResponseGroup.id}. There is exactly one id per completed group:
 * the **run-terminal** assistant entry (the last assistant message of that run —
 * see `currentBranch` in the session controller), so a tool-using turn that
 * persists several assistant entries still maps to a single control on its one
 * response group. Aligns from the most recent turn backward so the leaf stays
 * anchored on a length mismatch (unmatched older groups simply get no control
 * rather than a wrong one). The latest aligned checkpoint gets `canRestore: false`
 * (restoring to where you already are is a no-op); every earlier one gets
 * `canRestore: true`.
 *
 * Only actively-streaming groups are excluded: the in-flight turn's run-terminal
 * entry has not been persisted yet, so it has no id in `entryIds`. Errored/aborted
 * groups are deliberately KEPT — such a turn is still persisted to the session
 * (and therefore present as a run-terminal entry), so dropping it here would desync
 * the two sequences and shift every older checkpoint onto the wrong entry id.
 *
 * `forkableEntryIds` is the set of entry ids the backend will actually fork from
 * (from the `get_fork_messages` RPC); a checkpoint whose entry id is absent gets
 * `canFork: false` so the Fork control is hidden rather than shown as a no-op
 * that only surfaces a "Couldn't fork…" notice on click.
 */
export function alignCheckpoints(
	state: TranscriptState,
	entryIds: string[],
	forkableEntryIds: ReadonlySet<string>,
): Checkpoint[] {
	const groups = state.items.filter((item): item is ResponseGroup => item.kind === "response" && !item.streaming);
	const pairs = Math.min(groups.length, entryIds.length);
	const checkpoints: Checkpoint[] = [];
	for (let k = 0; k < pairs; k++) {
		const group = groups[groups.length - 1 - k];
		const entryId = entryIds[entryIds.length - 1 - k];
		// k === 0 is the most recent turn → no restore.
		checkpoints.push({ responseId: group.id, entryId, canRestore: k !== 0, canFork: forkableEntryIds.has(entryId) });
	}
	return checkpoints.reverse();
}
