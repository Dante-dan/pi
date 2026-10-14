import { describe, expect, it } from "vitest";
import { getModels, getProviders } from "../src/compat.ts";
import { getSupportedThinkingLevels, hasApi } from "../src/models.ts";
import type { Api, Model } from "../src/types.ts";

const EXPECTED_CURRENT_ADAPTIVE_THINKING_MODELS = [
	"anthropic/claude-fable-5",
	"anthropic/claude-haiku-5-5",
	"anthropic/claude-opus-4-8",
	"anthropic/claude-opus-5",
	"anthropic/claude-sonnet-5",
	"cloudflare-ai-gateway/claude-fable-5",
	"fireworks/accounts/fireworks/models/deepseek-v4p1-flash",
	"fireworks/accounts/fireworks/models/gpt-oss-120b",
	"fireworks/accounts/fireworks/models/qwen3p8-max",
	"kimi-coding/kimi-for-coding",
	"kimi-coding/k3",
	"kimi-coding/kimi-for-coding-highspeed",
	"minimax/MiniMax-M3.1-Flash-Preview",
	"minimax-cn/MiniMax-M3.1-Flash-Preview",
	"opencode/claude-opus-4-8",
	"opencode/claude-opus-5",
	"vercel-ai-gateway/anthropic/claude-opus-4.8",
	"vercel-ai-gateway/anthropic/claude-opus-5",
	"vercel-ai-gateway/anthropic/claude-sonnet-5",
];

function getAllModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => getModels(provider) as Model<Api>[]);
}

describe("Anthropic adaptive thinking model metadata", () => {
	it("marks built-in Anthropic Messages models that use adaptive thinking", () => {
		const flaggedModels = getAllModels()
			.filter((model): model is Model<"anthropic-messages"> => model.api === "anthropic-messages")
			.filter((model) => model.compat?.forceAdaptiveThinking === true)
			.map((model) => `${model.provider}/${model.id}`)
			.sort();

		expect(flaggedModels).toEqual(expect.arrayContaining([...EXPECTED_CURRENT_ADAPTIVE_THINKING_MODELS].sort()));
		expect(flaggedModels).toEqual(
			flaggedModels.filter(
				(modelId) =>
					// Regression for #9323: Fireworks uses catalog effort metadata and
					// verified fallbacks, not a fixed set of adaptive model names.
					modelId.startsWith("fireworks/") ||
					modelId.endsWith("/MiniMax-M3.1-Flash-Preview") ||
					/(opus[-.](4[-.][678]|5)|sonnet[-.]4[-.]6|sonnet[-.]5|haiku[-.]5[-.]5|fable[-.]5|kimi-coding\/)/.test(
						modelId,
					),
			),
		);
	});

	// Regression for #10916: M3.1 is plan-only and requires adaptive thinking.
	it("imports MiniMax M3.1 plan metadata without changing M3 thinking", () => {
		for (const provider of ["minimax", "minimax-cn"] as const) {
			const models = getModels(provider);
			const m31 = models.find((model) => model.id === "MiniMax-M3.1-Flash-Preview");
			if (!m31 || !hasApi(m31, "anthropic-messages")) throw new Error("Expected MiniMax M3.1 Messages model");
			expect(m31.compat?.forceAdaptiveThinking).toBe(true);
			expect(getSupportedThinkingLevels(m31)).toEqual(["low", "medium", "high", "xhigh", "max"]);
			expect(m31.input).toEqual(["text", "image"]);
			expect(m31.contextWindow).toBe(1_000_000);
			expect(m31.maxTokens).toBe(512_000);
			expect(m31.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			const m3 = models.find((model) => model.id === "MiniMax-M3");
			if (!m3 || !hasApi(m3, "anthropic-messages")) throw new Error("Expected MiniMax M3 Messages model");
			expect(m3.compat?.forceAdaptiveThinking).toBeUndefined();
			expect(getSupportedThinkingLevels(m3)).toContain("off");
		}
	});
});
