import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { openaiProvider } from "../src/providers/openai.ts";

afterEach(() => vi.unstubAllGlobals());

async function setup() {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openai", async () => ({
		type: "oauth",
		access: "account-a",
		refresh: "refresh-a",
		expires: Number.MAX_SAFE_INTEGER,
	}));
	const models = createModels({ credentials });
	models.setProvider(openaiProvider());
	return { models, credentials };
}

// Regression for #11021: ChatGPT OAuth limits differ from the API-key catalog.
describe("OpenAI account context limits", () => {
	it("overlays only the reported context window and updates synchronous lookup", async () => {
		const { models } = await setup();
		const baseline = models.getModel("openai", "gpt-6.1-sol")!;
		const fetchMock = vi.fn(async () =>
			Response.json({
				models: [
					{ slug: baseline.id, context_window: 500000, max_context_window: 872000 },
					{ slug: "unknown-account-model", context_window: 999999 },
				],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		expect((await models.refresh()).errors.size).toBe(0);
		expect(models.getModel("openai", baseline.id)).toEqual({ ...baseline, contextWindow: 500000 });
		expect(models.getModel("openai", "unknown-account-model")).toBeUndefined();
		expect((await models.getAvailable("openai")).find((model) => model.id === baseline.id)?.contextWindow).toBe(
			500000,
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.openai.com/v1/models",
			expect.objectContaining({
				headers: { accept: "application/json", authorization: "Bearer account-a" },
			}),
		);
	});

	it.each([0, -1, 1.5, "500000", null])("keeps the baseline for invalid context_window %s", async (limit) => {
		const { models } = await setup();
		const baseline = models.getModel("openai", "gpt-6.1-sol");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({ models: [{ slug: baseline!.id, context_window: limit, max_context_window: 872000 }] }),
			),
		);
		await models.refresh();
		expect(models.getModel("openai", baseline!.id)).toEqual(baseline);
	});

	it.each([401, 403, 404])("uses the static fallback for HTTP %s", async (status) => {
		const { models } = await setup();
		const baseline = models.getModels("openai");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status })),
		);
		expect((await models.refresh()).errors.size).toBe(0);
		expect(models.getModels("openai")).toEqual(baseline);
	});

	it("clears account limits for offline refresh, another account, and API-key auth", async () => {
		const { models, credentials } = await setup();
		const baseline = models.getModels("openai");
		const fetchMock = vi.fn(async () => Response.json({ models: [{ slug: "gpt-6.1-sol", context_window: 500000 }] }));
		vi.stubGlobal("fetch", fetchMock);
		await models.refresh();
		await models.refresh({ allowNetwork: false });
		expect(models.getModels("openai")).toEqual(baseline);
		await models.refresh();
		await credentials.modify("openai", async () => ({
			type: "oauth",
			access: "account-b",
			refresh: "refresh-b",
			expires: Number.MAX_SAFE_INTEGER,
		}));
		fetchMock.mockImplementation(async () => Response.json({ models: [] }));
		await models.refresh();
		expect(models.getModels("openai")).toEqual(baseline);
		await credentials.modify("openai", async () => ({ type: "api_key", key: "api-key" }));
		fetchMock.mockClear();
		await models.refresh();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(models.getModels("openai")).toEqual(baseline);
	});
});
