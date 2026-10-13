import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";

function identity(pid: number): string | undefined {
	const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "pid=,ppid=,pgid=,lstart=,command="], {
		encoding: "utf8",
	});
	if (result.error) throw result.error;
	if (result.status === 1 && !result.stdout.trim() && !result.stderr.trim()) return undefined;
	if (result.status !== 0) throw new Error(`Real ps failed: ${result.stderr}`);
	return result.stdout.trim();
}

function quote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// #10797: interrupted foreground children can have a different process group.
describe.skipIf(process.platform === "win32")("Unix detached bash descendants", () => {
	for (const mode of ["timeout", "abort", "success"] as const) {
		it(`${mode}: preserves only deliberately successful background services`, async () => {
			const directory = mkdtempSync(join(tmpdir(), "pi-10797-"));
			const marker = `pi-10797-${randomUUID()}`;
			const pidFile = join(directory, "child.pid");
			const launcher = join(directory, "launcher.cjs");
			writeFileSync(
				launcher,
				`const {spawn}=require('node:child_process');
const fs=require('node:fs');
const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)',${JSON.stringify(marker)}],{detached:true,stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
child.unref();
${mode === "success" ? "" : "setTimeout(()=>{},30000);"}
`,
			);
			const controller = new AbortController();
			let childPid: number | undefined;
			let before: string | undefined;
			try {
				const command = `${quote(process.execPath)} ${quote(launcher)}`;
				const pending = createBashTool(directory).execute(
					"10797",
					{ command, ...(mode === "timeout" ? { timeout: 3 } : {}) },
					controller.signal,
				);
				const observed = pending.then(
					() => undefined,
					(error: unknown) => error,
				);
				for (let attempt = 0; attempt < 100; attempt++) {
					try {
						childPid = Number(readFileSync(pidFile, "utf8"));
						break;
					} catch {
						await new Promise((resolve) => setTimeout(resolve, 20));
					}
				}
				expect(childPid).toBeGreaterThan(0);
				before = identity(childPid!);
				expect(before).toContain(marker);
				expect(Number(before!.split(/\s+/)[2])).toBe(childPid);
				if (mode !== "success") {
					const parentPid = Number(before!.split(/\s+/)[1]);
					expect(parentPid).toBeGreaterThan(1);
					const parent = identity(parentPid);
					expect(parent).toContain(launcher);
					expect(Number(parent!.split(/\s+/)[2])).not.toBe(childPid);
					console.log({ mode, parent });
				}
				console.log({ mode, before });
				if (mode === "abort") controller.abort();
				const error = await observed;
				if (mode === "success") expect(error).toBeUndefined();
				else expect(error).toBeInstanceOf(Error);
				const after = identity(childPid!);
				console.log({ mode, after });
				if (mode === "success") expect(after).toContain(marker);
				else expect(after).toBeUndefined();
			} finally {
				controller.abort();
				if (childPid && before) {
					const current = identity(childPid);
					// Match the unique command and original start time; never signal a reused PID.
					if (
						current?.includes(marker) &&
						current.split(/\s+/).slice(3).join(" ") === before.split(/\s+/).slice(3).join(" ")
					) {
						process.kill(childPid, "SIGKILL");
						for (let attempt = 0; attempt < 100 && identity(childPid); attempt++) {
							await new Promise((resolve) => setTimeout(resolve, 20));
						}
						expect(identity(childPid), "Marked fixture cleanup did not finish").toBeUndefined();
					}
				}
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}
});
