import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { formatContextUsage, formatCost, formatModel, formatThinking } from "../shared/format.js";
import { activeMention, isFullPickerTrigger, replaceMention } from "../shared/mention.js";
import {
	activitySummary,
	applyEvent,
	type Checkpoint,
	createTranscriptState,
	type ResponseGroup,
	type ToolActivity,
	type TranscriptState,
	type UiRequest,
} from "../shared/projection.js";
import type {
	FileContextDto,
	HostStatus,
	OpenSourceRef,
	ReviewStateDto,
	SessionTreeDto,
	SessionTreeNodeDto,
	SlashCommandDto,
	TaggedContextDto,
	UiResponse,
} from "../shared/protocol.js";
import { taggedContextLabel, taggedContextTitle } from "../shared/tagged-context.js";
import { buildGroundedRefs, linkifyAnswer } from "./code-links.js";
import { renderMarkdown } from "./markdown.js";
import { onHostMessage, postToHost } from "./vscode-api.js";

export function App() {
	const [state, setState] = createStore<TranscriptState>(createTranscriptState());
	const [commands, setCommands] = createSignal<SlashCommandDto[]>([]);
	const [status, setStatus] = createSignal<HostStatus>({ connected: false, cwd: "" });
	// Optimistic pre-hydration default so a git repo doesn't briefly flash the
	// "unavailable" notice before the first review message arrives; the host
	// publishes the authoritative enabled/files state on connect and on reload.
	const [review, setReview] = createSignal<ReviewStateDto>({ enabled: true, files: [] });
	// Editor selections tagged into the chat (Phase 4), shown as removable chips
	// above the composer and folded into the next submitted message.
	const [attachments, setAttachments] = createSignal<TaggedContextDto[]>([]);
	// Inline restore/fork controls (Phase 6), aligned to response groups by id.
	const [checkpoints, setCheckpoints] = createSignal<Checkpoint[]>([]);
	const checkpointByResponse = createMemo(() => new Map(checkpoints().map((c) => [c.responseId, c])));
	// The session branch tree, shown as an overlay when the user opens it.
	const [tree, setTree] = createSignal<SessionTreeDto | undefined>();
	// A composer pre-fill request (a user-message fork's re-ask text). Bumped
	// `nonce` retriggers the effect even when the text repeats.
	const [prefill, setPrefill] = createSignal<{ text: string; nonce: number }>();
	// Inline `@`-mention file search (Phase 4c): results for the composer's
	// typeahead dropdown, plus a monotonic request id so out-of-order host
	// responses are dropped (only the latest query's results are shown).
	const [fileResults, setFileResults] = createSignal<FileContextDto[]>([]);
	let fileSearchId = 0;
	const searchFiles = (query: string) => {
		fileSearchId += 1;
		postToHost({ type: "search-files", query, requestId: fileSearchId });
	};
	const [tick, setTick] = createSignal(0);

	let scrollEl: HTMLDivElement | undefined;
	const scrollToBottom = () => {
		if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
	};

	onMount(() => {
		const off = onHostMessage((msg) => {
			switch (msg.type) {
				case "snapshot":
					setState(reconcile(msg.state));
					setCommands(msg.commands);
					setStatus(msg.status);
					break;
				case "event":
					setState(produce((s) => applyEvent(s, msg.event)));
					break;
				case "commands":
					setCommands(msg.commands);
					break;
				case "status":
					setStatus(msg.status);
					break;
				case "review":
					setReview(msg.review);
					break;
				case "tag-context":
					setAttachments((current) => [...current, msg.context]);
					break;
				case "checkpoints":
					setCheckpoints(msg.checkpoints);
					break;
				case "tree":
					setTree(msg.tree);
					break;
				case "composer-prefill":
					setPrefill((prev) => ({ text: msg.text, nonce: (prev?.nonce ?? 0) + 1 }));
					break;
				case "file-results":
					// Drop stale (out-of-order) responses: only the latest query's
					// results are shown in the typeahead dropdown.
					if (msg.requestId === fileSearchId) setFileResults(msg.results);
					break;
			}
			setTick((t) => t + 1);
		});
		postToHost({ type: "ready" });
		onCleanup(off);
	});

	// Keep the transcript pinned to the latest output on any update.
	createEffect(() => {
		tick();
		queueMicrotask(scrollToBottom);
	});

	const respondUi = (response: UiResponse) => postToHost({ type: "ui-response", response });

	return (
		<div class="dreb-app">
			<header class="dreb-header">
				<span class="dreb-title">dreb</span>
				<span class="dreb-cwd" title={status().cwd}>
					{shortPath(status().cwd)}
				</span>
				<button
					type="button"
					class="dreb-chip"
					title="Change model"
					disabled={!status().connected}
					onClick={() => postToHost({ type: "pick-model" })}
				>
					{formatModel(status().model)}
				</button>
				<button
					type="button"
					class="dreb-chip"
					title="Change thinking level"
					disabled={!status().connected}
					onClick={() => postToHost({ type: "pick-thinking" })}
				>
					think: {formatThinking(status().thinkingLevel)}
				</button>
				<Show when={formatCost(status().cost)}>
					{(cost) => (
						<span class="dreb-chip-static" title="cost">
							{cost()}
						</span>
					)}
				</Show>
				<Show when={formatContextUsage(status().contextUsage)}>
					{(ctx) => (
						<span class="dreb-chip-static" title="context usage">
							{ctx()}
						</span>
					)}
				</Show>
				<button
					type="button"
					class="dreb-chip"
					title="Session tree — restore or fork any point"
					disabled={!status().connected}
					onClick={() => postToHost({ type: "show-tree" })}
				>
					⑃ tree
				</button>
				<span class={`dreb-dot ${status().connected ? "ok" : "off"}`} />
			</header>

			<Show when={state.hostError}>
				<div class="dreb-banner error">{state.hostError}</div>
			</Show>

			<Show when={review().files.length > 0 || !review().enabled}>
				<Show
					when={review().enabled}
					fallback={
						<div class="dreb-review-bar dreb-review-unavailable">
							<span class="dreb-review-title">
								Change review unavailable — open a folder that is a Git repository to review and revert agent
								edits.
							</span>
						</div>
					}
				>
					<div class="dreb-review-bar">
						<span class="dreb-review-title">
							{review().files.length} change{review().files.length === 1 ? "" : "s"} pending review
						</span>
						<button
							type="button"
							class="dreb-review-accept-all"
							title="Accept all pending edits — clears them from change review (no commit)"
							onClick={() => postToHost({ type: "review-accept-all" })}
						>
							Accept all
						</button>
						<For each={review().files}>
							{(file) => (
								<button
									type="button"
									class="dreb-review-file"
									title={`${file.status}${file.hunkCount > 0 ? ` · ${file.hunkCount} hunk${file.hunkCount === 1 ? "" : "s"}` : ""} — open diff`}
									onClick={() => postToHost({ type: "review-open-diff", path: file.path })}
								>
									{shortPath(file.path)}
								</button>
							)}
						</For>
					</div>
				</Show>
			</Show>

			<div class="dreb-transcript" ref={scrollEl}>
				<For each={state.items}>
					{(item) =>
						item.kind === "user" ? (
							<div class="dreb-user">{item.text}</div>
						) : item.kind === "system" ? (
							<pre class="dreb-system">{item.text}</pre>
						) : (
							<>
								<ResponseView group={item} />
								<Show when={checkpointByResponse().get(item.id)}>
									{(checkpoint) => <CheckpointBar checkpoint={checkpoint()} />}
								</Show>
							</>
						)
					}
				</For>

				<For each={state.uiRequests}>{(request) => <UiRequestView request={request} onRespond={respondUi} />}</For>

				<Show when={state.statusText}>
					<div class="dreb-status-line">{state.statusText}</div>
				</Show>
			</div>

			<Show when={tree()}>
				{(current) => (
					<TreePanel
						tree={current()}
						onNavigate={(entryId) => {
							postToHost({ type: "navigate-tree", entryId });
							setTree(undefined);
						}}
						onClose={() => setTree(undefined)}
					/>
				)}
			</Show>

			<Composer
				streaming={state.streaming}
				commands={commands()}
				attachments={attachments()}
				prefill={prefill()}
				fileResults={fileResults()}
				onRemoveAttachment={(index) => setAttachments((current) => current.filter((_, i) => i !== index))}
				onSubmit={(text) => {
					postToHost({ type: "submit", text, attachments: attachments() });
					setAttachments([]);
				}}
				onAbort={() => postToHost({ type: "abort" })}
				onPickFile={() => postToHost({ type: "pick-file" })}
				onSearchFiles={searchFiles}
				onTagFile={(context) => setAttachments((current) => [...current, context])}
			/>
		</div>
	);
}

