import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

// Regression coverage for #11444: /tree summaries must retain the session's selected thinking level.
describe("branch summary thinking level", () => {
	let harness: Harness | undefined;
	afterEach(() => harness?.cleanup());

	it.each([
		{ reasoning: true, thinkingLevel: "xhigh", expected: "xhigh" },
		{ reasoning: true, thinkingLevel: "max", expected: "max" },
		{ reasoning: true, thinkingLevel: "off", expected: undefined },
		{ reasoning: false, thinkingLevel: "high", expected: undefined },
	] as const)("forwards $thinkingLevel with reasoning=$reasoning", async ({ reasoning, thinkingLevel, expected }) => {
		harness = await createHarness({ models: [{ id: "summary-model", reasoning }], tools: [] });
		const targetId = harness.sessionManager.appendMessage(userMsg("first user"));
		harness.sessionManager.appendMessage(assistantMsg("first assistant"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		// Set the active selection directly so the request is checked independently of provider clamping.
		harness.session.agent.state.thinkingLevel = thinkingLevel;
		let requestedReasoning: string | undefined;
		harness.setResponses([
			(_context, options) => {
				requestedReasoning = options?.reasoning;
				return fauxAssistantMessage("branch summary");
			},
		]);

		const result = await harness.session.navigateTree(targetId, { summarize: true });

		expect(result.summaryEntry?.summary).toContain("branch summary");
		expect(requestedReasoning).toBe(expected);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
