import assert from "node:assert";
import { it } from "node:test";
import type { IBufferCell, Terminal } from "@xterm/headless";
import { Markdown } from "../src/components/markdown.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

it("drops the space after styled words at the content boundary with padding", () => {
	// #10925, issuecomment-6191454135: test the component with output padding=1.
	for (const word of ["`hello`", "*hello*", "**hello**", "~~hello~~"]) {
		const markdown = new Markdown(`${word} world`, 1, 0, defaultMarkdownTheme);
		assert.deepStrictEqual(
			markdown.render(7).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")),
			[" hello ", " world "],
		);
	}
});

it("renders the reported width-79 sample without extra leading spaces or struck padding", async () => {
	// #10925: original reporter's text, terminal width, and output padding.
	const source =
		"Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do aaaa `eiusmod` tempor incididunt ut labore et dolore magna aliqua. Ut enim a minim *veniam,* quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea aaa **commodo** consequat. Duis aute irure dolor in reprehenderit in voluptate velit a ~~esse~~ cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.";
	const lines = new Markdown(source, 1, 0, defaultMarkdownTheme).render(79);
	const terminal = new VirtualTerminal(79, lines.length + 1);
	terminal.write(lines.join("\r\n"));
	await terminal.flush();
	const xterm = (terminal as unknown as { xterm: Terminal }).xterm;
	let struckCharacters = "";
	for (let row = 0; row < lines.length; row++) {
		const line = xterm.buffer.active.getLine(row);
		assert.ok(line);
		const plain = line.translateToString(true);
		assert.match(plain, /^ \S/, `Unexpected leading space on row ${row}: ${plain}`);
		for (let col = 0; col < 79; col++) {
			const cell: IBufferCell | undefined = line.getCell(col);
			assert.ok(cell);
			if (cell.getChars().trim() === "") {
				assert.strictEqual(cell.isStrikethrough(), 0, `Struck padding at ${row},${col}`);
			} else if (cell.isStrikethrough()) {
				struckCharacters += cell.getChars();
			}
		}
	}
	assert.strictEqual(struckCharacters, "esse");
});

it("keeps a wrapped strikethrough active on text and off both padding columns", async () => {
	// #10925, issuecomment-6191454135: strikethrough continues across an exact-width wrap.
	const lines = new Markdown("~~hello world~~", 1, 0, defaultMarkdownTheme).render(7);
	assert.strictEqual(lines.length, 2);
	const terminal = new VirtualTerminal(7, 3);
	terminal.write(lines.join("\r\n"));
	await terminal.flush();
	const xterm = (terminal as unknown as { xterm: Terminal }).xterm;
	for (let row = 0; row < lines.length; row++) {
		const line = xterm.buffer.active.getLine(row);
		assert.ok(line);
		assert.strictEqual(line.translateToString(true).trimEnd(), row === 0 ? " hello" : " world");
		for (let col = 0; col < 7; col++) {
			const cell: IBufferCell | undefined = line.getCell(col);
			assert.ok(cell);
			assert.strictEqual(Boolean(cell.isStrikethrough()), col > 0 && col < 6, `Wrong strike at ${row},${col}`);
		}
	}
});