export function ResponseView(props: { group: ResponseGroup }) {
	return (
		<div class="dreb-response">
			<Show when={props.group.activity.length > 0}>
				<ActivityBox group={props.group} />
			</Show>
			<Show when={props.group.answer.length > 0}>
				{/* Sanitized markdown with grounded, clickable code links. Links are
				    wired via event delegation (postToHost) rather than href navigation,
				    so they work under the webview's strict CSP. */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: delegates activation of the rendered-markdown <a> links (the anchors are the interactive elements) */}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: the links are keyboard-focusable anchors inside innerHTML; delegation only forwards their activation */}
				<div
					class="dreb-answer"
					onClick={onCodeLinkClick}
					innerHTML={linkifyAnswer(renderMarkdown(props.group.answer), buildGroundedRefs(props.group.activity))}
				/>
			</Show>
			<Show when={props.group.error}>
				<div class="dreb-banner error">{props.group.error}</div>
			</Show>
		</div>
	);
}

/** Inline restore/fork controls rendered after a response (Phase 6), Copilot
 * style. "Restore Checkpoint" rewinds the conversation to this turn; "Fork"
 * branches a new line of conversation from it. Both post to the host, which
 * drives the RPC and rebuilds the transcript. */
export function CheckpointBar(props: { checkpoint: Checkpoint }) {
	return (
		<Show when={props.checkpoint.canRestore || props.checkpoint.canFork}>
			<div class="dreb-checkpoint">
				<Show when={props.checkpoint.canRestore}>
					<button
						type="button"
						class="dreb-checkpoint-btn"
						title="Restore the conversation to this point"
						onClick={() => postToHost({ type: "navigate-tree", entryId: props.checkpoint.entryId })}
					>
						Restore Checkpoint
					</button>
				</Show>
				<Show when={props.checkpoint.canRestore && props.checkpoint.canFork}>
					<span class="dreb-checkpoint-sep">·</span>
				</Show>
				<Show when={props.checkpoint.canFork}>
					<button
						type="button"
						class="dreb-checkpoint-btn dreb-checkpoint-fork"
						title="Fork a new branch from here"
						onClick={() => postToHost({ type: "fork", entryId: props.checkpoint.entryId })}
					>
						⑃ Fork
					</button>
				</Show>
			</div>
		</Show>
	);
}

