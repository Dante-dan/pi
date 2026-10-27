/**
 * Output files: files pi writes so the model can use output it was not shown in full, such as the
 * full text of truncated tool output, binary MCP resources, and images shown by codemode scripts.
 * Every output file is created here, so where they are stored can change in one place. Today they
 * go to the OS temp directory.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Output can carry private data, so only the user may read the files. */
const OUTPUT_FILE_MODE = 0o600;

/** A new, unused path: `<dir>/<prefix>-<random hex><extension>`. `extension` includes the dot. */
function createOutputFilePath(prefix: string, extension: string): string {
	return join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}${extension}`);
}

/** Write `data` to a new output file and return its path. */
export async function writeOutputFile(prefix: string, extension: string, data: string | Uint8Array): Promise<string> {
	const path = createOutputFilePath(prefix, extension);
	// `wx` never follows a link someone else placed at the path.
	await writeFile(path, data, { mode: OUTPUT_FILE_MODE, flag: "wx" });
	return path;
}

export interface OutputFileStream {
	/** Unavailable if opening, writing, or flushing the file failed. */
	readonly path: string | undefined;
	write(data: string | Uint8Array): void;
	/** Wait for the file to close, including cleanup after a failed write. */
	close(): Promise<void>;
}

/** Stream output to a file on a best-effort basis; callers keep their in-memory output on failure. */
export function createOutputFileStream(prefix: string, extension: string): OutputFileStream {
	const path = createOutputFilePath(prefix, extension);
	const stream = createWriteStream(path, { mode: OUTPUT_FILE_MODE, flags: "wx" });
	let failed = false;
	let opened = false;
	stream.once("open", () => {
		opened = true;
	});
	// Listen immediately: a disk/quota error can arrive long before the caller closes the stream.
	stream.on("error", () => {
		failed = true;
	});
	const closed = new Promise<void>((resolve) => {
		stream.once("close", async () => {
			if (failed && opened) {
				try {
					await unlink(path);
				} catch {
					// Cleanup is best effort too. Never advertise an incomplete output file.
				}
			}
			resolve();
		});
	});
	return {
		get path() {
			return failed ? undefined : path;
		},
		write(data) {
			if (!failed && !stream.destroyed && !stream.writableEnded) stream.write(data);
		},
		async close() {
			if (!stream.destroyed && !stream.writableEnded) stream.end();
			await closed;
		},
	};
}
