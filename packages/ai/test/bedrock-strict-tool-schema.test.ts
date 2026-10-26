import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream } from "../src/api/bedrock-converse-stream.ts";
import type { Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

interface ToolPayload {
	toolConfig?: {
		tools: Array<{ toolSpec: { name: string; strict?: boolean; inputSchema: { json: unknown } } }>;
	};
}

const model: Model<"bedrock-converse-stream"> = {
	id: "us.anthropic.claude-opus-5-5",
	name: "Claude Opus 5.5",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 32000,
	compat: { supportsStrictMode: true },
};

function tool(name: string, count: number, strict: "prefer" | "require" = "prefer"): Tool {
	return {
		name,
		description: name,
		parameters: Type.Object(
			Object.fromEntries(Array.from({ length: count }, (_, index) => [`p${index}`, Type.Optional(Type.String())])),
		),
		constrainedSampling: { type: "json_schema", strict },
	};
}

async function capture(tools: Tool[]) {
	let payload: ToolPayload | undefined;
	const result = await stream(
		model,
		normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }], tools }),
		{
			region: "us-east-1",
			cacheRetention: "none",
			onPayload: (value) => {
				payload = value as ToolPayload;
				throw new Error("payload captured before network request");
			},
		},
	).result();
	return { payload, result };
}

// #11416: strict conversion adds one nullable union per optional property.
describe("Bedrock strict tool schema union budget", () => {
	it("falls back to unchanged non-strict schemas above the request budget", async () => {
		const definition = tool("many_optional", 17);
		const original = structuredClone(definition.parameters);
		const { payload } = await capture([definition]);
		expect(payload?.toolConfig?.tools[0].toolSpec).toEqual({
			name: definition.name,
			description: definition.description,
			inputSchema: { json: original },
		});
		expect(definition.parameters).toEqual(original);
	});

	it("keeps strict sampling at the 16-union boundary", async () => {
		const { payload } = await capture([tool("boundary", 16)]);
		expect(payload?.toolConfig?.tools[0].toolSpec.strict).toBe(true);
	});

	it("counts unions across tools and nested object properties", async () => {
		const nested = tool("nested", 0);
		nested.parameters = Type.Object({
			nested: Type.Object(
				Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`p${index}`, Type.Optional(Type.String())])),
			),
		});
		const { payload } = await capture([tool("first", 8), nested]);
		expect(payload?.toolConfig?.tools.map((entry) => entry.toolSpec.strict)).toEqual([undefined, undefined]);
	});

	it("preserves required strict tools while dropping preferred strict sampling", async () => {
		const { payload } = await capture([tool("required", 8, "require"), tool("preferred", 9)]);
		expect(payload?.toolConfig?.tools.map((entry) => entry.toolSpec.strict)).toEqual([true, undefined]);
	});

	it("rejects required strict tools above the budget before sending a request", async () => {
		const { payload, result } = await capture([tool("required", 17, "require")]);
		expect(payload).toBeUndefined();
		expect(result.errorMessage).toContain("required tools have 17");
	});
});
