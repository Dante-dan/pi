import { expect, it } from "vitest";
import { getBuiltinModel, getBuiltinModels } from "../src/providers/all.ts";

it("only exposes current China Coding Plan models", () => {
	// https://github.com/earendil-works/pi/issues/9616
	expect(getBuiltinModels("zai-coding-cn").map((model) => model.id)).toEqual(["glm-5.3", "glm-5.3-flash"]);
});

it("uses API-equivalent reference costs for Coding Plan models", () => {
	expect(getBuiltinModel("zai", "glm-5.2").cost).toEqual({
		input: 1.4,
		output: 4.4,
		cacheRead: 0.26,
		cacheWrite: 0,
	});
	for (const provider of ["zai", "zai-coding-cn"] as const) {
		expect(getBuiltinModel(provider, "glm-5.3").cost).toEqual({
			input: 1.4,
			output: 4.4,
			cacheRead: 0.26,
			cacheWrite: 0,
		});
	}
});

it("keeps zero costs for global Coding Plan models without a matching API price", () => {
	const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

	expect(getBuiltinModel("zai", "glm-5.2-highspeed").cost).toEqual(zeroCost);
});
