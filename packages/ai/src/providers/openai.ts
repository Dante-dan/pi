import { openAIDecisionsApi } from "../api/openai-decisions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadOpenAIChatGPTOAuth } from "../auth/oauth/load.ts";
import { createProvider, isModelType, type Provider, type RefreshModelsContext } from "../models.ts";
import type { AnyModel, ClassifierModel, Model } from "../types.ts";
import { OPENAI_CLASSIFIER_MODELS, OPENAI_MODELS } from "./openai.models.ts";

const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Apply ChatGPT account limits without changing the shared API-key catalog. */
export async function personalizeOpenAICatalog(
	catalog: readonly AnyModel[],
	context: RefreshModelsContext,
): Promise<readonly AnyModel[]> {
	if (context.credential?.type !== "oauth") return catalog;
	const response = await fetch(`${(context.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, "")}/models`, {
		headers: { accept: "application/json", authorization: `Bearer ${context.credential.access}` },
		signal: AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]),
	});
	if (response.status === 401 || response.status === 403 || response.status === 404) return catalog;
	if (!response.ok) throw new Error(`OpenAI model list request failed: ${response.status}`);
	const body: unknown = await response.json();
	// Sign in with ChatGPT uses models[].slug, unlike the API-key data[].id catalog.
	if (typeof body !== "object" || body === null || !("models" in body) || !Array.isArray(body.models)) {
		throw new Error("Invalid OpenAI model list response");
	}
	const limits = new Map<string, number>();
	for (const entry of body.models as unknown[]) {
		if (typeof entry !== "object" || entry === null || !("slug" in entry) || typeof entry.slug !== "string") continue;
		if (!("context_window" in entry) || typeof entry.context_window !== "number") continue;
		// The account's default budget is distinct from its optional max_context_window.
		if (!Number.isSafeInteger(entry.context_window) || entry.context_window <= 0) continue;
		limits.set(entry.slug, entry.context_window);
	}
	return catalog.map((model) => {
		if (!isModelType(model, "chat")) return model;
		const contextWindow = limits.get(model.id);
		return contextWindow === undefined ? model : { ...model, contextWindow };
	});
}

export function openaiProvider(): Provider<"openai-responses"> {
	const baseline = Object.values(OPENAI_MODELS);
	const classifiers = Object.values<ClassifierModel<"openai-decisions">>(OPENAI_CLASSIFIER_MODELS);
	let chatModels: readonly Model<"openai-responses">[] = baseline;
	const provider = createProvider<"openai-responses">({
		id: "openai",
		name: "OpenAI",
		baseUrl: OPENAI_BASE_URL,
		auth: {
			apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]),
			oauth: lazyOAuth({
				name: "OpenAI (ChatGPT subscription)",
				isSubscription: true,
				loginLabel: "Sign in with ChatGPT",
				load: loadOpenAIChatGPTOAuth,
			}),
		},
		models: [...baseline, ...classifiers],
		// Sign in with ChatGPT tokens only reach the Responses API; the Decisions API rejects them.
		filterAllModels: (models, credential) =>
			credential?.type === "oauth" ? models.filter((model) => !isModelType(model, "classifier")) : models,
		api: openAIResponsesApi(),
		classifiers: {
			"openai-decisions": openAIDecisionsApi(),
		},
	});
	return {
		...provider,
		getModels: () => chatModels,
		getAllModels: () => [...chatModels, ...classifiers],
		async refreshModels(context) {
			// Account limits must not survive a credential change or enter the shared provider cache.
			if (
				!(await context.publish({
					update: () => {
						chatModels = baseline;
					},
				}))
			)
				return;
			if (!context.allowNetwork || context.credential?.type !== "oauth") return;
			const models = (await personalizeOpenAICatalog(baseline, context)) as readonly Model<"openai-responses">[];
			await context.publish({
				update: () => {
					chatModels = models;
				},
			});
		},
	};
}
