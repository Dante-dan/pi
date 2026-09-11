import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearExtensionCache, loadExtensions, loadExtensionsCached } from "../../../src/core/extensions/loader.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";

interface TestState {
	moduleLoads?: number;
	factoryRuns?: number;
	entryLoads?: number;
	helperLoads?: number;
	dependencyLoads?: number;
}

function state(): TestState {
	const global = globalThis as typeof globalThis & { __extensionFactoryCacheTest?: TestState };
	if (!global.__extensionFactoryCacheTest) {
		global.__extensionFactoryCacheTest = {};
	}
	return global.__extensionFactoryCacheTest;
}

function resetState(): void {
	delete (globalThis as typeof globalThis & { __extensionFactoryCacheTest?: TestState }).__extensionFactoryCacheTest;
}

function writeCountingExtension(filePath: string): void {
	writeFileSync(
		filePath,
		`
const state = (globalThis.__extensionFactoryCacheTest ??= {});
state.moduleLoads = (state.moduleLoads ?? 0) + 1;

export default function () {
	state.factoryRuns = (state.factoryRuns ?? 0) + 1;
}
`,
		"utf-8",
	);
}

function writeSideEffectDependency(directory: string): void {
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({ name: "side-effect-dependency", type: "module", main: "index.js" }),
		"utf-8",
	);
	writeFileSync(
		join(directory, "index.js"),
		`
const state = (globalThis.__extensionFactoryCacheTest ??= {});
state.dependencyLoads = (state.dependencyLoads ?? 0) + 1;
export const dependencyLoads = state.dependencyLoads;
`,
		"utf-8",
	);
}

function writeReloadableExtension(extensionDir: string, dependencySpecifier: string): string {
	mkdirSync(join(extensionDir, "src"), { recursive: true });
	writeFileSync(
		join(extensionDir, "src", "helper.ts"),
		`
const state = (globalThis.__extensionFactoryCacheTest ??= {});
state.helperLoads = (state.helperLoads ?? 0) + 1;
export const helperLoads = state.helperLoads;
`,
		"utf-8",
	);
	const extensionPath = join(extensionDir, "src", "index.ts");
	writeFileSync(
		extensionPath,
		`
import { dependencyLoads } from ${JSON.stringify(dependencySpecifier)};
import { helperLoads } from "./helper.ts";

const state = (globalThis.__extensionFactoryCacheTest ??= {});
state.entryLoads = (state.entryLoads ?? 0) + 1;

export default function () {
	state.factoryRuns = (state.factoryRuns ?? 0) + 1;
	void dependencyLoads;
	void helperLoads;
}
`,
		"utf-8",
	);
	return extensionPath;
}

describe("extension factory cache", () => {
	const roots: string[] = [];

	function fixture(name: string) {
		const root = join(tmpdir(), `pi-extension-cache-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		roots.push(root);
		return { root, cwd, agentDir };
	}

	beforeEach(() => {
		resetState();
		clearExtensionCache();
	});

	afterEach(() => {
		while (roots.length > 0) {
			const root = roots.pop();
			if (root && existsSync(root)) {
				rmSync(root, { recursive: true, force: true });
			}
		}
		resetState();
		clearExtensionCache();
	});

	it("caches extension modules for cached same-cwd loads but reruns factories", async () => {
		const { root, cwd } = fixture("same-cwd");
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath);

		const first = await loadExtensionsCached([extensionPath], cwd);
		const second = await loadExtensionsCached([extensionPath], cwd);

		expect(state().moduleLoads).toBe(1);
		expect(state().factoryRuns).toBe(2);
		expect(first.extensions[0]).not.toBe(second.extensions[0]);
		expect(first.runtime).not.toBe(second.runtime);
	});

	it("does not cache direct loadExtensions calls", async () => {
		const { root, cwd } = fixture("direct");
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath);

		await loadExtensions([extensionPath], cwd);
		await loadExtensions([extensionPath], cwd);

		expect(state().moduleLoads).toBe(2);
		expect(state().factoryRuns).toBe(2);
	});

	it("clears the cache on resource loader reload", async () => {
		const { cwd, agentDir } = fixture("reload");
		const extensionDir = join(agentDir, "extensions");
		mkdirSync(extensionDir, { recursive: true });
		writeCountingExtension(join(extensionDir, "counting.ts"));
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});

		await loader.reload();
		await loader.reload();

		expect(state().moduleLoads).toBe(2);
		expect(state().factoryRuns).toBe(2);
	});

	// Regression test for https://github.com/earendil-works/pi/issues/6108
	it("reloads extension-owned modules without re-evaluating nested dependencies", async () => {
		const { root, cwd } = fixture("nested-dependency");
		const extensionDir = join(root, "extension");
		mkdirSync(extensionDir, { recursive: true });
		writeFileSync(
			join(extensionDir, "package.json"),
			JSON.stringify({ pi: { extensions: ["src/index.ts"] } }),
			"utf-8",
		);
		writeSideEffectDependency(join(extensionDir, "node_modules", "side-effect-dependency"));
		const extensionPath = writeReloadableExtension(extensionDir, "side-effect-dependency");

		await loadExtensionsCached([extensionPath], cwd);
		clearExtensionCache();
		await loadExtensionsCached([extensionPath], cwd);

		expect(state().entryLoads).toBe(2);
		expect(state().helperLoads).toBe(2);
		expect(state().dependencyLoads).toBe(1);
		expect(state().factoryRuns).toBe(2);
	});

	// Regression test for https://github.com/earendil-works/pi/issues/6108
	it("preserves a hoisted scoped dependency for a scoped package extension", async () => {
		const { root, cwd } = fixture("hoisted-scoped-dependency");
		const extensionDir = join(root, "node_modules", "@plannotator", "pi-extension");
		mkdirSync(extensionDir, { recursive: true });
		writeFileSync(
			join(extensionDir, "package.json"),
			JSON.stringify({ pi: { extensions: ["src/index.ts"] } }),
			"utf-8",
		);
		writeSideEffectDependency(join(root, "node_modules", "@pierre", "diffs"));
		const extensionPath = writeReloadableExtension(extensionDir, "@pierre/diffs");

		await loadExtensionsCached([extensionPath], cwd);
		clearExtensionCache();
		await loadExtensionsCached([extensionPath], cwd);

		expect(state().entryLoads).toBe(2);
		expect(state().helperLoads).toBe(2);
		expect(state().dependencyLoads).toBe(1);
		expect(state().factoryRuns).toBe(2);
	});

	it("keeps the cache scoped to one cwd", async () => {
		const { root } = fixture("cross-cwd");
		const firstCwd = join(root, "first");
		const secondCwd = join(root, "second");
		mkdirSync(firstCwd, { recursive: true });
		mkdirSync(secondCwd, { recursive: true });
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath);

		await loadExtensionsCached([extensionPath], firstCwd);
		await loadExtensionsCached([extensionPath], secondCwd);
		await loadExtensionsCached([extensionPath], secondCwd);

		expect(state().moduleLoads).toBe(2);
		expect(state().factoryRuns).toBe(3);
	});
});
