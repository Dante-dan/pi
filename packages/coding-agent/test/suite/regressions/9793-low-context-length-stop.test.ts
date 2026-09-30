import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #9793 low-context length stops", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	// Regression for #9793: under-reported reasoning output is not context overflow.
	it("retains working history and the partial response without compacting or retrying", async () => {
		harness = await createHarness({
			models: [{ id: "deepseek-test", contextWindow: 1000000, maxTokens: 16384 }],
			settings: { compaction: { enabled: true, reserveTokens: 16384 } },
		});
		harness.setResponses([fauxAssistantMessage("partial response", { stopReason: "length" })]);

		await harness.session.prompt("Keep this working context.");

		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		const conversation = harness.session.messages.filter((message) => message.role !== "system");
		expect(conversation).toHaveLength(2);
		expect(conversation[0]).toMatchObject({ role: "user" });
		expect(conversation[1]).toMatchObject({
			role: "assistant",
			stopReason: "length",
			content: [{ type: "text", text: "partial response" }],
		});
		expect(harness.session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
	});
});