interface TreeRow {
	node: SessionTreeNodeDto;
	depth: number;
}

/** Flatten the session tree to indented rows, keeping only message turns
 * (user/assistant) so the branch view stays readable. Oldest-first. */
function flattenTree(nodes: SessionTreeNodeDto[], depth = 0, out: TreeRow[] = []): TreeRow[] {
	for (const node of nodes) {
		const isTurn = node.type === "message" && (node.role === "user" || node.role === "assistant");
		if (isTurn) out.push({ node, depth });
		flattenTree(node.children, isTurn ? depth + 1 : depth, out);
	}
	return out;
}

/** The branch-tree overlay (Phase 6): jump to any turn on any branch, so forked
 * or rewound branches stay reachable. The current leaf is marked and disabled. */
export function TreePanel(props: { tree: SessionTreeDto; onNavigate: (entryId: string) => void; onClose: () => void }) {
	const rows = createMemo(() => flattenTree(props.tree.roots));
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: click-away backdrop; the panel itself stops propagation
		// biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismissal mirrors the escape affordance below
		<div class="dreb-tree-overlay" onClick={props.onClose}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: stops backdrop dismissal from firing inside the panel */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: non-interactive container; interactive children handle keys */}
			<div class="dreb-tree-panel" onClick={(event) => event.stopPropagation()}>
				<div class="dreb-tree-head">
					<span class="dreb-tree-title">Session tree</span>
					<button type="button" class="dreb-tree-close" title="Close" onClick={props.onClose}>
						×
					</button>
				</div>
				<div class="dreb-tree-body">
					<Show
						when={rows().length > 0}
						fallback={<div class="dreb-tree-empty">No turns yet — send a message to start the tree.</div>}
					>
						<For each={rows()}>
							{(row) => (
								<button
									type="button"
									class="dreb-tree-node"
									style={{ "padding-left": `${8 + row.depth * 16}px` }}
									disabled={row.node.id === props.tree.leafId}
									title={`${row.node.role ?? row.node.type} · ${row.node.id.slice(0, 8)}`}
									onClick={() => props.onNavigate(row.node.id)}
								>
									<span class="dreb-tree-role">{row.node.role === "assistant" ? "assistant" : "you"}</span>
									<span class="dreb-tree-preview">{row.node.label ?? row.node.preview}</span>
									<Show when={row.node.id === props.tree.leafId}>
										<span class="dreb-tree-current">current</span>
									</Show>
								</button>
							)}
						</For>
					</Show>
				</div>
			</div>
		</div>
	);
}

