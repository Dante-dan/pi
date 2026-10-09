import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #10082 refreshed context window", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		vi.restoreAllMocks();
	});

	// #10082: a resumed selection can precede the live provider catalog refresh.
	it("uses refreshed limits for context usage and the first prompt", async () => {
		harness = await createHarness({
			models: [{ id: "cached", contextWindow: 8192, maxTokens: 1024 }],
			settings: { compaction: { enabled: true, reserveTokens: 1024 } },
		});
		const cached = harness.getModel();
		harness.sessionManager.appendMessage({ role: "user", content: "previous prompt", timestamp: 1 });
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("previous response", { timestamp: 2 }),
			api: cached.api,
			provider: cached.provider,
			model: cached.id,
			usage: {
				input: 12000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		harness.session.refreshContext();
		const refreshed = { ...cached, contextWindow: 65536 };
		vi.spyOn(harness.session.modelRuntime, "getModel").mockReturnValue(refreshed);
		vi.spyOn(harness.session.modelRuntime, "getPhysicalModel").mockReturnValue(refreshed);
		harness.setResponses([fauxAssistantMessage("next response")]);

		expect(harness.session.getContextUsage()?.contextWindow).toBe(65536);
		expect(harness.session.model).toBe(cached);
		await harness.session.prompt("next prompt");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("retains the selected limits when the model is absent from the refreshed catalog", async () => {
		harness = await createHarness({ models: [{ id: "custom", contextWindow: 65536 }] });
		vi.spyOn(harness.session.modelRuntime, "getPhysicalModel").mockReturnValue(undefined);
		expect(harness.session.getContextUsage()?.contextWindow).toBe(65536);
	});
});
