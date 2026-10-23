import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness } from "../harness.ts";

// Regression #11267: opt in to extension-only files without saving every /new.
describe("custom message persistence", () => {
	let tempDir: string;
	const cleanups: Array<() => void> = [];
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-custom-persist-"));
	});
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it.each([undefined, false])("keeps session_start messages in memory with persist=%s", async (persist) => {
		const manager = SessionManager.create(tempDir, tempDir);
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.sendMessage({ customType: "notice", content: "Welcome", display: true }, { persist });
					});
				},
			],
		});
		cleanups.push(harness.cleanup);
		for (let i = 0; i < 3; i++) {
			manager.newSession();
			await harness.session.bindExtensions({});
			expect(manager.getEntries().some((entry) => entry.type === "custom_message")).toBe(true);
			expect(existsSync(manager.getSessionFile()!)).toBe(false);
		}
	});

	it("saves an opted-in extension-only session and resumes its content and metadata", async () => {
		const manager = SessionManager.create(tempDir, tempDir);
		manager.appendCustomEntry("state", { step: 1 });
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.sendMessage(
							{ customType: "note", content: "Keep this", display: false, details: { step: 2 } },
							{ persist: true },
						);
					});
				},
			],
		});
		cleanups.push(harness.cleanup);
		await harness.session.bindExtensions({});
		const resumed = SessionManager.open(manager.getSessionFile()!);
		expect(resumed.getEntries()).toEqual(manager.getEntries());
		expect(resumed.buildSessionContext().messages).toEqual([
			expect.objectContaining({ role: "custom", content: "Keep this", display: false, details: { step: 2 } }),
		]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		resumed.appendCustomMessageEntry("note", "Second", true);
		expect(SessionManager.open(manager.getSessionFile()!).buildSessionContext().messages).toHaveLength(2);
		const branchedFile = resumed.createBranchedSession(resumed.getLeafId()!);
		expect(branchedFile).toBeDefined();
		expect(SessionManager.open(branchedFile!).buildSessionContext().messages).toHaveLength(2);
		manager.newSession();
		manager.appendCustomMessageEntry("notice", "Fresh session", true);
		expect(existsSync(manager.getSessionFile()!)).toBe(false);
	});

	it("honors in-memory sessions even with persist enabled", async () => {
		const harness = await createHarness({ sessionManager: SessionManager.inMemory(tempDir) });
		cleanups.push(harness.cleanup);
		await harness.session.sendCustomMessage(
			{ customType: "note", content: "Keep", display: true },
			{ persist: true },
		);
		expect(harness.session.sessionFile).toBeUndefined();
		expect(harness.session.messages).toHaveLength(1);
	});

	it("keeps nextTurn persistence deferred until delivery", async () => {
		const manager = SessionManager.create(tempDir, tempDir);
		const harness = await createHarness({ sessionManager: manager });
		cleanups.push(harness.cleanup);
		await harness.session.sendCustomMessage(
			{ customType: "aside", content: "Next turn", display: true },
			{ persist: true, deliverAs: "nextTurn" },
		);
		expect(existsSync(manager.getSessionFile()!)).toBe(false);
		harness.setResponses([fauxAssistantMessage("Done")]);
		await harness.session.prompt("Start");
		expect(SessionManager.open(manager.getSessionFile()!).getEntries()).toContainEqual(
			expect.objectContaining({ type: "custom_message", content: "Next turn", persist: true }),
		);
	});

	it("saves the opted-in message before the triggered assistant response starts", async () => {
		let savedBeforeResponse = false;
		const manager = SessionManager.create(tempDir, tempDir);
		const harness = await createHarness({ sessionManager: manager });
		harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				savedBeforeResponse = SessionManager.open(manager.getSessionFile()!)
					.getEntries()
					.some((entry) => entry.type === "custom_message" && entry.content === "Start" && entry.persist === true);
			}
		});
		cleanups.push(harness.cleanup);
		harness.setResponses([fauxAssistantMessage("Done")]);
		await harness.session.sendCustomMessage(
			{ customType: "task", content: "Start", display: true },
			{ persist: true, triggerTurn: true },
		);
		expect(savedBeforeResponse).toBe(true);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});
});
