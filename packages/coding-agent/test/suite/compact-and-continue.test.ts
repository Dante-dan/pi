import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import compactAndContinue from "../../examples/extensions/compact-and-continue.ts";
import { createHarness, type Harness } from "./harness.ts";

// Agent-driven compact-and-continue is the separate feature discussed in #8301.
describe("compact-and-continue extension", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("commits after the tool result and continues without a new user message", async () => {
		const harness = await createHarness({ extensionFactories: [compactAndContinue] });
		harnesses.push(harness);
		let resumedContext = "";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("compact", { continue: true }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Task: address comments. First comment committed. Next: second comment."),
			(context) => {
				resumedContext = JSON.stringify(context.messages);
				return fauxAssistantMessage("finished remaining work");
			},
		]);
		await harness.session.prompt("Address comments and compact after each commit");
		const entries = harness.sessionManager.getEntries();
		const index = entries.findIndex((entry) => entry.type === "compaction");
		expect(index).toBeGreaterThan(0);
		expect(entries[index - 1]).toMatchObject({
			type: "message",
			message: { role: "toolResult", toolName: "compact" },
		});
		expect(resumedContext).toContain("Next: second comment");
		expect(resumedContext).not.toContain("Summary prepared");
		expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it.each(["error", "length", "empty"] as const)(
		"keeps original context on %s summary and returns the error",
		async (failure) => {
			const harness = await createHarness({ extensionFactories: [compactAndContinue] });
			harnesses.push(harness);
			let nextContext = "";
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("compact", { continue: true }), { stopReason: "toolUse" }),
				fauxAssistantMessage(failure === "empty" ? "" : "incomplete", {
					stopReason: failure === "empty" ? "stop" : failure,
					errorMessage: failure === "error" ? "summary failed" : undefined,
				}),
				(context) => {
					nextContext = JSON.stringify(context.messages);
					return fauxAssistantMessage("recover without compaction");
				},
			]);
			await harness.session.prompt("preserve original task");
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
			expect(nextContext).toContain("preserve original task");
			expect(nextContext).toContain('"isError":true');
		},
	);

	it("does not replace context when another tool result shares the turn", async () => {
		const harness = await createHarness({ extensionFactories: [compactAndContinue] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("compact", { continue: true }), fauxToolCall("compact", { continue: true })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("handoff must be discarded"),
			fauxAssistantMessage("recover original context"),
		]);
		await harness.session.prompt("original multi-tool task");
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(JSON.stringify(harness.session.messages)).toContain("original multi-tool task");
	});

	it("discards a summary when the user aborts before it returns", async () => {
		const harness = await createHarness({ extensionFactories: [compactAndContinue] });
		harnesses.push(harness);
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = () => {};
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("compact", { continue: true }), { stopReason: "toolUse" }),
			async () => {
				started();
				await held;
				return fauxAssistantMessage("must not commit");
			},
			fauxAssistantMessage("must not continue"),
		]);
		const prompt = harness.session.prompt("original task");
		await ready;
		const abort = harness.session.abort();
		release();
		await Promise.all([prompt, abort]);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(JSON.stringify(harness.sessionManager.getEntries())).not.toContain("must not continue");
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});
});
