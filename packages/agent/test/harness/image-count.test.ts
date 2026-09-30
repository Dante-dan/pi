import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../../src/harness/compaction/compaction.ts";
import { countImages, imageCountLimit } from "../../src/harness/compaction/image-count.ts";
import type { Entry } from "../../src/harness/session/types.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import type { AgentMessage } from "../../src/types.ts";

function imageMessage(count: number): AgentMessage {
	return {
		role: "user",
		content: Array.from({ length: count }, () => ({ type: "image" as const, data: "", mimeType: "image/png" })),
		timestamp: 1,
	};
}

function entries(messages: AgentMessage[]): Entry[] {
	return messages.map((message, index) => ({
		type: "message",
		id: `entry-${index}`,
		parentId: index === 0 ? null : `entry-${index - 1}`,
		seq: index + 1,
		timestamp: 1,
		message,
	}));
}

// Regression: https://github.com/earendil-works/pi/issues/10162
describe("image-count recovery preparation", () => {
	it.each([
		[31, 30],
		[7, 4],
	])("parses explicit provider count %i > %i", (count, limit) => {
		expect(imageCountLimit(`400: Too many images in request: ${count} > ${limit}`)).toBe(limit);
	});

	it.each([
		"400: invalid request",
		"Too many images in request: 4 > 4",
		"Too many images in request: 1 > 0",
		"Too many images",
	])("leaves unsupported errors unchanged: %s", (error) => {
		expect(imageCountLimit(error)).toBeUndefined();
	});

	it.each([30, 4])("reduces an image-heavy retained tail below %i without mutating history", (limit) => {
		const history = entries([imageMessage(limit), imageMessage(2), imageMessage(1)]);
		const original = JSON.stringify(history);
		const prepared = getOrThrow(
			prepareCompaction(history, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1_000_000 }, limit),
		);
		expect(prepared).toBeDefined();
		expect(countImages(prepared!.retainedTail)).toBe(3);
		expect(prepared!.messagesToSummarize).toEqual([history[0].type === "message" ? history[0].message : undefined]);
		expect(JSON.stringify(history)).toBe(original);
	});

	it("declines recovery when the last indivisible message exceeds the limit", () => {
		expect(
			getOrThrow(prepareCompaction(entries([imageMessage(1), imageMessage(31)]), DEFAULT_COMPACTION_SETTINGS, 30)),
		).toBeUndefined();
	});
});