function ActivityBox(props: { group: ResponseGroup }) {
	const [open, setOpen] = createSignal(true);
	// Auto-collapse once the run finishes; the user can reopen freely afterward.
	let autoCollapsed = false;
	createEffect(() => {
		if (props.group.collapsed && !autoCollapsed) {
			autoCollapsed = true;
			setOpen(false);
		}
	});
	const summary = createMemo(() => activitySummary(props.group));

	return (
		<div class="dreb-activity">
			<button type="button" class="dreb-activity-head" onClick={() => setOpen(!open())}>
				<span class="dreb-caret">{open() ? "▾" : "▸"}</span>
				<Show when={props.group.streaming} fallback={<span class="dreb-activity-label">Worked · {summary()}</span>}>
					<span class="dreb-activity-label">
						<span class="dreb-spinner" /> Working · {summary()}
					</span>
				</Show>
			</button>
			<Show when={open()}>
				<div class="dreb-activity-body">
					<For each={props.group.activity}>
						{(item) =>
							item.kind === "thinking" ? <div class="dreb-thinking">{item.text}</div> : <ToolCard tool={item} />
						}
					</For>
				</div>
			</Show>
		</div>
	);
}

function ToolCard(props: { tool: ToolActivity }) {
	return (
		<div class={`dreb-tool ${props.tool.status}`}>
			<div class="dreb-tool-head">
				<span class="dreb-tool-name">{props.tool.toolName}</span>
				<span class="dreb-tool-status">{props.tool.status}</span>
			</div>
			<Show when={argPreview(props.tool.args)}>{(preview) => <div class="dreb-tool-args">{preview()}</div>}</Show>
			<Show when={props.tool.resultText}>
				<pre class="dreb-tool-result">{clip(props.tool.resultText, 4000)}</pre>
			</Show>
		</div>
	);
}

