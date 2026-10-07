import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import { Connection } from "../src/connection.ts";
import { RemoteExecutionEnv } from "../src/remote-env.ts";
import { daemon } from "./daemon.ts";

const connections: Connection[] = [];
const dirs: string[] = [];
const window = { maxBytes: 128, maxLines: 5, minIntervalMs: 10, bytesPerSecond: 1_000_000 };
const context = BACKGROUND_CONTEXT;

function environment() {
	const home = mkdtempSync(join(tmpdir(), "pi-env-keyed-"));
	dirs.push(home);
	const connection = new Connection({ command: ["/usr/bin/env", `HOME=${home}`, daemon] });
	connections.push(connection);
	const env = new RemoteExecutionEnv({ connection, id: `pi-env:${home}`, cwd: home });
	return { home, connection, env };
}

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for job state");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function job(home: string, key: string): string {
	return join(home, ".pi/env/jobs", createHash("sha256").update(key).digest("hex"));
}

afterAll(() => {
	for (const connection of connections) connection.close();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// #10624: exercise real daemon/shim boundaries; no provider or external SSH credentials.
describe.skipIf(process.platform === "win32")("keyed exec", () => {
	it("claims concurrent requests once and attaches to the finished result", async () => {
		const { home, connection } = environment();
		const spec = { key: "once", argv: ["sh", "-c", "echo run >> count; sleep 0.2; echo done"], cwd: home, window };
		const other = new Connection({ command: ["/usr/bin/env", `HOME=${home}`, daemon] });
		connections.push(other);
		const [first, second] = await Promise.all([connection.request("exec", spec), other.request("exec", spec)]);
		expect(first.json.exitCode).toBe(0);
		expect(second.json.exitCode).toBe(0);
		expect((await connection.request("exec", spec)).json.exitCode).toBe(0);
		expect(readFileSync(join(home, "count"), "utf8")).toBe("run\n");
		await expect(connection.request("exec", { ...spec, argv: ["sh", "-c", "echo different"] })).rejects.toMatchObject(
			{ code: "EINVAL" },
		);
	});

	it("reconnects inside RemoteExecutionEnv.exec without rerunning or duplicating output", async () => {
		const { home, connection, env } = environment();
		let output = "";
		let killed = false;
		const pid = (await connection.info()).pid;
		const result = await env.exec(
			["sh", "-c", "echo run >> count; printf before; sleep 0.5; printf after"],
			{
				key: "reconnect",
				window,
				onOutput(text) {
					output += text;
					if (!killed) {
						killed = true;
						process.kill(pid, "SIGKILL");
					}
				},
			},
			context,
		);
		expect(getOrThrow(result).exitCode).toBe(0);
		expect(output).toBe("beforeafter");
		expect(readFileSync(join(home, "count"), "utf8")).toBe("run\n");
		expect((await connection.info()).pid).not.toBe(pid);
	});

	it("survives a client close, then transfers only its bounded tail and complete counts", async () => {
		const { home, connection } = environment();
		const spec = {
			key: "detached",
			argv: ["sh", "-c", "echo run >> count; sleep 0.3; yes abc | head -c 100000"],
			cwd: home,
			window,
		};
		const running = connection.request("exec", spec).catch(() => undefined);
		await until(() => existsSync(join(home, "count")));
		connection.close();
		await running;
		await until(() => existsSync(join(job(home, spec.key), "status.json")));
		const attached = new Connection({ command: ["/usr/bin/env", `HOME=${home}`, daemon] });
		connections.push(attached);
		let delivered = 0;
		let skipped = 0;
		let tail = "";
		const result = await attached.request("exec", spec, {
			onEvent(event, payload) {
				delivered += payload.length;
				skipped += (event.skipped as { bytes: number } | undefined)?.bytes ?? 0;
				tail += Buffer.from(payload).toString();
			},
		});
		expect(delivered + skipped).toBe(100000);
		expect(delivered).toBeLessThan(1000);
		expect("abc\n".repeat(25000).endsWith(tail)).toBe(true);
		expect(readFileSync(result.json.spillPath as string).length).toBe(100000);
		expect(readFileSync(join(home, "count"), "utf8")).toBe("run\n");
	});

	it("expires an unobserved lease and retains the terminal failure without rerunning", async () => {
		const { home, connection } = environment();
		const spec = { key: "lease", argv: ["sh", "-c", "echo run >> count; sleep 10"], cwd: home, window, leaseMs: 200 };
		const running = connection.request("exec", spec).catch(() => undefined);
		await until(() => existsSync(join(home, "count")));
		connection.close();
		await running;
		await until(() => existsSync(join(job(home, spec.key), "status.json")));
		const status = JSON.parse(readFileSync(join(job(home, spec.key), "status.json"), "utf8"));
		expect(status.error.code).toBe("aborted");
		expect(readFileSync(join(home, "count"), "utf8")).toBe("run\n");
	});

	it("reports a killed shim as lost and never starts the key again", async () => {
		const { home, connection } = environment();
		const spec = {
			key: "lost",
			argv: ["sh", "-c", "echo $$ > child; echo run >> count; sleep 10"],
			cwd: home,
			window,
		};
		const running = connection.request("exec", spec).catch((error: unknown) => error);
		await until(() => existsSync(join(home, "count")));
		const pid = JSON.parse(readFileSync(join(job(home, spec.key), "pid.json"), "utf8")).pid as number;
		process.kill(pid, "SIGKILL");
		expect(await running).toMatchObject({ code: "lost" });
		await expect(connection.request("exec", spec)).rejects.toMatchObject({ code: "lost" });
		expect(readFileSync(join(home, "count"), "utf8")).toBe("run\n");
		process.kill(-Number(readFileSync(join(home, "child"), "utf8")), "SIGKILL");
	});

	it("requires a window before starting a keyed command", async () => {
		const { home, connection } = environment();
		await expect(
			connection.request("exec", { key: "invalid", argv: ["touch", "ran"], cwd: home }),
		).rejects.toMatchObject({ code: "EINVAL" });
		expect(existsSync(join(home, "ran"))).toBe(false);
	});

	it("renews a short lease while a client stays attached", async () => {
		const { home, connection } = environment();
		const result = await connection.request("exec", {
			key: "observed",
			argv: ["sh", "-c", "sleep 0.7; echo done"],
			cwd: home,
			window,
			leaseMs: 150,
		});
		expect(result.json.exitCode).toBe(0);
	});

	it("preserves the original timeout across a detach and attach", async () => {
		const { home, connection } = environment();
		const spec = {
			key: "timeout",
			argv: ["sh", "-c", "echo run >> count; sleep 10"],
			cwd: home,
			window,
			timeoutMs: 300,
		};
		const running = connection.request("exec", spec).catch(() => undefined);
		await until(() => existsSync(join(home, "count")));
		connection.close();
		await running;
		await until(() => existsSync(join(job(home, spec.key), "status.json")));
		const attached = new Connection({ command: ["/usr/bin/env", `HOME=${home}`, daemon] });
		connections.push(attached);
		await expect(attached.request("exec", spec)).rejects.toMatchObject({ code: "timeout" });
		expect(readFileSync(join(home, "count"), "utf8")).toBe("run\n");
	});

	it("rejects invalid lease, cursor and window fields without executing", async () => {
		const { home, connection } = environment();
		const spec = { key: "invalid-fields", argv: ["touch", "ran"], cwd: home, window };
		for (const fields of [
			{ leaseMs: -1 },
			{ offset: -1 },
			{ window: { ...window, maxBytes: 1e20 } },
			{ timeoutMs: -1 },
		]) {
			await expect(connection.request("exec", { ...spec, ...fields })).rejects.toMatchObject({ code: "EINVAL" });
		}
		expect(existsSync(join(home, "ran"))).toBe(false);
	});

	it("keeps UTF-8 boundaries and counts in a finished output window", async () => {
		const { home, connection } = environment();
		const full = "é😀\n".repeat(30000);
		const spec = {
			key: "unicode",
			argv: [process.execPath, "-e", "process.stdout.write('é😀\\n'.repeat(30000))"],
			cwd: home,
			window,
		};
		await connection.request("exec", spec);
		let bytes = 0;
		let lines = 0;
		let tail = "";
		await connection.request("exec", spec, {
			onEvent(event, payload) {
				const skipped = event.skipped as { bytes: number; newlines: number } | undefined;
				bytes += payload.length + (skipped?.bytes ?? 0);
				lines += Buffer.from(payload).toString().split("\n").length - 1 + (skipped?.newlines ?? 0);
				tail += Buffer.from(payload).toString();
			},
		});
		expect(bytes).toBe(Buffer.byteLength(full));
		expect(lines).toBe(30000);
		expect(tail).not.toContain("�");
		expect(full.endsWith(tail)).toBe(true);
	});

	it("collects finished jobs after seven unobserved days", async () => {
		const { home, connection } = environment();
		await connection.request("exec", { key: "old", argv: ["true"], cwd: home, window });
		writeFileSync(
			join(job(home, "old"), "lease.json"),
			JSON.stringify({ renewed: Date.now() - 8 * 24 * 60 * 60 * 1000 }),
		);
		writeFileSync(join(home, ".pi/env/jobs/.cleanup.json"), JSON.stringify({ at: 0 }));
		await connection.request("exec", { key: "new", argv: ["true"], cwd: home, window });
		expect(existsSync(job(home, "old"))).toBe(false);
		expect(existsSync(job(home, "new"))).toBe(true);
	});

	it("remembers cleanup while a keyed exec is reconnecting", async () => {
		const { home, connection, env } = environment();
		const running = env.exec(["sh", "-c", "echo run >> count; sleep 10"], { key: "cleanup", window }, context);
		await until(() => existsSync(join(home, "count")));
		const pid = (await connection.info()).pid;
		process.kill(pid, "SIGKILL");
		await until(() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				return true;
			}
		});
		await env.cleanup(context);
		const result = getOrThrow(await running);
		expect(result.exitCode).not.toBe(0);
		expect(readFileSync(join(home, "count"), "utf8")).toBe("run\n");
	});
});
