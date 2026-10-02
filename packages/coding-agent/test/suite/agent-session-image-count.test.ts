import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

// Regression coverage for #10162: independent, opt-in, bounded image-count recovery.
describe("image-count error compaction", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each([
		[false, undefined, 1],
		[true, undefined, 1],
		[true, false, 1],
		[false, true, 2],
		[true, true, 2],
	])("bounds recovery with enabled=%s, enabledOnError=%s", async (enabled, enabledOnError, calls) => {
		const harness = await createHarness({
			settings: { compaction: { enabled, enabledOnError, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "ordinary image history summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const images = Array.from({ length: 31 }, () => ({ type: "image" as const, data: "", mimeType: "image/png" }));
		const imageId = harness.sessionManager.appendMessage({ role: "user", content: images, timestamp: 1 });
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Too many images in request: 31 > 30" }),
			() =>
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Too many images in request: 36 > 30",
					timestamp: Date.now() + 1000,
				}),
		]);

		await harness.session.prompt("continue the visual task");

		expect(harness.faux.state.callCount).toBe(calls);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(calls - 1);
		expect(harness.sessionManager.getEntry(imageId)).toMatchObject({
			type: "message",
			message: { content: images },
		});
		if (calls === 2) {
			expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
				willRetry: false,
				errorMessage: expect.stringContaining("Image-count recovery failed after one compact-and-retry attempt"),
			});
		}
	});

	it.each(["Too many images", "Too many images in request: 30 > 30", "Too many images in request: 1 > 0"])(
		"does not recover an unsupported image error: %s",
		async (errorMessage) => {
			const harness = await createHarness({ settings: { compaction: { enabled: false, enabledOnError: true } } });
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage })]);
			await harness.session.prompt("visual task");
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		},
	);

	it("does not enable token overflow or threshold compaction", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { enabled: false, enabledOnError: true, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "context length exceeded" })]);
		await harness.session.prompt("x".repeat(8000));
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});
});
