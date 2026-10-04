import { fauxAssistantMessage, fauxText, fauxToolCall, type ToolResultMessage, Type } from "@earendil-works/pi-ai";
import { defineTool, LiveDoc, MemoryStorage, ToolResultEntry, ToolTask } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { allEntries, chatSetup, openChat } from "./chat-support.ts";
import { addHooks, addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { deferred } from "./task-support.ts";

const parameters = Type.Object({ text: Type.Optional(Type.String()) });

// https://github.com/earendil-works/pi/issues/10455
// Nested calls must keep the parent's protocol identity and output separate.
describe("nested tool execution", () => {
	// https://github.com/earendil-works/pi/issues/10455
	it("keeps the current shell output window scoped to a tail-retaining child", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			defineTool({
				name: "child",
				description: "Child",
				parameters,
				outputLimits: { maxBytes: 3, retain: "tail" },
				execute: async (_args, api) => {
					expect(api.outputWindow).toMatchObject({ maxBytes: 3, minIntervalMs: expect.any(Number) });
					api.output("abcdef", { bytes: 6, newlines: 0, endsWithNewline: false });
					return {};
				},
			}),
		);
		addTool(
			setup.registry,
			defineTool({
				name: "parent",
				description: "Parent",
				parameters,
				execute: async (_args, api, callContext) => {
					expect(api.outputWindow).toBeUndefined();
					const child = await api.executeTool("child", {}, callContext);
					expect(child.content).toEqual([{ type: "text", text: "def" }]);
					expect(child.diagnostics?.[0]?.message).toContain("9 bytes dropped");
					return {};
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("parent", {}, { id: "p" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		await harness.close(context);
	});

	// https://github.com/earendil-works/pi/issues/10455#issuecomment-5984851470
	it("isolates repeated calls by callId even when they share a durable task", async () => {
		const setup = chatSetup();
		const calls: { taskId: number; callId: string; parentCallId: string | undefined; memo: string }[] = [];
		addTool(
			setup.registry,
			defineTool({
				name: "child",
				description: "Child",
				parameters,
				execute: async (_args, api, callContext) => {
					calls.push({
						taskId: api.taskId,
						callId: api.callId,
						parentCallId: api.parentCallId,
						memo: await api.memo("pending-question", api.callId, callContext),
					});
					return {};
				},
			}),
		);
		addTool(
			setup.registry,
			defineTool({
				name: "parent",
				description: "Parent",
				parameters,
				execute: async (_args, api, callContext) => {
					await Promise.all([
						api.executeTool("child", {}, callContext),
						api.executeTool("child", {}, callContext),
					]);
					return {};
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("parent", {}, { id: "p" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(new Set(calls.map((call) => call.taskId)).size).toBe(1);
		expect(calls.map((call) => call.callId).sort()).toEqual(["p/1", "p/2"]);
		for (const call of calls) {
			expect(call.parentCallId).toBe("p");
			expect(call.memo).toBe(call.callId);
		}
		await harness.close(context);
	});

	it("prepares, validates and runs hooks with an independent call id and bounded output", async () => {
		const setup = chatSetup();
		const seen: unknown[] = [];
		const approvals: string[] = [];
		addHooks(setup.registry, ToolTask, {
			beforeTool: async (call, api, hookContext) => {
				approvals.push(await api.memo("approval", call.name, hookContext));
				seen.push([call.id, call.parentCallId, call.arguments]);
				return call.parentCallId ? { arguments: { text: "hooked" } } : undefined;
			},
		});
		addTool(
			setup.registry,
			defineTool({
				name: "child",
				description: "Child",
				parameters,
				prepareArguments: () => ({ text: "prepared" }),
				outputLimits: { maxBytes: 3 },
				execute: async (args, api) => {
					seen.push([api.callId, api.parentCallId, args.text]);
					api.output("abcdef");
					await api.details({ child: true }, context);
					return {};
				},
			}),
		);
		addTool(
			setup.registry,
			defineTool({
				name: "parent",
				description: "Parent",
				parameters,
				execute: async (_args, api, callContext) => {
					api.output("parent");
					await api.details({ parent: true }, callContext);
					const child = await api.executeTool("child", {}, callContext);
					expect(child.content).toEqual([{ type: "text", text: "abc" }]);
					expect(child.details).toEqual({ child: true });
					expect(child.diagnostics).toMatchObject([{ code: "truncated" }]);
					const live = await api.snapshot(LiveDoc, api.conversationId, callContext);
					expect(live?.tools?.[0]?.output).toBe("parent");
					return {};
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("parent", {}, { id: "p" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const messages = (await allEntries(root))
			.filter((entry) => ToolResultEntry.is(entry))
			.map((entry) => entry.model![0] as ToolResultMessage);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			toolCallId: "p",
			content: [{ type: "text", text: "parent" }],
			details: { parent: true },
			nestedCalls: { complete: true, calls: [{ id: "p/1", name: "child", status: "ok", arguments: {} }] },
		});
		expect(approvals).toEqual(["parent", "child"]);
		expect(seen).toEqual([
			["p", undefined, {}],
			["p/1", "p", { text: "prepared" }],
			["p/1", "p", "hooked"],
		]);
		await harness.close(context);
	});

	it("rejects unselected tools and invalid arguments without running their implementations", async () => {
		const setup = chatSetup();
		let ran = 0;
		const hidden = defineTool({
			name: "hidden",
			description: "Hidden",
			parameters,
			execute: async () => {
				ran++;
				return {};
			},
		});
		addTool(setup.registry, hidden);
		addTool(
			setup.registry,
			defineTool({
				name: "child",
				description: "Child",
				parameters,
				execute: async () => {
					ran++;
					return {};
				},
			}),
		);
		addTool(
			setup.registry,
			defineTool({
				name: "parent",
				description: "Parent",
				parameters,
				execute: async (_args, api, callContext) => {
					const missing = await api.executeTool("hidden", {}, callContext);
					const invalid = await api.executeTool("child", { text: {} }, callContext);
					expect(missing).toMatchObject({ isError: true, diagnostics: [{ code: "tool_unavailable" }] });
					expect(invalid).toMatchObject({ isError: true, diagnostics: [{ code: "invalid_arguments" }] });
					return {};
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("parent", {}, { id: "p" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.configure({ tools: { remove: [hidden] } }, context);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(ran).toBe(0);
		await harness.close(context);
	});
	it("bounds records and arguments and rolls up usage even for dropped calls", async () => {
		const setup = chatSetup();
		const usage = {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		addTool(
			setup.registry,
			defineTool({ name: "child", description: "Child", parameters, execute: async () => ({ usage }) }),
		);
		addTool(
			setup.registry,
			defineTool({
				name: "parent",
				description: "Parent",
				parameters,
				execute: async (_args, api, callContext) => {
					for (let i = 0; i < 257; i++)
						await api.executeTool("child", { text: i === 0 ? "x".repeat(9000) : "ok" }, callContext);
					return { usage };
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("parent", {}, { id: "p" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const entry = (await allEntries(root)).find((entry) => ToolResultEntry.is(entry))!;
		const message = entry.model![0] as ToolResultMessage;
		expect(message.nestedCalls?.calls).toHaveLength(256);
		expect(message.nestedCalls?.complete).toBe(false);
		expect(message.nestedCalls?.calls[0]).toMatchObject({ argumentsBytes: 9011, status: "ok" });
		expect(message.nestedCalls?.calls[0]?.arguments).toBeUndefined();
		expect(message.usage?.totalTokens).toBe(258 * 3);
		expect((await harness.usage(context)).tools.parent?.totalTokens).toBe(258 * 3);
		await harness.close(context);
	});

	it("serializes sequential calls without deadlocking a nested descendant", async () => {
		const setup = chatSetup();
		let active = 0;
		let maximum = 0;
		addTool(
			setup.registry,
			defineTool({ name: "leaf", description: "Leaf", parameters, execute: async () => ({ content: [] }) }),
		);
		addTool(
			setup.registry,
			defineTool({
				name: "child",
				description: "Child",
				parameters,
				executionMode: "sequential",
				execute: async (_args, api, callContext) => {
					maximum = Math.max(maximum, ++active);
					await api.executeTool("leaf", {}, callContext);
					active--;
					return {};
				},
			}),
		);
		addTool(
			setup.registry,
			defineTool({
				name: "parent",
				description: "Parent",
				parameters,
				execute: async (_args, api, callContext) => {
					await Promise.all([
						api.executeTool("child", {}, callContext),
						api.executeTool("child", {}, callContext),
					]);
					return {};
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("parent", {}, { id: "p" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(maximum).toBe(1);
		await harness.close(context);
	});

	it("cancels unfinished calls when their parent returns and preserves unfinished metadata", async () => {
		const setup = chatSetup();
		const started = deferred();
		let signal: AbortSignal | undefined;
		addTool(
			setup.registry,
			defineTool({
				name: "child",
				description: "Child",
				parameters,
				execute: async (_args, _api, callContext) => {
					signal = callContext.abortSignal;
					started.resolve();
					await new Promise(() => {});
					return {};
				},
			}),
		);
		addTool(
			setup.registry,
			defineTool({
				name: "parent",
				description: "Parent",
				parameters,
				execute: async (_args, api, callContext) => {
					void api.executeTool("child", {}, callContext);
					await started.promise;
					return {};
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("parent", {}, { id: "p" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(signal?.aborted).toBe(true);
		const entry = (await allEntries(root)).find((entry) => ToolResultEntry.is(entry))!;
		expect((entry.model![0] as ToolResultMessage).nestedCalls).toMatchObject({
			complete: false,
			calls: [{ id: "p/1", status: "unfinished" }],
		});
		await harness.close(context);
	});
});
