import type { Model, Provider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	ModelRegistry,
	ModelRegistryCredentialSynchronizationError,
	type ProviderConfigInput,
} from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const customModel: NonNullable<ProviderConfigInput["models"]>[number] = {
	id: "setup-model",
	name: "Setup Model",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 16_000,
	maxTokens: 4_000,
};

describe("ModelRegistry credential operations", () => {
	// Regression for https://github.com/earendil-works/pi/issues/7658
	it("persists and removes API keys through provider-owned auth", async () => {
		const credentials = AuthStorage.inMemory();
		const registry = await createInMemoryModelRegistry(credentials);
		registry.registerProvider("setup-provider", {
			baseUrl: "https://api.example.test/v1",
			api: "openai-completions",
			models: [customModel],
		});

		await registry.loginApiKey("setup-provider", {
			prompt: async (prompt) => {
				expect(prompt).toEqual({ type: "secret", message: "Enter API key" });
				return "setup-secret";
			},
			notify: () => {},
		});

		expect(await credentials.read("setup-provider")).toEqual({ type: "api_key", key: "setup-secret" });
		expect(registry.getProviderAuthStatus("setup-provider")).toMatchObject({ configured: true, source: "stored" });
		expect(registry.getAvailable().map((model) => model.id)).toContain("setup-model");

		await registry.logout("setup-provider");

		expect(await credentials.read("setup-provider")).toBeUndefined();
		expect(registry.getProviderAuthStatus("setup-provider").configured).toBe(false);
		expect(registry.getAvailable().some((model) => model.provider === "setup-provider")).toBe(false);
	});

	it("reports a committed login without exposing the credential", async () => {
		const credentials = AuthStorage.inMemory();
		let failSynchronization = false;
		const model: Model<"openai-completions"> = {
			...customModel,
			provider: "broken-sync",
			api: "openai-completions",
			baseUrl: "https://api.example.test/v1",
		};
		const provider: Provider<"openai-completions"> = {
			id: "broken-sync",
			name: "Broken Sync",
			auth: {
				apiKey: {
					name: "API key",
					login: async (interaction) => ({
						type: "api_key",
						key: await interaction.prompt({ type: "secret", message: "API key" }),
					}),
					check: async ({ credential }) =>
						credential ? { type: "api_key", source: "stored credential" } : undefined,
					resolve: async ({ credential }) =>
						credential ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined,
				},
			},
			getModels: () => [model],
			refreshModels: async () => {
				if (failSynchronization) throw new Error("cache restore failed");
			},
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		};
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		runtime.registerNativeProvider(provider);
		await runtime.refresh({ allowNetwork: false, providers: [provider.id] });
		const registry = new ModelRegistry(runtime);
		failSynchronization = true;

		const loginError = await registry
			.loginApiKey(provider.id, {
				prompt: async () => "must-not-leak",
				notify: () => {},
			})
			.catch((error: unknown) => error);

		expect(loginError).toMatchObject({
			name: "ModelRegistryCredentialSynchronizationError",
			providerId: provider.id,
			operation: "login",
			credentialCommitted: true,
		});
		expect(loginError).toBeInstanceOf(ModelRegistryCredentialSynchronizationError);
		expect(loginError).not.toHaveProperty("credential");
		expect(loginError).not.toHaveProperty("cause");
		expect(String(loginError)).not.toContain("must-not-leak");
		expect(await credentials.read(provider.id)).toEqual({ type: "api_key", key: "must-not-leak" });

		const logout = registry.logout(provider.id);
		await expect(logout).rejects.toMatchObject({
			name: "ModelRegistryCredentialSynchronizationError",
			providerId: provider.id,
			operation: "logout",
			credentialCommitted: true,
		});
		await expect(logout).rejects.not.toHaveProperty("credential");
		await expect(credentials.read(provider.id)).resolves.toBeUndefined();
	});
});
