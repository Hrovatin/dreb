import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createSession(): AgentSession {
	const session = {
		state: {
			model: {
				id: "test-model",
				provider: "test",
				contextWindow: 200_000,
				reasoning: false,
			},
			thinkingLevel: "off",
		},
		sessionManager: {
			getEntries: () => [],
			getSessionName: () => "",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		modelRegistry: {
			isUsingOAuth: () => false,
		},
		getPerformanceTracker: () => ({
			getRollingAverage: () => ({ median: 0, mean: 0, count: 0 }),
			getPerformanceDelta: () => ({
				baselineMedian: 0,
				recentMedian: 0,
				percentDelta: 0,
				direction: "stable",
				baselineCount: 0,
				recentCount: 0,
			}),
		}),
	};

	return session as unknown as AgentSession;
}

function createFooterData(): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 1,
		getDailyCost: () => 0,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("FooterComponent ASK indicator", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("shows ASK in the stats line when ask mode is enabled", () => {
		const footer = new FooterComponent(createSession(), createFooterData());
		footer.setAskModeEnabled(true);

		const statsLine = footer.render(120)[1];
		expect(statsLine).toContain("ASK");
	});

	it("does not show ASK when ask mode is disabled (default)", () => {
		const footer = new FooterComponent(createSession(), createFooterData());

		const statsLine = footer.render(120)[1];
		expect(statsLine).not.toContain("ASK");
	});

	it("toggling ask mode off removes the ASK indicator", () => {
		const footer = new FooterComponent(createSession(), createFooterData());
		footer.setAskModeEnabled(true);
		expect(footer.render(120)[1]).toContain("ASK");

		footer.setAskModeEnabled(false);
		expect(footer.render(120)[1]).not.toContain("ASK");
	});
});
