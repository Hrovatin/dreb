export function extensionsDir(opts?: { home?: string; insiders?: boolean; override?: string }): string;

export function linkName(pkg: { publisher?: string; name: string }): string;

export function installPlan(opts: {
	extDir: string;
	pkg: { publisher?: string; name: string };
	target: string;
}): { linkPath: string; targetPath: string };

export function parseArgs(argv: string[]): { insiders: boolean; dir: string | undefined };

export function removeExisting(linkPath: string, log?: (msg: string) => void): void;

export function isSymlink(p: string): boolean;

export function safeReadlink(p: string): string | undefined;

export function isDirectRun(importMetaUrl: string, argv1?: string): boolean;

export interface RunInstallDeps {
	pkgRoot: string;
	pkg: { publisher?: string; name: string };
	extDir: string;
	fileExists?: (path: string) => boolean;
	makeDir?: (dir: string) => void;
	isLink?: (path: string) => boolean;
	readLink?: (path: string) => string | undefined;
	createSymlink?: (target: string, link: string) => void;
	remove?: (linkPath: string, log?: (msg: string) => void) => void;
	log?: (msg: string) => void;
	error?: (msg: string) => void;
	exit?: (code: number) => void;
}

export type RunInstallResult =
	| { ok: false; reason: "missing-build"; missing: string[] }
	| { ok: true; reason: "already-linked" | "linked"; linkPath: string; targetPath: string };

export function runInstall(deps: RunInstallDeps): RunInstallResult;
