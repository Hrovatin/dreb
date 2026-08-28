import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(__dirname, "../../../scripts/verify-deps.js");
const tempDirs: string[] = [];

type PackageJson = Record<string, unknown>;

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempProject(rootPackage: PackageJson): string {
	const dir = mkdtempSync(join(tmpdir(), "verify-deps-"));
	tempDirs.push(dir);
	mkdirSync(join(dir, "packages"), { recursive: true });
	writeJson(join(dir, "package.json"), { workspaces: ["packages/*"], ...rootPackage });
	return dir;
}

function writeWorkspacePackage(projectDir: string, packageName: string, packageJson: PackageJson): void {
	const packageDir = join(projectDir, "packages", packageName);
	mkdirSync(packageDir, { recursive: true });
	writeJson(join(packageDir, "package.json"), packageJson);
}

/** Simulate an installed dependency by creating node_modules/<name>/package.json
 * under `baseDir` (the repo root for a hoisted install, or a workspace dir). */
function installDep(baseDir: string, name: string): void {
	const packageDir = join(baseDir, "node_modules", name);
	mkdirSync(packageDir, { recursive: true });
	writeJson(join(packageDir, "package.json"), { name, version: "1.0.0" });
}

function writeJson(path: string, value: PackageJson): void {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`, "utf-8");
}

function runVerifyDeps(cwd: string) {
	return spawnSync(process.execPath, [scriptPath], {
		cwd,
		encoding: "utf-8",
	});
}

describe("verify-deps script", () => {
	it("exits 0 when every declared dependency is installed", () => {
		const projectDir = createTempProject({ dependencies: { marked: "^1.0.0" } });
		writeWorkspacePackage(projectDir, "vscode", {
			dependencies: { katex: "^0.18.4" },
			devDependencies: { vitest: "^4.0.0" },
		});
		installDep(projectDir, "marked");
		installDep(projectDir, "katex");
		installDep(projectDir, "vitest");

		const result = runVerifyDeps(projectDir);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("All workspace dependencies are installed.");
		expect(result.stderr).toBe("");
	});

	it("exits 1 with an actionable message when a direct dependency is missing", () => {
		const projectDir = createTempProject({});
		writeWorkspacePackage(projectDir, "vscode", { dependencies: { katex: "^0.18.4" } });
		// katex intentionally not installed

		const result = runVerifyDeps(projectDir);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("dreb: dependencies not installed (missing: katex).");
		expect(result.stderr).toContain("Run `npm install` at the repo root, then retry.");
	});

	it("counts a type-only package (package.json but no entry point) as installed", () => {
		const projectDir = createTempProject({});
		writeWorkspacePackage(projectDir, "vscode", { devDependencies: { "@types/katex": "^0.16.8" } });
		installDep(projectDir, "@types/katex");

		const result = runVerifyDeps(projectDir);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("All workspace dependencies are installed.");
	});

	it("skips optionalDependencies and peerDependencies even when absent", () => {
		const projectDir = createTempProject({});
		writeWorkspacePackage(projectDir, "vscode", {
			optionalDependencies: { "@rollup/rollup-linux-x64-gnu": "^4.0.0" },
			peerDependencies: { react: "^19.0.0" },
		});
		// neither is installed

		const result = runVerifyDeps(projectDir);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("All workspace dependencies are installed.");
		expect(result.stderr).toBe("");
	});

	it("aggregates missing dependencies across multiple workspaces, sorted", () => {
		const projectDir = createTempProject({});
		writeWorkspacePackage(projectDir, "vscode", { dependencies: { katex: "^0.18.4" } });
		writeWorkspacePackage(projectDir, "ai", { dependencies: { "marked-katex-extension": "^5.0.0" } });

		const result = runVerifyDeps(projectDir);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("(missing: katex, marked-katex-extension).");
	});

	it("resolves a workspace dependency hoisted to the root node_modules", () => {
		const projectDir = createTempProject({});
		writeWorkspacePackage(projectDir, "vscode", { dependencies: { katex: "^0.18.4" } });
		// installed only at the repo root, not in the workspace's own node_modules
		installDep(projectDir, "katex");

		const result = runVerifyDeps(projectDir);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("All workspace dependencies are installed.");
	});

	it("also checks the root package's own dependencies", () => {
		const projectDir = createTempProject({ devDependencies: { husky: "^9.0.0" } });
		// husky intentionally not installed

		const result = runVerifyDeps(projectDir);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("(missing: husky).");
	});

	it("exits 1 with a diagnostic when a workspace package.json is invalid", () => {
		const projectDir = createTempProject({});
		const packageDir = join(projectDir, "packages", "broken");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(packageDir, "package.json"), "{ not json\n", "utf-8");

		const result = runVerifyDeps(projectDir);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("ERROR: failed to read or parse packages/broken/package.json");
		expect(result.stderr).toContain("Fix: correct the invalid JSON syntax in the reported file(s).");
	});
});
