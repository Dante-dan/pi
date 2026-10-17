import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { findInitialModel } from "../src/core/model-resolver.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

// #10623: a stale extension catalog must not silently replace a configured default.
describe("default model fallback diagnostics", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function createRuntime() {
		const dir = mkdtempSync(join(tmpdir(), "pi-default-fallback-"));
		dirs.push(dir);
		const runtime = getModelRuntime(await createModelRegistry(AuthStorage.inMemory(), join(dir, "models.json")));
		const base = getModel("anthropic", "claude-sonnet-4-5")!;
		runtime.registerProvider("stale", {
			baseUrl: "https://example.invalid",
			apiKey: "test-key",
			api: base.api,
			models: [{ ...base, id: "model-a", name: "Model A" }],
		});
		await runtime.refresh({ allowNetwork: false });
		return { dir, runtime };
	}

	it("names the missing saved default and the actual replacement through the SDK", async () => {
		const { dir, runtime } = await createRuntime();
		const settingsManager = SettingsManager.create(dir, dir);
		settingsManager.setDefaultModelAndProvider("stale", "model-b");
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			modelRuntime: runtime,
			settingsManager,
			sessionManager: SessionManager.inMemory(dir),
			resourceLoader: createTestResourceLoader(),
		});
		try {
			expect(session.model).toMatchObject({ provider: "stale", id: "model-a" });
			expect(modelFallbackMessage).toBe(
				"Could not use default model stale/model-b (model not found in catalog). Using stale/model-a.",
			);
		} finally {
			session.dispose();
		}
	});

	it("does not warn when the saved default resolves", async () => {
		const { runtime } = await createRuntime();
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "stale",
			defaultModelId: "model-a",
			modelRuntime: runtime,
		});
		expect(result.model).toMatchObject({ provider: "stale", id: "model-a" });
		expect(result.fallbackMessage).toBeUndefined();
	});
});
