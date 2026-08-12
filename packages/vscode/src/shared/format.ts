/**
 * Pure display formatters for the status header (model · thinking · cost · ctx).
 *
 * No DOM, no framework, no `@dreb/coding-agent` import — shared by the webview
 * and unit-tested in plain node. Centralizes the currency/percentage formatting
 * the dashboard inlines inconsistently (2/3/4 decimals across call sites) into a
 * single place so the extension renders cost the same way everywhere.
 */

import type { ContextUsageStatus, CostStatus, ModelStatus } from "./protocol.js";

/** Model label for the header chip. */
export function formatModel(model: ModelStatus | undefined): string {
	if (!model) return "—";
	return model.name && model.name.length > 0 ? model.name : model.id;
}

/** Thinking-level label for the header chip. */
export function formatThinking(level: string | undefined): string {
	return level && level.length > 0 ? level : "—";
}

/**
 * Cost summary string, mirroring the dashboard footer:
 * `$0.123` (+ ` (sub)` on a subscription) and, when a larger daily total is
 * known, `, today $1.23`. Returns undefined when there is nothing to show.
 */
export function formatCost(cost: CostStatus | undefined): string | undefined {
	if (!cost) return undefined;
	const session = cost.session ?? 0;
	if (session === 0 && !cost.usingSubscription && cost.daily === undefined) return undefined;
	let text = `$${session.toFixed(3)}${cost.usingSubscription ? " (sub)" : ""}`;
	if (cost.daily !== undefined && cost.daily > session) text += `, today $${cost.daily.toFixed(2)}`;
	return text;
}

/** Percentage label; `?` when the value is unknown (null). */
export function formatPercent(percent: number | null): string {
	return percent === null ? "?" : `${percent.toFixed(0)}%`;
}

/** Context-usage chip (`ctx 42%`); undefined when usage is unknown. */
export function formatContextUsage(usage: ContextUsageStatus | undefined): string | undefined {
	if (!usage) return undefined;
	return `ctx ${formatPercent(usage.percent)}`;
}

/** Minimal shape of the RPC `getSessionStats()` result the summary needs. */
export interface SessionStatsSummary {
	sessionId?: string;
	userMessages?: number;
	assistantMessages?: number;
	toolCalls?: number;
	totalMessages?: number;
	tokens?: { input?: number; output?: number; total?: number };
	cost?: number;
	contextUsage?: ContextUsageStatus;
}

/** Multi-line, human-readable session summary shown by `/session`. */
export function formatSessionStats(stats: SessionStatsSummary): string {
	const lines: string[] = ["Session stats"];
	if (stats.sessionId) lines.push(`  id: ${stats.sessionId}`);
	const msgs = stats.totalMessages ?? 0;
	lines.push(`  messages: ${msgs} (user ${stats.userMessages ?? 0}, assistant ${stats.assistantMessages ?? 0})`);
	if (stats.toolCalls !== undefined) lines.push(`  tool calls: ${stats.toolCalls}`);
	if (stats.tokens) {
		lines.push(
			`  tokens: ${stats.tokens.total ?? 0} (in ${stats.tokens.input ?? 0}, out ${stats.tokens.output ?? 0})`,
		);
	}
	if (stats.cost !== undefined) lines.push(`  cost: $${stats.cost.toFixed(4)}`);
	if (stats.contextUsage) lines.push(`  context: ${formatPercent(stats.contextUsage.percent)}`);
	return lines.join("\n");
}
