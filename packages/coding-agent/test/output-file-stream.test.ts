import { WriteStream } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";
import { createOutputFileStream } from "../src/utils/output-files.ts";

afterEach(() => vi.restoreAllMocks());

describe("streamed output files", () => {
	it("flushes the complete output before returning its path", async () => {
		const output = createOutputFileStream("pi-stream-test", ".log");
		try {
			output.write("first\n");
			output.write("last\n");
			await output.close();
			await output.close();
			expect(await readFile(output.path!, "utf8")).toBe("first\nlast\n");
		} finally {
			if (output.path) await rm(output.path, { force: true });
		}
	});

	// #10585: both open failures and later write failures must leave the in-memory output usable.
	it("handles an open failure", async () => {
		const output = createOutputFileStream("pi-missing-directory/stream", ".log");
		output.write("output");
		await output.close();
		expect(output.path).toBeUndefined();
	});

	it.each(["ENOSPC", "EDQUOT", "EFBIG"])("removes an incomplete file after %s while flushing", async (code) => {
		vi.spyOn(WriteStream.prototype, "_write").mockImplementationOnce((_chunk, _encoding, callback) => {
			callback(Object.assign(new Error("write failed"), { code }));
		});
		const output = createOutputFileStream("pi-stream-test", ".log");
		const path = output.path!;
		output.write("output");
		await output.close();
		expect(output.path).toBeUndefined();
		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("handles a write error emitted before close is requested", async () => {
		const failed = new Promise<void>((resolve) => {
			vi.spyOn(WriteStream.prototype, "_write").mockImplementationOnce(function (
				this: WriteStream,
				_chunk,
				_encoding,
				callback,
			) {
				this.once("error", () => resolve());
				callback(Object.assign(new Error("quota exceeded"), { code: "EDQUOT" }));
			});
		});
		const output = createOutputFileStream("pi-stream-test", ".log");
		const path = output.path!;
		output.write("first");
		await failed;
		expect(output.path).toBeUndefined();
		output.write("later");
		await output.close();
		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps the accumulator tail and full-output fallback when spooling fails", async () => {
		vi.spyOn(WriteStream.prototype, "_write").mockImplementationOnce((_chunk, _encoding, callback) => {
			callback(Object.assign(new Error("file too large"), { code: "EFBIG" }));
		});
		const output = new OutputAccumulator({ maxBytes: 16 });
		output.append(Buffer.from(`${"x".repeat(200)}\nlast line\n`));
		output.finish();
		await output.closeTempFile();
		const snapshot = output.snapshot({ persistIfTruncated: true });
		expect(snapshot.fullOutputPath).toBeUndefined();
		expect(snapshot.content).toContain("last line");
		const full = await output.readFullOutput(16);
		expect(full.content).toContain("last line");
		expect(full.truncated).toBe(true);
	});

	it("returns the bash tail without an incomplete file path on write failure", async () => {
		vi.spyOn(WriteStream.prototype, "_write").mockImplementationOnce((_chunk, _encoding, callback) => {
			callback(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
		});
		const result = await executeBashWithOperations("output", process.cwd(), {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from(`${"x".repeat(100_000)}\nlast line\n`));
				return { exitCode: 0 };
			},
		});
		expect(result.exitCode).toBe(0);
		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBeUndefined();
		expect(result.output).toContain("last line");
	});

	it("does not return a path captured before the bash tool finishes flushing", async () => {
		vi.spyOn(WriteStream.prototype, "_write").mockImplementationOnce((_chunk, _encoding, callback) => {
			callback(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
		});
		const tool = createBashTool(process.cwd(), {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from(`${"x".repeat(100_000)}\nlast line\n`));
					return { exitCode: 0 };
				},
			},
		});
		const result = await tool.execute("test-write-failure", { command: "output" });
		const text = result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		expect(text).toContain("last line");
		expect(text).not.toContain("Full output:");
		expect(result.details?.fullOutputPath).toBeUndefined();
	});
});
