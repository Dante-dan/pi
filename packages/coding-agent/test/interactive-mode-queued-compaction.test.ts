import { expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

// Regression tests for #8301: both submission paths recognize the built-in command.
test("queues compaction while streaming without aborting the active task", async () => {
	const context = {
		session: { isStreaming: true, queueCompaction: vi.fn(), compact: vi.fn() },
		clearStatusIndicator: vi.fn(),
		showStatus: vi.fn(),
	};
	const handleCompactCommand = Reflect.get(InteractiveMode.prototype, "handleCompactCommand") as (
		this: typeof context,
		instructions?: string,
	) => Promise<void>;
	await handleCompactCommand.call(context, "preserve plan");
	expect(context.session.queueCompaction).toHaveBeenCalledWith("preserve plan");
	expect(context.session.compact).not.toHaveBeenCalled();
});

test("compacts immediately when idle", async () => {
	const context = {
		session: { isStreaming: false, queueCompaction: vi.fn(), compact: vi.fn() },
		clearStatusIndicator: vi.fn(),
		showStatus: vi.fn(),
	};
	const handleCompactCommand = Reflect.get(InteractiveMode.prototype, "handleCompactCommand") as (
		this: typeof context,
		instructions?: string,
	) => Promise<void>;
	await handleCompactCommand.call(context);
	expect(context.session.compact).toHaveBeenCalledWith(undefined);
	expect(context.session.queueCompaction).not.toHaveBeenCalled();
});

test("Alt+Enter dispatches /compact instead of sending command text to the model", async () => {
	const context = {
		editor: { getText: () => "/compact preserve plan", addToHistory: vi.fn(), setText: vi.fn() },
		handleCompactCommand: vi.fn(),
	};
	const handleFollowUp = Reflect.get(InteractiveMode.prototype, "handleFollowUp") as (
		this: typeof context,
	) => Promise<void>;
	await handleFollowUp.call(context);
	expect(context.handleCompactCommand).toHaveBeenCalledWith("preserve plan");
	expect(context.editor.setText).toHaveBeenCalledWith("");
});
