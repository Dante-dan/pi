import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPipedStdin } from "../src/cli/piped-stdin.ts";

afterEach(() => vi.useRealTimers());

describe("piped stdin", () => {
	// #10415: child-process parents may leave an empty stdin pipe open.
	it("lets a child process exit while its parent keeps stdin open", async () => {
		const moduleUrl = pathToFileURL(resolve(__dirname, "../src/cli/piped-stdin.ts")).href;
		const child = spawn(process.execPath, [
			"--input-type=module",
			"--eval",
			`import { readPipedStdin } from ${JSON.stringify(moduleUrl)}; console.log(await readPipedStdin(process.stdin, "10"));`,
		]);
		let output = "";
		let errors = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			errors += chunk;
		});
		const timeout = setTimeout(() => child.kill(), 10000);
		try {
			const code = await new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("exit", resolve);
			});
			expect(code, errors).toBe(0);
			expect(output.trim()).toBe("undefined");
		} finally {
			clearTimeout(timeout);
			child.kill();
		}
	});

	it("proceeds after the default deadline and releases its listeners", async () => {
		vi.useFakeTimers();
		const stdin = new PassThrough();
		const result = readPipedStdin(stdin);
		await vi.advanceTimersByTimeAsync(2000);
		expect(await result).toBeUndefined();
		expect(stdin.isPaused()).toBe(true);
		expect(stdin.destroyed).toBe(false);
		for (const event of ["data", "end", "error", "close"]) expect(stdin.listenerCount(event)).toBe(0);
	});

	it("honors a configured initial timeout", async () => {
		vi.useFakeTimers();
		const result = readPipedStdin(new PassThrough(), "10");
		await vi.advanceTimersByTimeAsync(10);
		expect(await result).toBeUndefined();
	});

	it.each(["invalid", "-1", "Infinity", "2147483648"])("uses the default for invalid timeout %s", async (timeout) => {
		vi.useFakeTimers();
		const result = readPipedStdin(new PassThrough(), timeout);
		await vi.advanceTimersByTimeAsync(2000);
		expect(await result).toBeUndefined();
	});

	it("waits through EOF after input starts, including slow subsequent chunks", async () => {
		vi.useFakeTimers();
		const stdin = new PassThrough();
		const result = readPipedStdin(stdin, "10");
		stdin.write("first");
		await vi.advanceTimersByTimeAsync(100);
		stdin.end(" second\n");
		expect(await result).toBe("first second");
	});

	it("allows an explicitly unlimited wait for a delayed producer", async () => {
		vi.useFakeTimers();
		const stdin = new PassThrough();
		const result = readPipedStdin(stdin, "0");
		await vi.advanceTimersByTimeAsync(10000);
		stdin.end("delayed");
		expect(await result).toBe("delayed");
	});

	it("handles empty EOF without waiting for the timer", async () => {
		const stdin = new PassThrough();
		const result = readPipedStdin(stdin);
		stdin.end(" \n");
		expect(await result).toBeUndefined();
	});

	it("propagates read errors and releases the timer", async () => {
		const stdin = new PassThrough();
		const result = readPipedStdin(stdin);
		const error = new Error("stdin failed");
		const assertion = expect(result).rejects.toBe(error);
		stdin.destroy(error);
		await assertion;
		expect(stdin.listenerCount("data")).toBe(0);
	});

	it("does not read terminal input", async () => {
		const stdin = Object.assign(new PassThrough(), { isTTY: true });
		expect(await readPipedStdin(stdin)).toBeUndefined();
		expect(stdin.listenerCount("data")).toBe(0);
	});
});