function UiRequestView(props: { request: UiRequest; onRespond: (response: UiResponse) => void }) {
	const request = props.request;
	const cancel = () => props.onRespond({ id: request.id, cancelled: true });

	return (
		<div class="dreb-uireq">
			<div class="dreb-uireq-title">{request.title}</div>
			<Show when={request.message}>
				<div class="dreb-uireq-message">{request.message}</div>
			</Show>

			<Show when={request.method === "confirm"}>
				<div class="dreb-uireq-actions">
					<button type="button" onClick={() => props.onRespond({ id: request.id, confirmed: true })}>
						Yes
					</button>
					<button type="button" onClick={() => props.onRespond({ id: request.id, confirmed: false })}>
						No
					</button>
					<button type="button" class="ghost" onClick={cancel}>
						Cancel
					</button>
				</div>
			</Show>

			<Show when={request.method === "select"}>
				<div class="dreb-uireq-actions column">
					<For each={request.options ?? []}>
						{(option) => (
							<button type="button" onClick={() => props.onRespond({ id: request.id, value: option })}>
								{option}
							</button>
						)}
					</For>
					<button type="button" class="ghost" onClick={cancel}>
						Cancel
					</button>
				</div>
			</Show>

			<Show when={request.method === "input" || request.method === "editor"}>
				<TextResponse
					multiline={request.method === "editor"}
					placeholder={request.placeholder}
					prefill={request.prefill}
					onSubmit={(value) => props.onRespond({ id: request.id, value })}
					onCancel={cancel}
				/>
			</Show>

			<Show when={request.method === "ask"}>
				<AskResponse request={request} onRespond={props.onRespond} onCancel={cancel} />
			</Show>
		</div>
	);
}

function TextResponse(props: {
	multiline?: boolean;
	placeholder?: string;
	prefill?: string;
	onSubmit: (value: string) => void;
	onCancel: () => void;
}) {
	const [value, setValue] = createSignal(props.prefill ?? "");
	return (
		<div class="dreb-uireq-actions column">
			<Show
				when={props.multiline}
				fallback={
					<input
						type="text"
						placeholder={props.placeholder}
						value={value()}
						onInput={(e) => setValue(e.currentTarget.value)}
					/>
				}
			>
				<textarea
					rows={6}
					placeholder={props.placeholder}
					value={value()}
					onInput={(e) => setValue(e.currentTarget.value)}
				/>
			</Show>
			<div class="dreb-uireq-actions">
				<button type="button" onClick={() => props.onSubmit(value())}>
					Submit
				</button>
				<button type="button" class="ghost" onClick={props.onCancel}>
					Cancel
				</button>
			</div>
		</div>
	);
}

function AskResponse(props: { request: UiRequest; onRespond: (response: UiResponse) => void; onCancel: () => void }) {
	const request = props.request;
	const [selected, setSelected] = createSignal<string[]>([]);
	const [customText, setCustomText] = createSignal("");
	const allowFreeText = request.allowFreeText !== false;

	const toggle = (option: string) => {
		if (request.multiSelect) {
			setSelected((prev) => (prev.includes(option) ? prev.filter((o) => o !== option) : [...prev, option]));
		} else {
			setSelected([option]);
		}
	};

	const submit = () => {
		const text = customText().trim();
		props.onRespond({
			id: request.id,
			selected: selected(),
			customText: text.length > 0 ? text : undefined,
		});
	};

	return (
		<div class="dreb-uireq-actions column">
			<Show when={request.question}>
				<div class="dreb-uireq-message">{request.question}</div>
			</Show>
			<For each={request.options ?? []}>
				{(option) => (
					<label class="dreb-option">
						<input
							type={request.multiSelect ? "checkbox" : "radio"}
							name={`ask-${request.id}`}
							checked={selected().includes(option)}
							onChange={() => toggle(option)}
						/>
						<span>{option}</span>
					</label>
				)}
			</For>
			<Show when={allowFreeText}>
				<Show
					when={request.multiline}
					fallback={
						<input
							type="text"
							placeholder="Type your own answer…"
							value={customText()}
							onInput={(e) => setCustomText(e.currentTarget.value)}
						/>
					}
				>
					<textarea
						rows={4}
						placeholder="Type your own answer…"
						value={customText()}
						onInput={(e) => setCustomText(e.currentTarget.value)}
					/>
				</Show>
			</Show>
			<div class="dreb-uireq-actions">
				<button type="button" onClick={submit}>
					Send
				</button>
				<button type="button" class="ghost" onClick={props.onCancel}>
					Cancel
				</button>
			</div>
		</div>
	);
}

