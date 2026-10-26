import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createLocalShellOperations } from "../src/core/tools/bash.ts";
import { createPowerShellTool } from "../src/core/tools/powershell.ts";
import { getPowerShellConfig, POWERSHELL_ARGS } from "../src/utils/shell.ts";

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join("\n");
}

describe("powershell tool", () => {
	it("uses process-local execution policy bypass", () => {
		expect(POWERSHELL_ARGS.slice(0, 5)).toEqual([
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
		]);
	});

	it.skipIf(process.platform !== "win32")("executes PowerShell commands with UTF-8 output", async () => {
		const config = getPowerShellConfig();
		expect(config.args).toEqual(POWERSHELL_ARGS);
		expect(config.commandTransport).toBe("stdin");

		const tool = createPowerShellTool(process.cwd());
		const result = await tool.execute("powershell-test", {
			command: "Write-Output 'héllo €'; Get-ExecutionPolicy -Scope Process",
		});
		const output = getTextOutput(result);

		expect(output).toContain("héllo €");
		expect(output).toContain("Bypass");
	});
	// #7547: Windows rejects command lines over 32767 characters before PowerShell starts.
	it.skipIf(process.platform !== "win32" && spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status !== 0)(
		"executes long multiline scripts as UTF-8 without argv limits",
		async () => {
			const operations = createLocalShellOperations("PowerShell", () =>
				process.platform === "win32"
					? getPowerShellConfig()
					: { shell: "pwsh", args: [...POWERSHELL_ARGS], commandTransport: "stdin" },
			);
			const chunks: Buffer[] = [];
			const result = await operations.exec(
				`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$text = '${"é".repeat(40_000)}'
if ($text.Length -eq 40000) {
Write-Output $text.Length
Write-Output 'héllo €'
}
Write-Output (Get-Location).Path`,
				process.cwd(),
				{ onData: (data) => chunks.push(data) },
			);
			const output = Buffer.concat(chunks).toString("utf-8");
			expect(output).toContain("40000");
			expect(output).toContain("héllo €");
			expect(output).toContain(process.cwd());
			expect(result.exitCode).toBe(0);
		},
	);
});
