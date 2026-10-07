import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import type { AgentSessionEvent } from "../../core/agent-session.ts";

/** Keep dialog status visible while the underlying run changes state. */
export class ProgramStatusReporter {
	private status: ProgramStatus = { state: "idle" };
	private result: ProgramStatus = { state: "done" };
	private dialogs: ProgramStatus[] = [];
	private terminal: () => Terminal;

	constructor(terminal: () => Terminal) {
		this.terminal = terminal;
	}

	/** Reports only metadata, never user prompts or assistant content. */
	handle(event: AgentSessionEvent, sessionName?: string): void {
		switch (event.type) {
			case "agent_start":
				this.result = { state: "done" };
				break;
			case "turn_start":
				this.set({ state: "working", msg: sessionName });
				break;
			case "message_end":
				if (event.message.role !== "assistant") break;
				if (event.message.stopReason === "aborted") this.result = { state: "idle" };
				else if (event.message.stopReason === "error") {
					this.result = { state: "error", msg: (event.message.errorMessage ?? "Error").split(/\r?\n/, 1)[0] };
				} else this.result = { state: "done" };
				break;
			case "auto_retry_end":
				if (!event.success) {
					this.result =
						event.finalError === "Retry cancelled"
							? { state: "idle" }
							: { state: "error", msg: (event.finalError ?? "Unknown error").split(/\r?\n/, 1)[0] };
				}
				break;
			case "agent_settled":
				this.set(this.result);
				break;
			case "compaction_start":
				this.set({ state: "working", msg: "Compacting" });
				break;
			case "compaction_end":
				if (event.aborted) this.abort();
				else if (event.reason === "manual") {
					this.result = event.errorMessage
						? { state: "error", msg: event.errorMessage.split(/\r?\n/, 1)[0] }
						: { state: "done" };
					this.set(this.result);
				}
				break;
		}
	}

	abort(): void {
		this.result = { state: "idle" };
		this.set(this.result);
	}

	set(status: ProgramStatus): void {
		this.status = status;
		this.report();
	}

	block(kind: ProgramStatus["kind"], title: string): () => void {
		const dialog: ProgramStatus = { state: "blocked", kind, msg: title };
		this.dialogs.push(dialog);
		this.report();
		return () => {
			this.dialogs = this.dialogs.filter((entry) => entry !== dialog);
			this.report();
		};
	}

	report(): void {
		this.terminal().setProgramStatus({ ...(this.dialogs.at(-1) ?? this.status), app: "pi" });
	}
}
