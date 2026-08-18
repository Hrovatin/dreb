/**
 * Process-level crash guards for the RPC server child.
 *
 * The RPC child runs the whole agent loop in a separate process, streaming
 * events to the parent (VSCode extension host / dashboard server) over stdout.
 * Historically it installed no `unhandledRejection`/`uncaughtException`
 * handlers, so *any* stray unhandled rejection anywhere in the agent loop (a
 * provider/network error, an abort race, an un-awaited async tool path) would
 * terminate the process with exit code 1 — surfacing to the user as an abrupt
 * "dreb process exited (code 1, signal null)" with no explanation and no
 * recovery. See issue 53.
 *
 * These guards convert that into a diagnosable, recoverable failure:
 *
 *  - **unhandledRejection** — registering a listener suppresses Node's default
 *    "throw-and-exit" behavior (Node >= 15). We log the reason and emit a
 *    non-fatal diagnostic frame, then **keep the process alive**. A stray
 *    rejection rarely corrupts state, and killing a long-lived session for one
 *    is worse than continuing. This is the common case and is fully recovered.
 *
 *  - **uncaughtException** — an uncaught throw can leave process state corrupt;
 *    Node's own guidance is to perform synchronous cleanup and shut down rather
 *    than resume. We log + emit a fatal diagnostic and then **deliberately exit
 *    (code 1)** so the parent's supervised restart (VSCode auto-recovery /
 *    dashboard retry) rebuilds a fresh child — now with a logged cause instead
 *    of a mystery. This is a distinct, intentional exit and is *not* the
 *    unexplained crash issue 53 is about.
 *
 * The deliberate stdout-backpressure `process.exit(1)` in `output-guard.ts`
 * (fail-loud when the consumer stops reading) is a separate explicit exit and
 * is intentionally left untouched by these guards.
 */

/** The two process-level failure origins these guards intercept. */
export type RpcCrashOrigin = "unhandledRejection" | "uncaughtException";

/** A structured, serializable view of a crash reason. */
export interface RpcCrashDiagnostic {
	origin: RpcCrashOrigin;
	message: string;
	stack?: string;
	/** Fatal failures exit the process (for supervised restart); recoverable
	 * ones keep it alive. */
	fatal: boolean;
}

/** Side effects the guards need, injected so the core logic is unit-testable
 * without touching the real `process` or killing the test runner. */
export interface RpcCrashGuardHooks {
	/** Emit a diagnostic event frame to the parent over the RPC channel. */
	emit: (frame: object) => void;
	/** Write a diagnostic line to stderr (collected by the parent's RpcClient
	 * and surfaced on the next exit). */
	log: (line: string) => void;
	/** Terminate the process. Only invoked on the fatal (uncaughtException)
	 * path. Injected so tests can assert it without exiting. */
	exit: (code: number) => void;
}

/** Normalize an arbitrary thrown/rejected value into a structured diagnostic. */
export function formatRpcCrashDiagnostic(origin: RpcCrashOrigin, reason: unknown): RpcCrashDiagnostic {
	const fatal = origin === "uncaughtException";
	if (reason instanceof Error) {
		return { origin, message: reason.message || reason.name || "Error", stack: reason.stack, fatal };
	}
	return { origin, message: typeof reason === "string" ? reason : safeStringify(reason), fatal };
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/** The RPC event frame emitted for a crash diagnostic. Consumers that don't
 * recognize the type ignore it gracefully (the projection's `default` branch);
 * the primary durability guarantee is the accompanying stderr log. */
export function crashDiagnosticFrame(diagnostic: RpcCrashDiagnostic): {
	type: "rpc_process_error";
	origin: RpcCrashOrigin;
	message: string;
	fatal: boolean;
} {
	return {
		type: "rpc_process_error",
		origin: diagnostic.origin,
		message: diagnostic.message,
		fatal: diagnostic.fatal,
	};
}

/** Handle one crash event: log it, emit the diagnostic frame, and — for a fatal
 * origin — exit for supervised restart. Exposed for direct unit testing. */
export function handleRpcCrash(hooks: RpcCrashGuardHooks, origin: RpcCrashOrigin, reason: unknown): void {
	const diagnostic = formatRpcCrashDiagnostic(origin, reason);
	const suffix = diagnostic.stack ? `\n${diagnostic.stack}` : "";
	if (diagnostic.fatal) {
		hooks.log(`[rpc] Uncaught exception (fatal — exiting for supervised restart): ${diagnostic.message}${suffix}`);
	} else {
		hooks.log(`[rpc] Unhandled promise rejection (recovered — process kept alive): ${diagnostic.message}${suffix}`);
	}
	// Best-effort: emitting must never itself throw out of the guard.
	try {
		hooks.emit(crashDiagnosticFrame(diagnostic));
	} catch {
		// Ignore — the stderr log above is the durable record.
	}
	if (diagnostic.fatal) hooks.exit(1);
}

/**
 * Install the process-level crash guards. Returns a disposer that removes both
 * listeners (used by tests; the RPC server keeps them for its whole lifetime).
 */
export function installRpcCrashGuards(hooks: RpcCrashGuardHooks): () => void {
	const onRejection = (reason: unknown): void => handleRpcCrash(hooks, "unhandledRejection", reason);
	const onException = (err: unknown): void => handleRpcCrash(hooks, "uncaughtException", err);
	process.on("unhandledRejection", onRejection);
	process.on("uncaughtException", onException);
	return () => {
		process.off("unhandledRejection", onRejection);
		process.off("uncaughtException", onException);
	};
}
