import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { formatContextUsage, formatCost, formatModel, formatThinking } from "../shared/format.js";
import {
	activitySummary,
	applyEvent,
	createTranscriptState,
	type ResponseGroup,
	type ToolActivity,
	type TranscriptState,
	type UiRequest,
} from "../shared/projection.js";
import type { HostStatus, ReviewStateDto, SlashCommandDto, UiResponse } from "../shared/protocol.js";
import { renderMarkdown } from "./markdown.js";
import { onHostMessage, postToHost } from "./vscode-api.js";

export function App() {
	const [state, setState] = createStore<TranscriptState>(createTranscriptState());
	const [commands, setCommands] = createSignal<SlashCommandDto[]>([]);
	const [status, setStatus] = createSignal<HostStatus>({ connected: false, cwd: "" });
	const [review, setReview] = createSignal<ReviewStateDto>({ enabled: false, files: [] });
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
				<span class={`dreb-dot ${status().connected ? "ok" : "off"}`} />
			</header>

			<Show when={state.hostError}>
				<div class="dreb-banner error">{state.hostError}</div>
			</Show>

			<Show when={review().files.length > 0}>
				<div class="dreb-review-bar">
					<span class="dreb-review-title">
						{review().files.length} change{review().files.length === 1 ? "" : "s"} pending review
					</span>
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

			<div class="dreb-transcript" ref={scrollEl}>
				<For each={state.items}>
					{(item) =>
						item.kind === "user" ? (
							<div class="dreb-user">{item.text}</div>
						) : item.kind === "system" ? (
							<pre class="dreb-system">{item.text}</pre>
						) : (
							<ResponseView group={item} />
						)
					}
				</For>

				<For each={state.uiRequests}>{(request) => <UiRequestView request={request} onRespond={respondUi} />}</For>

				<Show when={state.statusText}>
					<div class="dreb-status-line">{state.statusText}</div>
				</Show>
			</div>

			<Composer
				streaming={state.streaming}
				commands={commands()}
				onSubmit={(text) => postToHost({ type: "submit", text })}
				onAbort={() => postToHost({ type: "abort" })}
			/>
		</div>
	);
}

function ResponseView(props: { group: ResponseGroup }) {
	return (
		<div class="dreb-response">
			<Show when={props.group.activity.length > 0}>
				<ActivityBox group={props.group} />
			</Show>
			<Show when={props.group.answer.length > 0}>
				{/* Sanitized markdown — see renderMarkdown. */}
				<div class="dreb-answer" innerHTML={renderMarkdown(props.group.answer)} />
			</Show>
			<Show when={props.group.error}>
				<div class="dreb-banner error">{props.group.error}</div>
			</Show>
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
	onSubmit: (text: string) => void;
	onAbort: () => void;
}) {
	const [text, setText] = createSignal("");

	const menu = createMemo(() => {
		const value = text();
		if (!value.startsWith("/") || value.includes(" ") || value.includes("\n")) return [];
		const query = value.slice(1).toLowerCase();
		return props.commands.filter((c) => c.name.toLowerCase().startsWith(query)).slice(0, 8);
	});

	const submit = () => {
		const value = text();
		if (value.trim().length === 0) return;
		props.onSubmit(value);
		setText("");
	};

	const pick = (name: string) => setText(`/${name} `);

	const onKeyDown = (event: KeyboardEvent) => {
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
			<div class="dreb-composer-row">
				<textarea
					class="dreb-input"
					rows={2}
					placeholder="Message dreb…  (/ for commands)"
					value={text()}
					onInput={(e) => setText(e.currentTarget.value)}
					onKeyDown={onKeyDown}
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
