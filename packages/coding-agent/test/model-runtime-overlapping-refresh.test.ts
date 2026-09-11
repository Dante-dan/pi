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

// Regression coverage for https://github.com/earendil-works/pi/issues/8810.
describe("issue #8810 overlapping availability refreshes", () => {
	it("makes an awaited lifecycle refresh follow a registration-triggered pass", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		const provider = runtime.getProvider("anthropic");
		expect(provider).toBeDefined();
		const originalList = credentials.list.bind(credentials);
		const lifecycleStarted = deferred();
		const registrationStarted = deferred();
		const lifecycleGate = deferred();
		const registrationGate = deferred();
		vi.spyOn(credentials, "list")
			.mockImplementationOnce(async () => {
				const entries = await originalList();
				lifecycleStarted.resolve();
				await lifecycleGate.promise;
				return entries;
			})
			.mockImplementationOnce(async () => {
				const entries = await originalList();
				registrationStarted.resolve();
				await registrationGate.promise;
				return entries;
			});
		const lifecycleRefresh = runtime.refresh({ allowNetwork: false });
		await lifecycleStarted.promise;
		runtime.registerNativeProvider(provider!);
		await registrationStarted.promise;
		let lifecycleReturned = false;
		void lifecycleRefresh.then(() => {
			lifecycleReturned = true;
		});
		try {
			lifecycleGate.resolve();
			await setImmediate();
			expect(lifecycleReturned).toBe(false);
			registrationGate.resolve();
			await lifecycleRefresh;
			expect(runtime.hasConfiguredAuth("anthropic")).toBe(true);
			expect(runtime.getAvailableSnapshot().some((model) => model.provider === "anthropic")).toBe(true);
		} finally {
			lifecycleGate.resolve();
			registrationGate.resolve();
			await lifecycleRefresh;
		}
	});

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

	it("does not propagate a newer caller's cancellation to an independent older waiter", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		const originalList = credentials.list.bind(credentials);
		const firstGate = deferred();
		const secondGate = deferred();
		vi.spyOn(credentials, "list")
			.mockImplementationOnce(async () => {
				await firstGate.promise;
				return originalList();
			})
			.mockImplementationOnce(async () => {
				await secondGate.promise;
				return originalList();
			});
		const first = runtime.getAvailable();
		const controller = new AbortController();
		const second = runtime.getAvailable(undefined, { signal: controller.signal });
		const secondRejected = expect(second).rejects.toThrow("cancel newer caller");
		try {
			firstGate.resolve();
			await setImmediate();
			controller.abort(new Error("cancel newer caller"));
			secondGate.resolve();
			await secondRejected;
			expect((await first).some((model) => model.provider === "anthropic")).toBe(true);
			expect(runtime.hasConfiguredAuth("anthropic")).toBe(true);
		} finally {
			firstGate.resolve();
			secondGate.resolve();
			await Promise.allSettled([first, second]);
		}
	});

	it("follows the latest successful pass when an intermediate pass fails", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		const originalList = credentials.list.bind(credentials);
		const firstGate = deferred();
		const secondGate = deferred();
		vi.spyOn(credentials, "list")
			.mockImplementationOnce(async () => {
				await firstGate.promise;
				return originalList();
			})
			.mockImplementationOnce(async () => {
				await secondGate.promise;
				throw new Error("intermediate pass failed");
			});
		const first = runtime.getAvailable();
		const second = runtime.getAvailable();
		const secondRejected = expect(second).rejects.toThrow("intermediate pass failed");
		try {
			firstGate.resolve();
			await setImmediate();
			const newest = await runtime.getAvailable();
			secondGate.resolve();
			await secondRejected;
			expect(await first).toEqual(newest);
			expect(newest.some((model) => model.provider === "anthropic")).toBe(true);
		} finally {
			firstGate.resolve();
			secondGate.resolve();
			await Promise.allSettled([first, second]);
		}
	});

	it("reports its own recovery failure instead of retrying a persistent failure indefinitely", async () => {
		const credentials = new InMemoryCredentialStore();
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		const firstGate = deferred();
		const secondGate = deferred();
		const list = vi
			.spyOn(credentials, "list")
			.mockImplementationOnce(async () => {
				await firstGate.promise;
				return [];
			})
			.mockImplementationOnce(async () => {
				await secondGate.promise;
				throw new Error("newer pass failed");
			})
			.mockRejectedValue(new Error("own recovery failed"));
		const first = runtime.getAvailable();
		const second = runtime.getAvailable();
		const firstRejected = expect(first).rejects.toThrow("own recovery failed");
		const secondRejected = expect(second).rejects.toThrow("newer pass failed");
		try {
			firstGate.resolve();
			await setImmediate();
			secondGate.resolve();
			await Promise.all([firstRejected, secondRejected]);
			expect(list).toHaveBeenCalledTimes(3);
		} finally {
			firstGate.resolve();
			secondGate.resolve();
			await Promise.allSettled([first, second]);
		}
	});
});
