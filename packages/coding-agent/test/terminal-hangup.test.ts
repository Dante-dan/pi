import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SignalHandlerContext = {
	signalCleanupHandlers: Array<() => void>;
	unregisterSignalHandlers(): void;
	emergencyTerminalExit(): never;
	uncaughtCrash(error: Error): never;
	shutdown(): Promise<void>;
};

const prototype = InteractiveMode.prototype as unknown as {
	registerSignalHandlers(this: SignalHandlerContext): void;
	unregisterSignalHandlers(this: SignalHandlerContext): void;
};

describe("interactive terminal hangups (#10272)", () => {
	let context: SignalHandlerContext | undefined;

	afterEach(() => {
		if (context) prototype.unregisterSignalHandlers.call(context);
		context = undefined;
		vi.restoreAllMocks();
	});

	function register(): SignalHandlerContext {
		context = {
			signalCleanupHandlers: [],
			unregisterSignalHandlers() {
				prototype.unregisterSignalHandlers.call(this);
			},
			emergencyTerminalExit: vi.fn(() => {
				throw new Error("terminal exit");
			}),
			uncaughtCrash: vi.fn((error: Error) => {
				throw error;
			}),
			shutdown: vi.fn(async () => {}),
		};
		prototype.registerSignalHandlers.call(context);
		return context;
	}

	test.each(["EIO", "EPIPE", "ENOTCONN", "ENXIO"])(
		"routes stdin %s to terminal exit instead of crash reporting",
		(code) => {
			const handlers = register();
			const error = Object.assign(new Error(`read ${code}`), { code });

			expect(() => process.stdin.emit("error", error)).toThrow("terminal exit");
			expect(handlers.emergencyTerminalExit).toHaveBeenCalledOnce();
			expect(handlers.uncaughtCrash).not.toHaveBeenCalled();
		},
	);

	test("preserves unrelated stdin failures", () => {
		const handlers = register();
		const error = Object.assign(new Error("unexpected read failure"), { code: "EINVAL" });

		expect(() => process.stdin.emit("error", error)).toThrow(error);
		expect(handlers.emergencyTerminalExit).not.toHaveBeenCalled();
	});

	test("re-registration and cleanup do not leak stdin listeners", () => {
		const before = process.stdin.listeners("error");
		const handlers = register();
		expect(process.stdin.listeners("error")).toHaveLength(before.length + 1);

		prototype.registerSignalHandlers.call(handlers);
		expect(process.stdin.listeners("error")).toHaveLength(before.length + 1);

		prototype.unregisterSignalHandlers.call(handlers);
		expect(process.stdin.listeners("error")).toEqual(before);
	});
});
