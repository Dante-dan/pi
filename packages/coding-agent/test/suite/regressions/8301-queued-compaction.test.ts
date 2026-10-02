import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

// Regression tests for #8301: compaction is a task boundary, not a user message or an abort.
describe("queued compaction", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function waitingHarness(cancelCompaction = false) {
		let release = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const trace: string[] = [];
		const wait: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await released;
				trace.push("tool finished");
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [wait],
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						trace.push(`compact: ${event.customInstructions ?? "default"}`);
						if (cancelCompaction) return { cancel: true };
						return {
							compaction: {
								summary: "summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("history")]);
		await harness.session.prompt("seed history");
		const started = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "user") {
				trace.push(getMessageText(event.message));
			}
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("task 1 done"),
			fauxAssistantMessage("task 2 done"),
			fauxAssistantMessage("task 3 done"),
		]);
		const prompt = harness.session.prompt("task 1");
		await started;
		return { harness, release, trace, prompt };
	}

	it.each(["one-at-a-time", "all"] as const)("preserves task/compact order in %s mode", async (mode) => {
		const { harness, release, trace, prompt } = await waitingHarness();
		harness.session.setFollowUpMode(mode);
		harness.session.queueCompaction("keep the plan");
		await harness.session.followUp("task 2");
		harness.session.queueCompaction();
		await harness.session.followUp("task 3");
		expect(harness.session.getFollowUpMessages()).toEqual(["/compact keep the plan", "task 2", "/compact", "task 3"]);
		expect(trace).toEqual(["task 1"]);
		release();
		await prompt;
		expect(trace).toEqual([
			"task 1",
			"tool finished",
			"compact: keep the plan",
			"task 2",
			"compact: default",
			"task 3",
		]);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(2);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(2);
	});

	it("waits for earlier follow-ups, and clearing the queue restores compaction text", async () => {
		const { harness, release, trace, prompt } = await waitingHarness();
		await harness.session.followUp("task 2");
		harness.session.queueCompaction();
		await harness.session.followUp("task 3");
		expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: ["task 2", "/compact", "task 3"] });
		release();
		await prompt;
		expect(trace).toEqual(["task 1", "tool finished"]);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it("compacts only after earlier queued tasks complete", async () => {
		const { harness, release, trace, prompt } = await waitingHarness();
		await harness.session.followUp("task 2");
		harness.session.queueCompaction();
		await harness.session.followUp("task 3");
		release();
		await prompt;
		expect(trace).toEqual(["task 1", "tool finished", "task 2", "compact: default", "task 3"]);
	});

	it("preserves later work when an extension cancels compaction", async () => {
		const { harness, release, trace, prompt } = await waitingHarness(true);
		harness.session.queueCompaction();
		await harness.session.followUp("task 2");
		release();
		await prompt;
		expect(trace).toEqual(["task 1", "tool finished", "compact: default"]);
		expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: ["task 2"] });
		expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({ aborted: true });
	});
});
