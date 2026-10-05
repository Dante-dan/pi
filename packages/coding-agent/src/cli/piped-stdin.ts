import type { Readable } from "node:stream";

/** Wait for the first piped input briefly, then read through EOF without a deadline. */
export async function readPipedStdin(
	stdin: Readable & { isTTY?: boolean } = process.stdin,
	rawTimeout = process.env.PI_STDIN_TIMEOUT_MS,
): Promise<string | undefined> {
	if (stdin.isTTY || stdin.readableEnded || stdin.destroyed) return undefined;

	const configuredTimeout = rawTimeout === undefined ? 2000 : Number(rawTimeout);
	const timeoutMs =
		Number.isInteger(configuredTimeout) && configuredTimeout >= 0 && configuredTimeout <= 2_147_483_647
			? configuredTimeout
			: 2000;

	return new Promise((resolve, reject) => {
		let data = "";
		let timer: NodeJS.Timeout | undefined;
		const cleanup = () => {
			clearTimeout(timer);
			stdin.off("data", onData);
			stdin.off("end", onEnd);
			stdin.off("error", onError);
			stdin.off("close", onEnd);
			stdin.pause();
		};
		const onData = (chunk: string) => {
			// Once input starts, even slow producers must be allowed to finish.
			clearTimeout(timer);
			data += chunk;
		};
		const onEnd = () => {
			cleanup();
			resolve(data.trim() || undefined);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		stdin.setEncoding("utf8");
		stdin.on("data", onData);
		stdin.once("end", onEnd);
		stdin.once("error", onError);
		stdin.once("close", onEnd);
		// Zero explicitly preserves waiting indefinitely for a delayed producer.
		if (timeoutMs > 0) timer = setTimeout(onEnd, timeoutMs);
		stdin.resume();
	});
}
