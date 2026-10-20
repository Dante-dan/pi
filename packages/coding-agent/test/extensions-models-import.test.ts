import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	isBundledNode: true,
}));

// This test only uses pi-ai exports, not the application's extension API barrel.
vi.mock("../src/index.ts", () => ({}));

import { loadExtensions } from "../src/core/extensions/loader.ts";

describe("embedded extension models import", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// Regression for #11156: embedded modules must work without a local pi-ai installation.
	it("loads the models subpath and invokes its exported helper", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-models-import-"));
		const extensionPath = path.join(tempDir, "extension.ts");
		fs.writeFileSync(
			extensionPath,
			`
				import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
				export default function(pi) {
					const level = clampThinkingLevel({ reasoning: false }, "high");
					pi.registerCommand(level, { handler: async () => {} });
				}
			`,
		);

		const result = await loadExtensions([extensionPath], tempDir);

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].commands.has("off")).toBe(true);
	});
});
