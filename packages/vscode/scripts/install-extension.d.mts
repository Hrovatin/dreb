export function extensionsDir(opts?: { home?: string; insiders?: boolean; override?: string }): string;

export function linkName(pkg: { publisher?: string; name: string }): string;

export function installPlan(opts: {
	extDir: string;
	pkg: { publisher?: string; name: string };
	target: string;
}): { linkPath: string; targetPath: string };

export function parseArgs(argv: string[]): { insiders: boolean; dir: string | undefined };

export function removeExisting(linkPath: string, log?: (msg: string) => void): void;
