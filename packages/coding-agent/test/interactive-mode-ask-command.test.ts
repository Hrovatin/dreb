import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

/**
 * Unit tests for InteractiveMode.handleAskCommand — the `/ask [on|off|status]`
 * dispatch (bare `/ask` toggles). Uses the `fakeThis` prototype-call pattern (see
 * interactive-mode-status.test.ts) so the method is exercised without building
 * the full TUI.
 */
function makeFakeThis(initial: boolean) {
	const state = { askModeEnabled: initial };
	const warnings: string[] = [];
	const footer = {
		setAskModeEnabled: vi.fn(),
		invalidate: vi.fn(),
	};
	const session = {
		get askModeEnabled() {
			return state.askModeEnabled;
		},
		setAskMode: vi.fn((enable: boolean) => {
			state.askModeEnabled = enable;
			return enable;
		}),
	};
	const fakeThis = {
		session,
		footer,
		showWarning: (message: string) => warnings.push(message),
	};
	return { fakeThis, session, footer, warnings, state };
}

function dispatch(fakeThis: unknown, arg: string): void {
	(
		InteractiveMode as unknown as { prototype: { handleAskCommand: (arg: string) => void } }
	).prototype.handleAskCommand.call(fakeThis, arg);
}

describe("InteractiveMode.handleAskCommand", () => {
	it("turns Ask mode ON and updates the footer", () => {
		const { fakeThis, session, footer, warnings, state } = makeFakeThis(false);
		dispatch(fakeThis, "on");
		expect(session.setAskMode).toHaveBeenCalledWith(true);
		expect(state.askModeEnabled).toBe(true);
		expect(footer.setAskModeEnabled).toHaveBeenCalledWith(true);
		expect(footer.invalidate).toHaveBeenCalled();
		expect(warnings.join("\n")).toContain("Ask mode ON");
	});

	it("turns Ask mode OFF and restores tools", () => {
		const { fakeThis, session, footer, warnings, state } = makeFakeThis(true);
		dispatch(fakeThis, "off");
		expect(session.setAskMode).toHaveBeenCalledWith(false);
		expect(state.askModeEnabled).toBe(false);
		expect(footer.setAskModeEnabled).toHaveBeenCalledWith(false);
		expect(warnings.join("\n")).toContain("Ask mode OFF");
	});

	it("bare /ask toggles the current state", () => {
		// Starting ON → bare /ask turns it OFF.
		const off = makeFakeThis(true);
		dispatch(off.fakeThis, "");
		expect(off.session.setAskMode).toHaveBeenCalledWith(false);
		expect(off.state.askModeEnabled).toBe(false);
		expect(off.footer.setAskModeEnabled).toHaveBeenCalledWith(false);
		expect(off.warnings.join("\n")).toContain("Ask mode OFF");

		// Starting OFF → bare /ask turns it ON.
		const on = makeFakeThis(false);
		dispatch(on.fakeThis, "");
		expect(on.session.setAskMode).toHaveBeenCalledWith(true);
		expect(on.state.askModeEnabled).toBe(true);
		expect(on.footer.setAskModeEnabled).toHaveBeenCalledWith(true);
		expect(on.warnings.join("\n")).toContain("Ask mode ON");
	});

	it("/ask status reports state without changing it", () => {
		const { fakeThis, session, warnings } = makeFakeThis(true);
		dispatch(fakeThis, "status");
		expect(session.setAskMode).not.toHaveBeenCalled();
		expect(warnings.join("\n")).toContain("currently ON");
	});

	it("is a no-op when already in the requested state", () => {
		const { fakeThis, session, footer, warnings } = makeFakeThis(true);
		dispatch(fakeThis, "on");
		expect(session.setAskMode).not.toHaveBeenCalled();
		expect(footer.setAskModeEnabled).not.toHaveBeenCalled();
		expect(warnings.join("\n")).toContain("already ON");
	});

	it("shows usage on an unrecognized argument", () => {
		const { fakeThis, session, warnings } = makeFakeThis(false);
		dispatch(fakeThis, "maybe");
		expect(session.setAskMode).not.toHaveBeenCalled();
		expect(warnings.join("\n")).toContain("Usage: /ask [on | off | status]");
	});
});
