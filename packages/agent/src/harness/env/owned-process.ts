import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleRequire = createRequire(import.meta.url);
const ownedProcesses = new Map<number, OwnedProcess>();

export interface OwnedProcess {
	child: ChildProcess;
	terminate(): Promise<void>;
}

function windowsLauncher(): string {
	const relative = join("native", "win32", "prebuilds", `win32-${process.arch}`, "pi-process-job.exe");
	const candidates = [
		join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", relative),
		join(dirname(process.execPath), relative),
	];
	try {
		candidates.unshift(join(dirname(moduleRequire.resolve("@earendil-works/pi-agent-core/package.json")), relative));
	} catch {
		// Standalone distributions place native assets next to the executable.
	}
	const launcher = candidates.find((candidate) => existsSync(candidate));
	if (!launcher)
		throw new Error(`Windows process helper is missing for ${process.arch}. Reinstall pi with its native assets.`);
	return launcher;
}

/** Process ownership is established before the Windows shell can create children. */
export function spawnOwnedProcess(command: string, args: string[], options: SpawnOptions): OwnedProcess {
	const launcher = process.platform === "win32" ? windowsLauncher() : undefined;
	const id = randomUUID();
	const child = launcher
		? spawn(launcher, ["--run", id, String(process.pid), command, ...args], options)
		: spawn(command, args, options);
	let termination: Promise<void> | undefined;
	const owned: OwnedProcess = {
		child,
		terminate: () => {
			if (termination) return termination;
			if (!child.pid) return Promise.resolve();
			if (!launcher) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					try {
						process.kill(child.pid, "SIGKILL");
					} catch {
						// The child has already exited.
					}
				}
				return Promise.resolve();
			}
			if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
			const pid = child.pid;
			termination = new Promise<void>((resolve, reject) => {
				const cancellation = spawn(launcher, ["--cancel", id, String(pid)], {
					stdio: ["ignore", "ignore", "pipe"],
					detached: true,
					windowsHide: true,
				});
				let stderr = "";
				cancellation.stderr?.on("data", (data: Buffer) => {
					stderr = (stderr + data.toString()).slice(-4096);
				});
				const fail = (error: Error) => {
					// Closing the launcher's last job handle still contains descendants
					// if the cancellation helper cannot signal or verify the normal path.
					child.kill("SIGKILL");
					reject(error);
				};
				cancellation.once("error", fail);
				cancellation.once("close", (code) => {
					if (code === 0) resolve();
					else fail(new Error(stderr.trim() || `Windows process cancellation failed (${code})`));
				});
			});
			return termination;
		},
	};
	if (child.pid) {
		const pid = child.pid;
		ownedProcesses.set(pid, owned);
		child.once("close", () => ownedProcesses.delete(pid));
	}
	return owned;
}

/** Returns undefined for children not launched through the ownership adapter. */
export function terminateOwnedProcess(pid: number): Promise<void> | undefined {
	return ownedProcesses.get(pid)?.terminate();
}
