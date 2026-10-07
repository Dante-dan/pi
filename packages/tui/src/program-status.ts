/** Root-record Program Status Protocol (OSC 7501). */
export interface ProgramStatus {
	state: "idle" | "working" | "done" | "blocked" | "error" | "clear";
	app?: string;
	kind?: "question" | "permission" | "auth";
	msg?: string;
}

export const PROGRAM_STATUS_QUERY = "\x1b]7501;?\x1b\\";

export function encodeProgramStatus(status: ProgramStatus): string {
	const pairs = [`state=${status.state}`];
	if (status.app && /^[A-Za-z0-9_.+-]{1,32}$/.test(status.app)) pairs.push(`app=${status.app}`);
	if (status.state === "blocked" && status.kind) pairs.push(`kind=${status.kind}`);
	if (status.msg !== undefined) {
		// The specification caps decoded msg at 2048 bytes. Truncate at UTF-8 boundaries.
		let msg = "";
		let bytes = 0;
		for (const char of status.msg) {
			const code = char.codePointAt(0)!;
			if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
			const size = Buffer.byteLength(char, "utf8");
			if (bytes + size > 2048) break;
			msg += char;
			bytes += size;
		}
		pairs.push(`msg=${Buffer.from(msg, "utf8").toString("base64")}`);
	}
	return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}
