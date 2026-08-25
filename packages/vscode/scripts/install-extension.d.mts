export function extensionsDir(opts?: { home?: string; insiders?: boolean; override?: string }): string;

export function linkName(pkg: { publisher?: string; name: string }): string;

export function installPlan(opts: {
	extDir: string;
	pkg: { publisher?: string; name: string };
	target: string;
}): { linkPath: string; targetPath: string };

export function manifestPath(extDir: string): string;

export interface ManifestEntry {
	identifier: { id: string };
	version: string;
	location: { $mid: number; fsPath: string; external: string; path: string; scheme: string };
	relativeLocation: string;
	metadata: { installedTimestamp: number; pinned: boolean; source: string };
}

export function readManifest(raw: string | undefined): ManifestEntry[];

export function parseManifest(raw: string | undefined): { entries: ManifestEntry[]; malformed: boolean };

export function buildManifestEntry(opts: {
	id: string;
	version?: string;
	linkPath: string;
	now?: number;
}): ManifestEntry;

export function sameId(a: unknown, b: unknown): boolean;

export function upsertEntry(entries: ManifestEntry[], entry: ManifestEntry): ManifestEntry[];

export function removeEntry(entries: ManifestEntry[], id: string): ManifestEntry[];

export function staleInstallNames(names: string[], name: string): string[];

export function safeReadFile(p: string): string | undefined;

export function safeReaddir(d: string): string[];

export function parseArgs(argv: string[]): { insiders: boolean; dir: string | undefined };

export function removeExisting(linkPath: string, log?: (msg: string) => void): void;

export function isSymlink(p: string): boolean;

export function safeReadlink(p: string): string | undefined;

export function isDirectRun(importMetaUrl: string, argv1?: string): boolean;

export interface RunInstallDeps {
	pkgRoot: string;
	pkg: { publisher?: string; name: string; version?: string };
	extDir: string;
	fileExists?: (path: string) => boolean;
	makeDir?: (dir: string) => void;
	isLink?: (path: string) => boolean;
	readLink?: (path: string) => string | undefined;
	createSymlink?: (target: string, link: string) => void;
	remove?: (linkPath: string, log?: (msg: string) => void) => void;
	readDir?: (dir: string) => string[];
	readManifestFile?: (path: string) => string | undefined;
	writeManifestFile?: (path: string, data: string) => void;
	now?: () => number;
	log?: (msg: string) => void;
	error?: (msg: string) => void;
	exit?: (code: number) => void;
}

export type RunInstallResult =
	| { ok: false; reason: "missing-build"; missing: string[] }
	| { ok: false; reason: "manifest-malformed"; linkPath: string; targetPath: string }
	| { ok: true; reason: "already-linked" | "linked"; linkPath: string; targetPath: string };

export function runInstall(deps: RunInstallDeps): RunInstallResult;

export interface RunUninstallDeps {
	extDir: string;
	pkg: { publisher?: string; name: string };
	isLink?: (path: string) => boolean;
	fileExists?: (path: string) => boolean;
	remove?: (linkPath: string, log?: (msg: string) => void) => void;
	readDir?: (dir: string) => string[];
	readManifestFile?: (path: string) => string | undefined;
	writeManifestFile?: (path: string, data: string) => void;
	log?: (msg: string) => void;
}

export type RunUninstallResult = { ok: true; reason: "nothing" | "removed" };

export function runUninstall(deps: RunUninstallDeps): RunUninstallResult;
