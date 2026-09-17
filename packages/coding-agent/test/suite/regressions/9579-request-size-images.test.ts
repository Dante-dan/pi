import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type ImageContent, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function imageBytes(messages: AgentMessage[] | TranscriptContext["messages"]): number {
	let bytes = 0;
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "toolResult" && message.role !== "custom") continue;
		if (typeof message.content === "string") continue;
		for (const block of message.content) {
			if (block.type === "image") bytes += block.data.length;
		}
	}
	return bytes;
}

// Regression for #9579: image payload bytes can overflow far below the token window.
describe("request-size image recovery", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("retains the newest screenshot and preserves the original session images", async () => {
		harness = await createHarness({ models: [{ id: "images", input: ["text", "image"] }] });
		const screenshot: ImageContent = { type: "image", data: "A".repeat(4 * 1024 * 1024), mimeType: "image/png" };
		const original: AgentMessage = {
			role: "toolResult",
			toolCallId: "screenshots",
			toolName: "screenshot",
			isError: false,
			timestamp: Date.now(),
			content: [
				screenshot,
				{ type: "text", text: "Keep this caption" },
				{ ...screenshot, data: "B".repeat(screenshot.data.length) },
			],
		};
		harness.sessionManager.appendMessage(original);
		harness.session.agent.state.messages = [original];
		const observed: number[] = [];
		const respond = (context: TranscriptContext) => {
			const bytes = imageBytes(context.messages);
			observed.push(bytes);
			return bytes > 6 * 1024 * 1024
				? fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "request_too_large: Exceeded limit on max bytes to request body: 6291456",
					})
				: fauxAssistantMessage("recovered");
		};
		harness.setResponses([respond, respond]);
		await harness.session.prompt("Continue");
		expect(observed).toEqual([8 * 1024 * 1024, 4 * 1024 * 1024]);
		expect(harness.session.getLastAssistantText()).toBe("recovered");
		const retained = harness.session.messages.find((message) => message.role === "toolResult");
		expect(retained?.content).toEqual([
			{ type: "text", text: "[Image omitted after the provider rejected the request size.]" },
			{ type: "text", text: "Keep this caption" },
			original.content[2],
		]);
		expect(imageBytes(harness.sessionManager.buildSessionContext().messages)).toBe(8 * 1024 * 1024);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("reduces images repeatedly for a smaller unknown limit, including the last image", async () => {
		harness = await createHarness({ models: [{ id: "images", input: ["text", "image"] }] });
		const observed: number[] = [];
		const respond = (context: TranscriptContext) => {
			const bytes = imageBytes(context.messages);
			observed.push(bytes);
			return bytes > 512 * 1024
				? fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "Exceeded limit on max bytes to request body: 524288",
					})
				: fauxAssistantMessage("recovered");
		};
		harness.setResponses([respond, respond, respond, respond, respond]);
		await harness.session.prompt("Continue", {
			images: Array.from({ length: 8 }, () => ({
				type: "image",
				data: "A".repeat(1024 * 1024),
				mimeType: "image/png",
			})),
		});
		expect(observed).toEqual([8, 4, 2, 1, 0].map((value) => value * 1024 * 1024));
		expect(harness.session.getLastAssistantText()).toBe("recovered");
		expect(imageBytes(harness.sessionManager.buildSessionContext().messages)).toBe(8 * 1024 * 1024);
	});

	it("stops when a persistent size error has no further image bytes to remove", async () => {
		harness = await createHarness({ models: [{ id: "images", input: ["text", "image"] }] });
		const error = fauxAssistantMessage("", { stopReason: "error", errorMessage: "request_too_large" });
		harness.setResponses([error, error]);
		await harness.session.prompt("Continue", {
			images: [{ type: "image", data: "A".repeat(1024), mimeType: "image/png" }],
		});
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: "request_too_large" });
	});
});
