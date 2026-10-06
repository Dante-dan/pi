import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/harness/compaction.ts";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("serializeConversation", () => {
	// #9602: compaction must not reintroduce unbounded thinking-only retries.
	it("bounds thinking-only messages across blocks and preserves both ends", () => {
		const message = assistant([
			{ type: "thinking", thinking: "a".repeat(1000) + "x".repeat(10000) },
			{ type: "thinking", thinking: "y".repeat(10000) + "z".repeat(1000) },
			{ type: "text", text: "" },
		]);
		const result = serializeConversation([message, message, message, message]);
		expect(result).toContain(`[Assistant thinking]: ${"a".repeat(1000)}`);
		expect(result).toContain(`[... 20001 more characters truncated]\n\n${"z".repeat(1000)}`);
		expect(result).not.toContain("x".repeat(1000));
		expect(result).not.toContain("y".repeat(1000));
		expect(result.length).toBeLessThan(8500);
	});

	// #9602: short thinking and thinking accompanying visible output retain their contents.
	it("preserves short thinking and long thinking with text or tool calls", () => {
		for (const length of [1999, 2000, 2001]) {
			const result = serializeConversation([assistant([{ type: "thinking", thinking: "s".repeat(length) }])]);
			expect(result.includes("truncated")).toBe(length > 2000);
			if (length <= 2000) expect(result).toBe(`[Assistant thinking]: ${"s".repeat(length)}`);
		}
		const thinking = "t".repeat(5000);
		const text = "v".repeat(5000);
		const result = serializeConversation([
			assistant([
				{ type: "thinking", thinking },
				{ type: "text", text },
			]),
			assistant([
				{ type: "thinking", thinking },
				{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "file.ts" } },
			]),
		]);
		expect(result).not.toContain("truncated");
		expect(result).toContain(`[Assistant thinking]: ${thinking}`);
		expect(result).toContain(`[Assistant]: ${text}`);
		expect(result).toContain('[Assistant tool calls]: read(path="file.ts")');
	});
});
