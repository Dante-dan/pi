import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
for (const [arch, target, variable] of [
	["x64", "x86_64", "CC_X64"],
	["arm64", "aarch64", "CC_ARM64"],
]) {
	const output = join(root, "prebuilds", `win32-${arch}`);
	mkdirSync(output, { recursive: true });
	const compiler = process.env[variable] ?? `${target}-w64-mingw32-clang`;
	const result = spawnSync(
		compiler,
		["-std=c11", "-Wall", "-Wextra", "-Werror", "-Os", "-municode", "-static", "-Wl,--no-insert-timestamp", join(root, "process-job.c"), "-o", join(output, "pi-process-job.exe")],
		{ stdio: "inherit" },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${compiler} failed with exit code ${result.status}`);
}
