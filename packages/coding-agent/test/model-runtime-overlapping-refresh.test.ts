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

async function runtimeWithAnthropic() {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	return { credentials, runtime };
}

// Regression coverage for https://github.com/earendil-works/pi/issues/8810.
describe("issue #8810 overlapping availability refreshes", () => {
	it("coalesces same-turn availability requests into the latest pass", async () => {
		const { credentials, runtime } = await runtimeWithAnthropic();
		const list = vi.spyOn(credentials, "list");

		const first = runtime.getAvailable();
		const second = runtime.getAvailable();
		const third = runtime.getAvailable();

		const [firstModels, secondModels, thirdModels] = await Promise.all([first, second, third]);
		expect(list).toHaveBeenCalledTimes(1);
		expect(firstModels).toEqual(secondModels);
		expect(secondModels).toEqual(thirdModels);
		expect(thirdModels.some((model) => model.provider === "anthropic")).toBe(true);
	});

	it("makes an awaited lifecycle refresh follow a registration-triggered pass", async () => {
		const { credentials, runtime } = await runtimeWithAnthropic();
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
			registrationGate.resolve();
			await lifecycleRefresh;
			expect(lifecycleReturned).toBe(true);
			expect(runtime.hasConfiguredAuth("anthropic")).toBe(true);
			expect(runtime.getAvailableSnapshot().some((model) => model.provider === "anthropic")).toBe(true);
		} finally {
			lifecycleGate.resolve();
			registrationGate.resolve();
			await lifecycleRefresh;
		}
	});

	it("supersedes an older pass when a newer refresh starts preparing models", async () => {
		const { credentials, runtime } = await runtimeWithAnthropic();
		await runtime.getAvailable();
		expect(runtime.hasConfiguredAuth("anthropic")).toBe(true);

		await credentials.delete("anthropic");
		const originalList = credentials.list.bind(credentials);
		const staleStarted = deferred();
		const staleGate = deferred();
		vi.spyOn(credentials, "list").mockImplementationOnce(async () => {
			const entries = await originalList();
			staleStarted.resolve();
			await staleGate.promise;
			return entries;
		});
		const stale = runtime.getAvailable();
		await staleStarted.promise;

		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "new-key" }));
		const internals = runtime as unknown as {
			models: {
				refresh: (options: { allowNetwork: boolean }) => Promise<{ aborted: boolean; errors: Map<string, Error> }>;
			};
		};
		const originalRefresh = internals.models.refresh.bind(internals.models);
		const preparationStarted = deferred();
		const preparationGate = deferred();
		vi.spyOn(internals.models, "refresh").mockImplementationOnce(async (options) => {
			preparationStarted.resolve();
			await preparationGate.promise;
			return originalRefresh(options);
		});
		const latest = runtime.refresh({ allowNetwork: false });
		await preparationStarted.promise;
		let staleReturned = false;
		void stale.then(() => {
			staleReturned = true;
		});
		try {
			staleGate.resolve();
			await setImmediate();
			expect(staleReturned).toBe(false);
			expect(runtime.hasConfiguredAuth("anthropic")).toBe(true);

			preparationGate.resolve();
			await latest;
			expect((await stale).some((model) => model.provider === "anthropic")).toBe(true);
		} finally {
			staleGate.resolve();
			preparationGate.resolve();
			await Promise.allSettled([stale, latest]);
		}
	});

	it("does not wait for a stalled superseded pass or publish its result", async () => {
		const { credentials, runtime } = await runtimeWithAnthropic();
		const originalList = credentials.list.bind(credentials);
		const firstStarted = deferred();
		const firstGate = deferred();
		const firstEntries = await originalList();
		vi.spyOn(credentials, "list")
			.mockImplementationOnce(async () => {
				firstStarted.resolve();
				await firstGate.promise;
				return [];
			})
			.mockResolvedValueOnce(firstEntries);
		const first = runtime.getAvailable();
		await firstStarted.promise;
		const second = runtime.getAvailable();
		try {
			const [firstModels, secondModels] = await Promise.all([first, second]);
			expect(firstModels).toEqual(secondModels);
			expect(secondModels.some((model) => model.provider === "anthropic")).toBe(true);
			expect(runtime.hasConfiguredAuth("anthropic")).toBe(true);

			firstGate.resolve();
			await setImmediate();
			expect(runtime.hasConfiguredAuth("anthropic")).toBe(true);
			expect(runtime.getAvailableSnapshot()).toEqual(secondModels);
		} finally {
			firstGate.resolve();
			await Promise.allSettled([first, second]);
		}
	});

	it("does not let the latest caller cancel the shared pass for older waiters", async () => {
		const { credentials, runtime } = await runtimeWithAnthropic();
		const originalList = credentials.list.bind(credentials);
		const firstStarted = deferred();
		const latestStarted = deferred();
		const firstGate = deferred();
		const latestGate = deferred();
		vi.spyOn(credentials, "list")
			.mockImplementationOnce(async () => {
				firstStarted.resolve();
				await firstGate.promise;
				return originalList();
			})
			.mockImplementationOnce(async () => {
				latestStarted.resolve();
				await latestGate.promise;
				return originalList();
			});
		const follower = runtime.getAvailable();
		await firstStarted.promise;
		const controller = new AbortController();
		const latestCaller = runtime.getAvailable(undefined, { signal: controller.signal });
		await latestStarted.promise;
		const rejection = expect(latestCaller).rejects.toThrow("stop waiting");
		let followerReturned = false;
		void follower.then(() => {
			followerReturned = true;
		});
		controller.abort(new Error("stop waiting"));
		try {
			await rejection;
			await setImmediate();
			expect(followerReturned).toBe(false);
			latestGate.resolve();
			expect((await follower).some((model) => model.provider === "anthropic")).toBe(true);
		} finally {
			firstGate.resolve();
			latestGate.resolve();
			await Promise.allSettled([latestCaller, follower]);
		}
	});

	it("makes all waiters observe the latest pass failure", async () => {
		const { credentials, runtime } = await runtimeWithAnthropic();
		const firstStarted = deferred();
		const firstGate = deferred();
		vi.spyOn(credentials, "list")
			.mockImplementationOnce(async () => {
				firstStarted.resolve();
				await firstGate.promise;
				return [];
			})
			.mockRejectedValueOnce(new Error("latest pass failed"));
		const first = runtime.getAvailable();
		await firstStarted.promise;
		const second = runtime.getAvailable();
		try {
			await Promise.all([
				expect(first).rejects.toThrow("latest pass failed"),
				expect(second).rejects.toThrow("latest pass failed"),
			]);
			expect(runtime.getError()).toContain("latest pass failed");
		} finally {
			firstGate.resolve();
			await Promise.allSettled([first, second]);
		}
	});
});
