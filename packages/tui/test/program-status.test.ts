import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeProgramStatus } from "../src/program-status.ts";

// #10607: protocol encoding and hard limits from the Program Status Protocol spec.
describe("program status encoding", () => {
	it("emits a root record with safe UTF-8 base64 text", () => {
		const sequence = encodeProgramStatus({
			state: "blocked",
			kind: "question",
			app: "pi",
			msg: "Hello\n世界\x1b\x7f\x80",
		});
		assert.equal(
			sequence,
			`\x1b]7501;state=blocked:app=pi:kind=question:msg=${Buffer.from("Hello世界").toString("base64")}\x1b\\`,
		);
	});

	it("truncates multibyte messages without invalid UTF-8 and within all limits", () => {
		const sequence = encodeProgramStatus({ state: "working", app: "pi", msg: "🙂".repeat(1000) });
		const encoded = sequence.split("msg=")[1].slice(0, -2);
		const decoded = Buffer.from(encoded, "base64");
		assert.equal(decoded.length, 2048);
		assert.equal(decoded.toString(), "🙂".repeat(512));
		assert.ok(encoded.length <= 2732);
		assert.ok(Buffer.byteLength(sequence) <= 4096);
	});

	it("omits invalid app names and kind on non-blocked records", () => {
		assert.equal(
			encodeProgramStatus({ state: "clear", app: "bad:app", kind: "auth" }),
			"\x1b]7501;state=clear\x1b\\",
		);
		assert.ok(!encodeProgramStatus({ state: "idle", app: "a".repeat(33) }).includes("app="));
		assert.ok(encodeProgramStatus({ state: "idle", app: "a".repeat(32) }).includes("app="));
	});
});
