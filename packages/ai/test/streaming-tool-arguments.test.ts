import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, ToolCall } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { parseStreamingJson } from "../src/utils/json-parse.ts";
import { createPendingToolCall } from "../src/utils/pending-tool-call.ts";

function toolCall(): ToolCall {
	return { type: "toolCall", id: "call_test", name: "write", arguments: {} };
}

afterEach(() => vi.restoreAllMocks());

// Regression coverage for #9265: delta consumers get structured snapshots without reparsing growing prefixes.
describe("pending tool calls", () => {
	it("incrementally parses a large streamed argument and reparses only at settlement", () => {
		const pending = createPendingToolCall(toolCall());
		const block = pending.toolCall;
		const parse = vi.spyOn(JSON, "parse");
		let json = '{"content":"';
		pending.appendJson(json);
		for (let i = 0; i < 128; i++) {
			const delta = "a".repeat(8192);
			json += delta;
			pending.appendJson(delta);
			expect(block.arguments.content).toHaveLength((i + 1) * 8192);
		}
		json += '"}';
		pending.appendJson('"}');
		expect(parse).not.toHaveBeenCalled();

		const args = block.arguments;
		expect(args.content).toHaveLength(1024 * 1024);
		expect(block.arguments).toBe(args);
		expect(parse).not.toHaveBeenCalled();
		pending.finishFromJson();
		expect(pending.toolCall).toBe(block);
		expect(parse).toHaveBeenCalledExactlyOnceWith(json);
		expect(Object.getOwnPropertyDescriptor(block, "arguments")).toEqual({
			value: args,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	});

	it.each([
		undefined,
		"",
		"not json",
		"null",
		"false",
		"0",
		'""',
		'{"path":"a.txt","content":"hel',
		'{"nested":{"items":[1,true,{"value":"par',
		'{"content":"line1\nline2',
		String.raw`{"path":"A\H","content":"\uD83D`,
	])("preserves best-effort final parsing for %j", (json) => {
		const pending = createPendingToolCall(toolCall());
		const expected = parseStreamingJson(json);
		pending.setJson(json);
		pending.finishFromJson();
		expect(pending.toolCall.arguments).toEqual(expected);
	});

	it("emits nested snapshots without mutating previously read arguments", () => {
		const pending = createPendingToolCall(toolCall());
		pending.appendJson('{"path":"a.ts","content":"hel');
		const first = pending.toolCall.arguments;
		expect(first).toEqual({ path: "a.ts", content: "hel" });
		pending.appendJson('lo","nested":{"items":[1,"tw');
		expect(pending.toolCall.arguments).toEqual({
			path: "a.ts",
			content: "hello",
			nested: { items: [1, "tw"] },
		});
		expect(first).toEqual({ path: "a.ts", content: "hel" });
		expect(pending.toolCall.arguments).not.toBe(first);
	});

	it("handles escapes split across chunks", () => {
		const pending = createPendingToolCall(toolCall());
		pending.appendJson(String.raw`{"content":"\uD83D`);
		expect(pending.toolCall.arguments).toEqual({ content: "" });
		pending.appendJson(String.raw`\uDE00"}`);
		expect(pending.toolCall.arguments).toEqual({ content: "😀" });
	});

	it("isolates snapshots emitted at container boundaries", () => {
		const pending = createPendingToolCall(toolCall());
		pending.appendJson("{");
		const root = pending.toolCall.arguments;
		pending.appendJson('"nested":{');
		const nested = pending.toolCall.arguments;
		pending.appendJson('"items":[');
		const items = pending.toolCall.arguments;
		pending.appendJson('1,{"value":"two"}]}}');

		expect(root).toEqual({});
		expect(nested).toEqual({ nested: {} });
		expect(items).toEqual({ nested: { items: [] } });
		expect(pending.toolCall.arguments).toEqual({ nested: { items: [1, { value: "two" }] } });
	});

	it("freezes malformed realtime input but repairs the provider buffer at settlement", () => {
		const pending = createPendingToolCall(toolCall());
		pending.appendJson('{"path":"a.txt","content":"valid');
		const lastValid = pending.toolCall.arguments;
		pending.appendJson("\nline2");
		expect(pending.toolCall.arguments).toBe(lastValid);
		pending.appendJson('"}');
		expect(pending.toolCall.arguments).toBe(lastValid);

		pending.finishFromJson();
		expect(pending.toolCall.arguments).toEqual({ path: "a.txt", content: "valid\nline2" });
	});

	it("keeps arrays correct at settlement", () => {
		const pending = createPendingToolCall(toolCall());
		for (const delta of ['{"items":[', "1,", '{"nested":[true,', '"two"]}', "]}"]) pending.appendJson(delta);
		pending.finishFromJson();
		expect(pending.toolCall.arguments).toEqual({ items: [1, { nested: [true, "two"] }] });
	});

	it("accepts authoritative assignments without parsing the discarded prefix", () => {
		const pending = createPendingToolCall(toolCall());
		const block = pending.toolCall;
		const parse = vi.spyOn(JSON, "parse");
		pending.setJson('{"content":"discarded');
		const authoritative = { content: "replacement" };
		Object.assign(block, { arguments: authoritative, namespace: "tools" });
		pending.finish();
		expect(block.arguments).toBe(authoritative);
		expect(block.namespace).toBe("tools");
		expect(parse).not.toHaveBeenCalled();
		expect(Object.getOwnPropertyDescriptor(block, "arguments")?.get).toBeUndefined();
	});

	it("materializes provider JSON after a streaming consumer changes the snapshot", () => {
		const pending = createPendingToolCall(toolCall());
		const block = pending.toolCall;
		pending.setJson('{"content":"provider');
		const partial = block.arguments;
		partial.content = "mutated";
		block.arguments = { content: "assigned" };

		pending.finishFromJson();

		expect(block.arguments).toEqual({ content: "provider" });
		expect(Object.getOwnPropertyDescriptor(block, "arguments")).toMatchObject({
			value: { content: "provider" },
			writable: true,
		});
	});

	it("keeps interleaved calls independent", () => {
		const first = createPendingToolCall(toolCall());
		const second = createPendingToolCall(toolCall());
		first.appendJson('{"content":"one');
		second.appendJson('{"content":"two');
		expect(second.toolCall.arguments).toEqual({ content: "two" });
		first.appendJson(' more"}');
		expect(first.toolCall.arguments).toEqual({ content: "one more" });
		expect(second.toolCall.arguments).toEqual({ content: "two" });
	});

	it("supports serialization, spreading, and structured cloning during streaming", () => {
		const pending = createPendingToolCall(toolCall());
		const block = pending.toolCall;
		pending.appendJson('{"content":"partial');
		expect(JSON.parse(JSON.stringify(block)).arguments).toEqual({ content: "partial" });
		pending.appendJson(" updated");
		expect({ ...block }.arguments).toEqual({ content: "partial updated" });
		pending.appendJson(" cloned");
		expect(structuredClone(block).arguments).toEqual({ content: "partial updated cloned" });
	});

	it("shares a cached parse between proxy copies but keeps updates and assignments independent", () => {
		const pending = createPendingToolCall(toolCall());
		pending.appendJson('{"content":"copied"}');
		const parse = vi.spyOn(JSON, "parse");
		const copy = pending.copy();
		expect(parse).not.toHaveBeenCalled();
		expect(copy.toolCall).not.toBe(pending.toolCall);
		expect(copy.toolCall.arguments).toEqual({ content: "copied" });
		expect(pending.toolCall.arguments).toBe(copy.toolCall.arguments);
		expect(parse).not.toHaveBeenCalled();
		const replacement = { content: "authoritative" };
		copy.toolCall.arguments = replacement;
		expect(copy.toolCall.arguments).toBe(replacement);
		expect(pending.toolCall.arguments).toEqual({ content: "copied" });
		copy.setJson('{"content":"next"}');
		expect(copy.toolCall.arguments).toEqual({ content: "next" });
		expect(pending.toolCall.arguments).toEqual({ content: "copied" });
	});

	it("lets copied parser views diverge from the same prefix", () => {
		const first = createPendingToolCall(toolCall());
		first.appendJson('{"content":"a');
		const second = first.copy();
		first.appendJson('b"}');
		second.appendJson('c"}');
		expect(first.toolCall.arguments).toEqual({ content: "ab" });
		expect(second.toolCall.arguments).toEqual({ content: "ac" });
	});

	it("resets incremental state for authoritative replacements", () => {
		const pending = createPendingToolCall(toolCall());
		pending.appendJson('{"content":"long partial');
		pending.setJson('{"path":"short"}');
		expect(pending.toolCall.arguments).toEqual({ path: "short" });
		pending.finishFromJson();
		expect(pending.toolCall.arguments).toEqual({ path: "short" });
	});

	it("keeps special object keys as data properties", () => {
		const pending = createPendingToolCall(toolCall());
		pending.appendJson('{"__proto__":{"polluted":true},"constructor":"value"}');
		const args = pending.toolCall.arguments;
		expect(Object.prototype).not.toHaveProperty("polluted");
		expect(Object.getOwnPropertyDescriptor(args, "__proto__")?.value).toEqual({ polluted: true });
		expect(args.constructor).toBe("value");
	});

	it("keeps initial arguments when no JSON stream was supplied", () => {
		const initial = { type: "toolCall", id: "call", name: "custom", arguments: { input: "hello" } } as ToolCall;
		const pending = createPendingToolCall(initial);
		pending.finishFromJson();
		expect(pending.toolCall.arguments).toEqual({ input: "hello" });
	});

	it("copies enumerable metadata, including symbols, with the proxy's original spread semantics", () => {
		const pending = createPendingToolCall(toolCall());
		pending.setJson('{"content":"unread');
		const symbol = Symbol("metadata");
		const metadata = { tag: "extension" };
		Object.assign(pending.toolCall, { extra: metadata, [symbol]: metadata });
		const getter = vi.fn(() => "computed");
		Object.defineProperty(pending.toolCall, "computed", { enumerable: true, get: getter });
		Object.defineProperty(pending.toolCall, "hidden", { value: "private" });
		const parse = vi.spyOn(JSON, "parse");
		const copy = pending.copy().toolCall;
		expect(parse).not.toHaveBeenCalled();
		expect(Reflect.get(copy, "extra")).toBe(metadata);
		expect(Reflect.get(copy, symbol)).toBe(metadata);
		expect(Object.getOwnPropertyDescriptor(copy, "computed")).toMatchObject({ value: "computed", writable: true });
		expect(getter).toHaveBeenCalledTimes(1);
		expect(getter.mock.contexts[0]).toBe(pending.toolCall);
		expect(copy).not.toHaveProperty("hidden");
	});

	it.each(["toolUse", "error", "aborted"] as const)(
		"lets the provider materialize unread arguments before %s settlement",
		async (reason) => {
			const pending = createPendingToolCall(toolCall());
			const block = pending.toolCall;
			pending.setJson('{"content":"interrupted');
			// #9265: the event stream must not inspect unrelated custom-provider getters.
			const foreign = toolCall();
			const foreignGetter = vi.fn(() => {
				throw new Error("Custom provider getter must not be read");
			});
			Object.defineProperty(foreign, "arguments", { get: foreignGetter });
			const message: AssistantMessage = {
				role: "assistant",
				content: [block, foreign],
				api: "openai-completions",
				provider: "test",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: reason,
				timestamp: 0,
			};
			const stream = new AssistantMessageEventStream();
			pending.finish();
			stream.push(
				reason === "toolUse" ? { type: "done", reason, message } : { type: "error", reason, error: message },
			);
			expect(Object.getOwnPropertyDescriptor(block, "arguments")).toMatchObject({
				value: { content: "interrupted" },
				writable: true,
			});
			expect(await stream.result()).toBe(message);
			expect(foreignGetter).not.toHaveBeenCalled();
			expect(Object.getOwnPropertyDescriptor(foreign, "arguments")?.get).toBe(foreignGetter);
		},
	);
});
