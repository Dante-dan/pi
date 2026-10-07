import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import type { ProgramStatus } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ProgramStatusReporter } from "../src/modes/interactive/program-status-reporter.ts";

class RecordingTerminal extends VirtualTerminal {
	statuses: ProgramStatus[] = [];
	override setProgramStatus(status: ProgramStatus): void {
		this.statuses.push(status);
	}
}

function assistant(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "private assistant output" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
	};
}

// #10607: dialog restoration must not discard run changes delivered while blocked.
describe("program status reporter", () => {
	it("restores working after a question and supports nested permission/auth dialogs", () => {
		const terminal = new RecordingTerminal();
		const reporter = new ProgramStatusReporter(() => terminal);
		reporter.set({ state: "working", msg: "Session name" });
		const closeQuestion = reporter.block("question", "Choose a task");
		const closeAuth = reporter.block("auth", "Provider login");
		expect(terminal.statuses.at(-1)).toEqual({ state: "blocked", kind: "auth", msg: "Provider login", app: "pi" });
		closeAuth();
		expect(terminal.statuses.at(-1)?.kind).toBe("question");
		closeQuestion();
		expect(terminal.statuses.at(-1)).toEqual({ state: "working", msg: "Session name", app: "pi" });
		const closePermission = reporter.block("permission", "Allow tool");
		reporter.set({ state: "done" });
		expect(terminal.statuses.at(-1)?.kind).toBe("permission");
		closePermission();
		expect(terminal.statuses.at(-1)).toEqual({ state: "done", app: "pi" });
	});

	it("preserves the visible dialog when another dialog closes out of order", () => {
		const terminal = new RecordingTerminal();
		const reporter = new ProgramStatusReporter(() => terminal);
		const first = reporter.block("question", "First");
		const last = reporter.block("permission", "Last");
		first();
		expect(terminal.statuses.at(-1)?.msg).toBe("Last");
		last();
		expect(terminal.statuses.at(-1)).toEqual({ state: "idle", app: "pi" });
	});
	it("reports working and waits for settlement before reporting done", () => {
		const terminal = new RecordingTerminal();
		const reporter = new ProgramStatusReporter(() => terminal);
		reporter.handle({ type: "agent_start" });
		reporter.handle({ type: "turn_start" }, "Session name");
		reporter.handle({ type: "message_end", message: assistant("stop") });
		expect(terminal.statuses.at(-1)).toEqual({ state: "working", msg: "Session name", app: "pi" });
		reporter.handle({ type: "agent_settled" });
		expect(terminal.statuses.at(-1)).toEqual({ state: "done", app: "pi" });
		expect(JSON.stringify(terminal.statuses)).not.toContain("private assistant output");
	});

	it("keeps retry errors private until the final outcome, and only reports its first line", () => {
		const terminal = new RecordingTerminal();
		const reporter = new ProgramStatusReporter(() => terminal);
		reporter.handle({ type: "turn_start" });
		reporter.handle({ type: "message_end", message: assistant("error", "Temporary error") });
		expect(terminal.statuses.at(-1)?.state).toBe("working");
		reporter.handle({ type: "message_end", message: assistant("stop") });
		reporter.handle({ type: "agent_settled" });
		expect(terminal.statuses.at(-1)?.state).toBe("done");
		reporter.handle({ type: "message_end", message: assistant("error", "Final error\nDetails") });
		reporter.handle({ type: "agent_settled" });
		expect(terminal.statuses.at(-1)).toEqual({ state: "error", msg: "Final error", app: "pi" });
	});

	it("reports idle for aborts and cancelled retries", () => {
		const terminal = new RecordingTerminal();
		const reporter = new ProgramStatusReporter(() => terminal);
		reporter.handle({ type: "message_end", message: assistant("aborted") });
		reporter.handle({ type: "agent_settled" });
		expect(terminal.statuses.at(-1)?.state).toBe("idle");
		reporter.handle({ type: "turn_start" });
		reporter.handle({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
		reporter.handle({ type: "agent_settled" });
		expect(terminal.statuses.at(-1)?.state).toBe("idle");
	});

	it("reports compaction without an intermediate done when the turn will retry", () => {
		const terminal = new RecordingTerminal();
		const reporter = new ProgramStatusReporter(() => terminal);
		reporter.handle({ type: "compaction_start", reason: "overflow" });
		expect(terminal.statuses.at(-1)).toEqual({ state: "working", msg: "Compacting", app: "pi" });
		reporter.handle({
			type: "compaction_end",
			reason: "overflow",
			aborted: false,
			willRetry: true,
			result: undefined,
		});
		expect(terminal.statuses.at(-1)?.state).toBe("working");
		reporter.handle({ type: "compaction_end", reason: "manual", aborted: true, willRetry: false, result: undefined });
		expect(terminal.statuses.at(-1)?.state).toBe("idle");
	});
});
