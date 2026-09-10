import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessageEvent, Context, Model, ToolCall } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
	errorAfterFirstChunk: false,
	releaseAfterFirstChunk: undefined as (() => void) | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (let index = 0; index < mockState.chunks.length; index++) {
								yield mockState.chunks[index];
								if (index === 0) {
									await new Promise<void>((resolve) => {
										mockState.releaseAfterFirstChunk = resolve;
									});
									if (mockState.errorAfterFirstChunk) throw new Error("stream failed");
								}
							}
						},
					};
					const result = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					result.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return result;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

function chunk(argumentsDelta: string, finishReason: string | null = null): unknown {
	return {
		id: "chatcmpl-1",
		choices: [
			{
				index: 0,
				delta:
					argumentsDelta.length > 0
						? {
								tool_calls: [
									{
										index: 0,
										id: "call_1",
										type: "function",
										function: { name: "read", arguments: argumentsDelta },
									},
								],
							}
						: {},
				finish_reason: finishReason,
			},
		],
	};
}

function getToolCall(event: AssistantMessageEvent): ToolCall {
	if (!("partial" in event)) throw new Error("Expected partial message");
	const block = event.partial.content.find((content) => content.type === "toolCall");
	if (!block || block.type !== "toolCall") throw new Error("Expected tool call");
	return block;
}

describe("OpenAI completions streamed tool arguments", () => {
	beforeEach(() => {
		mockState.chunks = [];
		mockState.errorAfterFirstChunk = false;
		mockState.releaseAfterFirstChunk = undefined;
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("parses partial arguments lazily and materializes them at toolcall_end (#9265)", async () => {
		const parse = vi.spyOn(JSON, "parse");
		mockState.chunks = [chunk('{"path":"REA'), chunk('DME.md"}'), chunk("", "tool_calls")];
		const events = streamOpenAICompletions(model, context, { apiKey: "test" })[Symbol.asyncIterator]();

		expect((await events.next()).value?.type).toBe("start");
		expect((await events.next()).value?.type).toBe("toolcall_start");
		const firstDelta = (await events.next()).value;
		expect(firstDelta?.type).toBe("toolcall_delta");
		if (!firstDelta) throw new Error("Expected first tool-call delta");

		const partialToolCall = getToolCall(firstDelta);
		expect(Object.getOwnPropertyDescriptor(partialToolCall, "arguments")?.get).toBeTypeOf("function");
		expect(parse).not.toHaveBeenCalledWith('{"path":"REA');
		const partialArguments = partialToolCall.arguments;
		expect(partialArguments).toEqual({ path: "REA" });
		const partialParseCount = parse.mock.calls.filter(([json]) => json === '{"path":"REA').length;
		expect(partialParseCount).toBeGreaterThan(0);
		expect(partialToolCall.arguments).toBe(partialArguments);
		expect(parse.mock.calls.filter(([json]) => json === '{"path":"REA')).toHaveLength(partialParseCount);
		partialArguments.path = "mutated";
		partialToolCall.arguments = { path: "assigned" };
		expect(partialToolCall.arguments).toEqual({ path: "assigned" });

		mockState.releaseAfterFirstChunk?.();
		expect((await events.next()).value?.type).toBe("toolcall_delta");
		const end = (await events.next()).value;
		expect(end?.type).toBe("toolcall_end");
		if (!end || end.type !== "toolcall_end") throw new Error("Expected tool-call end");

		expect(Object.getOwnPropertyDescriptor(end.toolCall, "arguments")?.get).toBeUndefined();
		expect(end.toolCall.arguments).toEqual({ path: "README.md" });
		expect(end.toolCall).toEqual({
			type: "toolCall",
			id: "call_1",
			name: "read",
			arguments: { path: "README.md" },
		});
	});

	it("materializes buffered arguments when the provider stream errors (#9265)", async () => {
		mockState.errorAfterFirstChunk = true;
		mockState.chunks = [chunk('{"path":"REA')];
		const events = streamOpenAICompletions(model, context, { apiKey: "test" })[Symbol.asyncIterator]();

		expect((await events.next()).value?.type).toBe("start");
		expect((await events.next()).value?.type).toBe("toolcall_start");
		expect((await events.next()).value?.type).toBe("toolcall_delta");
		mockState.releaseAfterFirstChunk?.();

		const error = (await events.next()).value;
		expect(error?.type).toBe("error");
		if (!error || error.type !== "error") throw new Error("Expected error event");
		const toolCall = error.error.content.find((content) => content.type === "toolCall");
		if (!toolCall || toolCall.type !== "toolCall") throw new Error("Expected tool call");
		expect(Object.getOwnPropertyDescriptor(toolCall, "arguments")?.get).toBeUndefined();
		expect(toolCall.arguments).toEqual({ path: "REA" });
	});
});
