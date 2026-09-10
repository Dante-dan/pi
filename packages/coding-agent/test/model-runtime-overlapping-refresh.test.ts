import { setImmediate } from "node:timers/promises";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function overlapRefreshes(signal?: AbortSignal) {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	const originalList = credentials.list.bind(credentials);
	const firstStarted = deferred();
	const secondStarted = deferred();
	const firstGate = deferred();
	const secondGate = deferred();
	vi.spyOn(credentials, "list")
		.mockImplementationOnce(async () => {
			const entries = await originalList();
			firstStarted.resolve();
			await firstGate.promise;
			return entries;
		})
		.mockImplementationOnce(async () => {
			const entries = await originalList();
			secondStarted.resolve();
			await secondGate.promise;
			return entries;
		});
	const first = runtime.getAvailable(undefined, { signal });
	await firstStarted.promise;
	const second = runtime.getAvailable();
	await secondStarted.promise;
	return { runtime, first, second, firstGate, secondGate };
}

describe("issue #8810 overlapping availability refreshes", () => {
	it("does not return a stale snapshot when a newer availability pass is still running", async () => {
		const { runtime, first, second, firstGate, secondGate } = await overlapRefreshes();
		let firstReturned = false;
		void first.then(() => {
			firstReturned = true;
		});
		try {
			firstGate.resolve();
			await setImmediate();
			expect(firstReturned).toBe(false);
			secondGate.resolve();
			const [firstModels, secondModels] = await Promise.all([first, second]);
			expect(firstModels).toEqual(secondModels);
			expect(firstModels.some((model) => model.provider === "anthropic")).toBe(true);
			expect(runtime.hasConfiguredAuth("anthropic")).toBe(true);
		} finally {
			firstGate.resolve();
			secondGate.resolve();
			await Promise.allSettled([first, second]);
		}
	});

	it("allows an older waiter to cancel without cancelling the newer pass", async () => {
		const controller = new AbortController();
		const { runtime, first, second, firstGate, secondGate } = await overlapRefreshes(controller.signal);
		try {
			firstGate.resolve();
			await setImmediate();
			const rejected = expect(first).rejects.toThrow("cancel old waiter");
			controller.abort(new Error("cancel old waiter"));
			await rejected;
			secondGate.resolve();
			expect((await second).some((model) => model.provider === "anthropic")).toBe(true);
			expect(runtime.hasConfiguredAuth("anthropic")).toBe(true);
		} finally {
			firstGate.resolve();
			secondGate.resolve();
			await Promise.allSettled([first, second]);
		}
	});
});
