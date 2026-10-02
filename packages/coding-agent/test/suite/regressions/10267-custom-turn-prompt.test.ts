import { fauxAssistantMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "../harness.ts";

describe("custom-message prompt continuation", () => {
	// Regression #10267: a triggered custom message removed before_agent_start prompt changes.
	it.each(["sections", "forced"] as const)("keeps %s until the next user prompt", async (mode) => {
		let hookCalls = 0;
		const prompts: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						if (++hookCalls !== 1) return;
						if (mode === "sections") event.systemPromptOptions.sections.persistent = "keep marker";
						else event.systemPromptOptions.forceSystemPrompt = "keep marker";
					});
				},
			],
		});
		try {
			harness.setResponses(
				Array.from({ length: 4 }, () => (context) => {
					prompts.push(getCurrentSystemPrompt(context.messages));
					return fauxAssistantMessage("done");
				}),
			);
			await harness.session.prompt("first");
			for (let i = 0; i < 2; i++) {
				await harness.session.sendCustomMessage(
					{ customType: "follow-up", content: "continue", display: false },
					{ triggerTurn: true },
				);
			}
			expect(hookCalls).toBe(1);
			expect(prompts.slice(0, 3)).toEqual([prompts[0], prompts[0], prompts[0]]);
			expect(prompts[0]).toContain("keep marker");
			await harness.session.prompt("second");
			expect(hookCalls).toBe(2);
			expect(prompts[3]).not.toContain("keep marker");
		} finally {
			harness.cleanup();
		}
	});
});