function Composer(props: {
	streaming: boolean;
	commands: SlashCommandDto[];
	attachments: TaggedContextDto[];
	prefill?: { text: string; nonce: number };
	fileResults: FileContextDto[];
	onRemoveAttachment: (index: number) => void;
	onSubmit: (text: string) => void;
	onAbort: () => void;
	onPickFile: () => void;
	onSearchFiles: (query: string) => void;
	onTagFile: (context: FileContextDto) => void;
}) {
	const [text, setText] = createSignal("");
	// Caret position, tracked so the `@`-mention parser knows which token the user
	// is editing (updated on input and on caret moves via keyboard/mouse).
	const [caret, setCaret] = createSignal(0);
	// Set true when the user dismisses the file dropdown (Escape); reset whenever
	// the mention token changes so a fresh `@` re-opens it.
	const [mentionClosed, setMentionClosed] = createSignal(false);
	let inputEl: HTMLTextAreaElement | undefined;
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	// Apply a host-driven pre-fill (a user-message fork's re-ask text). The
	// `nonce` makes the effect retrigger even when the same text is sent twice.
	createEffect(() => {
		const request = props.prefill;
		if (request) setText(request.text);
	});

	const menu = createMemo(() => {
		const value = text();
		if (!value.startsWith("/") || value.includes(" ") || value.includes("\n")) return [];
		const query = value.slice(1).toLowerCase();
		return props.commands.filter((c) => c.name.toLowerCase().startsWith(query)).slice(0, 8);
	});

	// The `@`-mention token the caret is editing, if any (drives the file
	// typeahead dropdown). Host results are already ranked + capped.
	const mention = createMemo(() => activeMention(text(), caret()));
	const fileMenuOpen = createMemo(() => mention() !== null && !mentionClosed() && props.fileResults.length > 0);

	const scheduleSearch = (query: string) => {
		if (searchTimer) clearTimeout(searchTimer);
		searchTimer = setTimeout(() => props.onSearchFiles(query), 120);
	};
	onCleanup(() => {
		if (searchTimer) clearTimeout(searchTimer);
	});

	// Composer input: handle `@@` escalation to the native picker, drive the
	// inline `@` typeahead, and otherwise just track the text + caret.
	const onInput = (el: HTMLTextAreaElement) => {
		const value = el.value;
		const pos = el.selectionStart ?? value.length;
		// `@@` (at the start of a token) opens the full native file/folder picker,
		// stripping the two `@` first (Phase 4b behavior, now the explicit trigger).
		if (isFullPickerTrigger(value, pos)) {
			const stripped = replaceMention(value, { start: pos - 2, end: pos }, "");
			setText(stripped.text);
			setCaret(stripped.caret);
			restoreCaret(stripped.caret);
			props.onPickFile();
			return;
		}
		setText(value);
		setCaret(pos);
		const token = activeMention(value, pos);
		if (token) {
			setMentionClosed(false);
			scheduleSearch(token.query);
		}
	};

	// Keep the caret signal in sync when the user moves the caret without typing
	// (arrow keys, clicking) so the mention parser stays accurate.
	const syncCaret = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length);

	const restoreCaret = (pos: number) => {
		queueMicrotask(() => {
			if (!inputEl) return;
			inputEl.focus();
			inputEl.setSelectionRange(pos, pos);
		});
	};

	// Select a file from the inline dropdown: strip the `@query` token and tag the
	// file as a composer chip (the host already built the workspace-relative DTO).
	const selectFile = (context: FileContextDto) => {
		const token = mention();
		if (!token) return;
		const stripped = replaceMention(text(), token, "");
		setText(stripped.text);
		setCaret(stripped.caret);
		props.onTagFile(context);
		restoreCaret(stripped.caret);
	};

	const submit = () => {
		const value = text();
		// Allow sending with only attachments (no typed text), but never a
		// completely empty message.
		if (value.trim().length === 0 && props.attachments.length === 0) return;
		props.onSubmit(value);
		setText("");
		setCaret(0);
	};

	const pick = (name: string) => setText(`/${name} `);

	const onKeyDown = (event: KeyboardEvent) => {
		// Escape closes the file typeahead without submitting or losing text.
		if (event.key === "Escape" && fileMenuOpen()) {
			event.preventDefault();
			setMentionClosed(true);
			return;
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<div class="dreb-composer">
			<Show when={menu().length > 0}>
				<div class="dreb-menu">
					<For each={menu()}>
						{(command) => (
							<button type="button" class="dreb-menu-item" onClick={() => pick(command.name)}>
								<span class="dreb-menu-name">/{command.name}</span>
								<Show when={command.description}>
									<span class="dreb-menu-desc">{command.description}</span>
								</Show>
							</button>
						)}
					</For>
				</div>
			</Show>
			<Show when={fileMenuOpen()}>
				<div class="dreb-menu">
					<For each={props.fileResults}>
						{(file) => (
							<button
								type="button"
								class="dreb-menu-item"
								title={taggedContextTitle(file)}
								onClick={() => selectFile(file)}
							>
								<span class="dreb-menu-name">@{taggedContextLabel(file)}</span>
								<span class="dreb-menu-desc">{file.path}</span>
							</button>
						)}
					</For>
				</div>
			</Show>
			<Show when={props.attachments.length > 0}>
				<div class="dreb-attachments">
					<For each={props.attachments}>
						{(attachment, index) => (
							<span class="dreb-attachment" title={taggedContextTitle(attachment)}>
								<span class="dreb-attachment-icon">{attachment.kind === "file" ? "@" : "{}"}</span>
								<span class="dreb-attachment-label">{taggedContextLabel(attachment)}</span>
								<button
									type="button"
									class="dreb-attachment-remove"
									title="Remove from chat"
									aria-label="Remove from chat"
									onClick={() => props.onRemoveAttachment(index())}
								>
									×
								</button>
							</span>
						)}
					</For>
				</div>
			</Show>
			<div class="dreb-composer-row">
				<textarea
					ref={inputEl}
					class="dreb-input"
					rows={2}
					placeholder="Message dreb…  (/ for commands, @ for files, @@ for picker)"
					value={text()}
					onInput={(e) => onInput(e.currentTarget)}
					onKeyDown={onKeyDown}
					onKeyUp={(e) => syncCaret(e.currentTarget)}
					onClick={(e) => syncCaret(e.currentTarget)}
				/>
				<Show
					when={props.streaming}
					fallback={
						<button type="button" class="dreb-send" onClick={submit}>
							Send
						</button>
					}
				>
					<button type="button" class="dreb-send stop" onClick={props.onAbort}>
						Stop
					</button>
				</Show>
			</div>
		</div>
	);
}

/** Delegated click handler on a rendered answer: intercept a clicked code link
 * and ask the host to open it. Uses event delegation (not `href`) so it works
 * under the webview's `default-src 'none'` CSP. */
function onCodeLinkClick(event: MouseEvent): void {
	const target = event.target as HTMLElement | null;
	const link = target?.closest?.("a.dreb-code-link") as HTMLElement | null;
	if (!link) return;
	event.preventDefault();
	const ref: OpenSourceRef = {};
	if (link.dataset.path) ref.path = link.dataset.path;
	if (link.dataset.line) ref.line = Number(link.dataset.line);
	if (link.dataset.column) ref.column = Number(link.dataset.column);
	if (link.dataset.symbol) ref.symbol = link.dataset.symbol;
	if (ref.path || ref.symbol) postToHost({ type: "open-source", ref });
}

function argPreview(args: unknown): string | undefined {
	if (args === undefined || args === null) return undefined;
	try {
		const text = typeof args === "string" ? args : JSON.stringify(args);
		return text.length > 0 ? clip(text, 200) : undefined;
	} catch {
		return undefined;
	}
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function shortPath(path: string): string {
	if (!path) return "";
	const parts = path.split(/[/\\]/).filter(Boolean);
	return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}
