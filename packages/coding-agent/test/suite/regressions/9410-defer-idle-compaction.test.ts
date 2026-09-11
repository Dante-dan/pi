import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// Regression coverage for #9410: finishing a run must not start proactive compaction.
describe("issue #9410 compaction at request boundaries", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function compactionHarness(order: string[]): Promise<Harness> {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 10_000 }],
			tools: [],
			settings: { compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						order.push("compact");
						return {
							compaction: {
								summary: "request-boundary summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		return harness;
	}

	it.each([
		["stop", "prompt"],
		["aborted", "prompt"],
		["stop", "custom"],
	] as const)(
		"settles a %s response above the threshold, then compacts before the next %s request",
		async (stopReason, entryPoint) => {
			const order: string[] = [];
			const harness = await compactionHarness(order);
			harness.setResponses([
				fauxAssistantMessage("x".repeat(36_000), { stopReason }),
				(context) => {
					order.push("next request");
					expect(JSON.stringify(context.messages)).toContain("request-boundary summary");
					return fauxAssistantMessage("next answer");
				},
			]);

			await harness.session.prompt("first prompt");
			expect(harness.session.isIdle).toBe(true);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
			expect(harness.eventsOfType("compaction_start")).toEqual([]);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
			expect(harness.faux.state.callCount).toBe(1);

			if (entryPoint === "prompt") {
				await harness.session.prompt("next prompt");
			} else {
				await harness.session.sendCustomMessage(
					{ customType: "test", content: "next prompt", display: false },
					{ triggerTurn: true },
				);
			}
			expect(order).toEqual(["compact", "next request"]);
			expect(harness.session.getLastAssistantText()).toBe("next answer");
			expect(harness.session.isIdle).toBe(true);
		},
	);

	it.each(["stop", "aborted"] as const)(
		"compacts before a continuation queued after a %s response",
		async (stopReason) => {
			const order: string[] = [];
			const harness = await compactionHarness(order);
			let queued = false;
			harness.session.subscribe((event) => {
				if (event.type !== "agent_end" || queued) return;
				queued = true;
				harness.session.agent.followUp({
					role: "user",
					content: "queued follow-up",
					timestamp: Date.now(),
				});
			});
			harness.setResponses([
				fauxAssistantMessage("x".repeat(36_000), { stopReason }),
				(context) => {
					order.push("queued request");
					const messages = JSON.stringify(context.messages);
					expect(messages).toContain("request-boundary summary");
					expect(messages).toContain("queued follow-up");
					return fauxAssistantMessage("queued answer");
				},
			]);

			await harness.session.prompt("first prompt");
			expect(order).toEqual(["compact", "queued request"]);
			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.session.isIdle).toBe(true);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		},
	);
});
