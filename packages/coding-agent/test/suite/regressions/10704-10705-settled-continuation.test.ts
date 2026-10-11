import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("settled continuation completion", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	// Regression #10705: abort from a public settled subscriber cancels queued triggerTurn work.
	it("cancels deferred custom-message continuations when aborted at settlement", async () => {
		let continued = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", (event) => {
						if (continued || event.aborted) return;
						continued = true;
						pi.sendMessage(
							{ customType: "continue", content: "Continue.", display: false },
							{ triggerTurn: true },
						);
					});
				},
			],
		});
		harnesses.push(harness);
		let abortWait: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled" && !abortWait) abortWait = harness.session.abort();
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("unwanted continuation")]);
		await harness.session.prompt("hello");
		await abortWait;
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);
		await harness.session.prompt("new independent prompt");
		expect(harness.faux.state.callCount).toBe(2);
	});

	// Regression #10704: manual compaction must not resolve a waiter before its settled handler resumes.
	it("waits through awaited compaction and the continuation it queues", async () => {
		let continued = false;
		const order: string[] = [];
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "checkpoint",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
					pi.on("agent_settled", async (_event, ctx) => {
						if (continued) return;
						continued = true;
						expect(ctx.isIdle()).toBe(true);
						await new Promise<void>((resolve, reject) =>
							ctx.compact({ onComplete: () => resolve(), onError: reject }),
						);
						order.push("compact-complete");
						pi.sendMessage(
							{ customType: "continue", content: "Continue.", display: false },
							{ triggerTurn: true },
						);
						order.push("continuation-queued");
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		let idleWait: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "agent_start") {
				order.push("request");
				idleWait ??= harness.session.waitForIdle().then(() => {
					order.push("idle-resolved");
				});
			}
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("hello");
		await idleWait;
		expect(order).toEqual(["request", "compact-complete", "continuation-queued", "request", "idle-resolved"]);
		expect(harness.faux.state.callCount).toBe(2);
	});
});
