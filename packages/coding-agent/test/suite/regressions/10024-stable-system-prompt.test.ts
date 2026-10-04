import {
	fauxAssistantMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import stableSystemPrompt from "../../../examples/extensions/stable-system-prompt.ts";
import { createHarness, type Harness } from "../harness.ts";

let harness: Harness | undefined;
afterEach(() => harness?.cleanup());

// #10024: explicitly loaded workaround keeps the initial text while declaring the live tools.
it("projects prompt deltas as user messages without changing persisted system messages", async () => {
	harness = await createHarness({ extensionFactories: [stableSystemPrompt] });
	const requests: TranscriptContext[] = [];
	harness.setResponses([
		(context) => {
			requests.push(context);
			return fauxAssistantMessage("first");
		},
		(context) => {
			requests.push(context);
			return fauxAssistantMessage("second");
		},
	]);
	await harness.session.prompt("first");
	harness.session.setActiveToolsByName(harness.session.getActiveToolNames().filter((name) => name !== "bash"));
	await harness.session.prompt("second");

	expect(getCurrentSystemPrompt(requests[1].messages)).toBe(getCurrentSystemPrompt(requests[0].messages));
	expect(getCurrentTools(requests[1].messages).map((tool) => tool.name)).toEqual(harness.session.getActiveToolNames());
	expect(requests[1].messages.filter((message) => message.role === "system")).toHaveLength(1);
	expect(
		requests[1].messages.some(
			(message) =>
				message.role === "user" &&
				typeof message.content === "string" &&
				message.content.includes('Updated system prompt section "tools"'),
		),
	).toBe(true);
	expect(harness.session.messages.filter((message) => message.role === "system").length).toBeGreaterThan(1);
});
