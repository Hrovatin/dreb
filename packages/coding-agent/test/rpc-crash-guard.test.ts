import { describe, expect, it } from "vitest";
import {
	crashDiagnosticFrame,
	formatRpcCrashDiagnostic,
	handleRpcCrash,
	installRpcCrashGuards,
	type RpcCrashGuardHooks,
} from "../src/modes/rpc/rpc-crash-guard.js";

// ---------------------------------------------------------------------------
// formatRpcCrashDiagnostic
// ---------------------------------------------------------------------------

describe("formatRpcCrashDiagnostic", () => {
	it("formats an Error rejection as non-fatal", () => {
		const d = formatRpcCrashDiagnostic("unhandledRejection", new Error("boom"));
		expect(d.origin).toBe("unhandledRejection");
		expect(d.message).toBe("boom");
		expect(d.stack).toContain("boom");
		expect(d.fatal).toBe(false);
	});

	it("formats an Error exception as fatal", () => {
		const d = formatRpcCrashDiagnostic("uncaughtException", new Error("crash"));
		expect(d.origin).toBe("uncaughtException");
		expect(d.message).toBe("crash");
		expect(d.fatal).toBe(true);
	});

	it("formats a string reason", () => {
		const d = formatRpcCrashDiagnostic("unhandledRejection", "string reason");
		expect(d.message).toBe("string reason");
		expect(d.stack).toBeUndefined();
	});

	it("formats an object reason via JSON.stringify", () => {
		const d = formatRpcCrashDiagnostic("unhandledRejection", { code: 42 });
		expect(d.message).toBe('{"code":42}');
	});

	it("formats undefined/null reason", () => {
		expect(formatRpcCrashDiagnostic("unhandledRejection", undefined).message).toBe("undefined");
		expect(formatRpcCrashDiagnostic("unhandledRejection", null).message).toBe("null");
	});

	it("falls back to Error.name when message is empty", () => {
		const e = new TypeError("");
		const d = formatRpcCrashDiagnostic("uncaughtException", e);
		expect(d.message).toBe("TypeError");
	});
});

// ---------------------------------------------------------------------------
// crashDiagnosticFrame
// ---------------------------------------------------------------------------

describe("crashDiagnosticFrame", () => {
	it("produces the expected shape", () => {
		const d = formatRpcCrashDiagnostic("unhandledRejection", new Error("x"));
		const frame = crashDiagnosticFrame(d);
		expect(frame).toEqual({
			type: "rpc_process_error",
			origin: "unhandledRejection",
			message: "x",
			fatal: false,
		});
	});
});

// ---------------------------------------------------------------------------
// handleRpcCrash
// ---------------------------------------------------------------------------

function makeHooks(): RpcCrashGuardHooks & {
	emitted: object[];
	logged: string[];
	exited: number[];
} {
	return {
		emitted: [],
		logged: [],
		exited: [],
		emit(frame: object) {
			this.emitted.push(frame);
		},
		log(line: string) {
			this.logged.push(line);
		},
		exit(code: number) {
			this.exited.push(code);
		},
	};
}

describe("handleRpcCrash", () => {
	it("logs and emits a non-fatal rejection without exiting", () => {
		const hooks = makeHooks();
		handleRpcCrash(hooks, "unhandledRejection", new Error("net timeout"));
		expect(hooks.logged).toHaveLength(1);
		expect(hooks.logged[0]).toContain("recovered");
		expect(hooks.logged[0]).toContain("net timeout");
		expect(hooks.emitted).toHaveLength(1);
		expect((hooks.emitted[0] as any).type).toBe("rpc_process_error");
		expect((hooks.emitted[0] as any).fatal).toBe(false);
		expect(hooks.exited).toHaveLength(0);
	});

	it("logs, emits, and exits on a fatal uncaught exception", () => {
		const hooks = makeHooks();
		handleRpcCrash(hooks, "uncaughtException", new Error("segfault"));
		expect(hooks.logged).toHaveLength(1);
		expect(hooks.logged[0]).toContain("fatal");
		expect(hooks.emitted).toHaveLength(1);
		expect((hooks.emitted[0] as any).fatal).toBe(true);
		expect(hooks.exited).toEqual([1]);
	});

	it("still exits even if emit throws", () => {
		const hooks = makeHooks();
		hooks.emit = () => {
			throw new Error("pipe broken");
		};
		handleRpcCrash(hooks, "uncaughtException", new Error("bad"));
		// The log was still written and exit was still called.
		expect(hooks.logged).toHaveLength(1);
		expect(hooks.exited).toEqual([1]);
	});
});

// ---------------------------------------------------------------------------
// installRpcCrashGuards
// ---------------------------------------------------------------------------

describe("installRpcCrashGuards", () => {
	it("registers and removes process listeners", () => {
		const hooks = makeHooks();
		const before = process.listenerCount("unhandledRejection");
		const dispose = installRpcCrashGuards(hooks);
		expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
		expect(process.listenerCount("uncaughtException")).toBeGreaterThan(0);
		dispose();
		expect(process.listenerCount("unhandledRejection")).toBe(before);
	});
});
