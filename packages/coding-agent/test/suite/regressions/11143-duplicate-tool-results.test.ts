import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const echoTool: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo a result",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "first" }], details: {} }),
};

// Regression for https://github.com/earendil-works/pi/issues/11143.
describe("duplicate persisted tool results (#11143)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("sanitizes resumed history while preserving distinct results and the session log", async () => {
		const sessionManager = SessionManager.inMemory();
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "X",
			toolName: "echo",
			content: [{ type: "text", text: "first" }],
			isError: false,
			timestamp: Date.now(),
		};
		sessionManager.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
		sessionManager.appendMessage(
			fauxAssistantMessage([fauxToolCall("echo", {}, { id: "X" }), fauxToolCall("echo", {}, { id: "Y" })], {
				stopReason: "toolUse",
			}),
		);
		sessionManager.appendMessage(result);
		sessionManager.appendMessage({ ...result, content: [{ type: "text", text: "duplicate" }] });
		sessionManager.appendMessage({ ...result, toolCallId: "Y" });
		const harness = await createHarness({ sessionManager, tools: [echoTool] });
		harnesses.push(harness);
		const requests: ToolResultMessage[][] = [];
		harness.setResponses([
			(context) => {
				const results = context.messages.filter((message) => message.role === "toolResult");
				requests.push(results);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("continue");

		expect(requests).toHaveLength(1);
		expect(requests[0]?.map((message) => message.toolCallId)).toEqual(["X", "Y"]);
		expect(requests[0]?.[0]?.content).toEqual(result.content);

		expect(
			sessionManager.buildSessionProjection().messages.filter((message) => message.role === "toolResult"),
		).toHaveLength(3);
	});

	it("sanitizes the request after a tool turn refresh", async () => {
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		const requests: ToolResultMessage[][] = [];
		harness.session.subscribe((event) => {
			if (event.type === "turn_end" && event.toolResults.length) {
				harness.sessionManager.appendMessage({
					...event.toolResults[0]!,
					content: [{ type: "text", text: "duplicate" }],
				});
			}
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", {}, { id: "X" }), { stopReason: "toolUse" }),
			(context) => {
				const results = context.messages.filter((message) => message.role === "toolResult");
				requests.push(results);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("start");

		expect(requests).toHaveLength(1);
		expect(requests[0]).toHaveLength(1);
		expect(requests[0]?.[0]?.content).toEqual([{ type: "text", text: "first" }]);

		expect(
			harness.sessionManager.buildSessionProjection().messages.filter((message) => message.role === "toolResult"),
		).toHaveLength(2);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
