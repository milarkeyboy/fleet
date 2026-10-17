// Provider-free coverage of the read-only overlay and its active subscription.
import "./runtime.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
initTheme("dark", false);
import { visibleWidth } from "@earendil-works/pi-tui";
import { SubagentViewer, showSubagents } from "../viewer.ts";
import type { ConversationSnapshot } from "../viewer-types.ts";

function fixture() {
	let listener = () => {};
	let releases = 0;
	let closed = 0;
	let removed = false;
	let error = false;
	const snapshot: ConversationSnapshot = {
		info: { handle: "one", parentSessionId: "parent", creator: "adhoc", cwd: "/work", label: "Review 界", status: "running", createdAt: 1, updatedAt: 1 },
		messages: [{ key: "u", message: { role: "user", content: "Exact assignment", timestamp: 1 } }],
		instructions: "Private instructions", diagnostics: "",
	};
	const tui = { terminal: { rows: 12 }, requestRender() {} };
	const viewer = new SubagentViewer(tui as any, { fg: (_: string, text: string) => text } as any,
		{ matches: () => false } as any, {
			list: () => removed ? [] : [snapshot.info],
			inspect: () => { if (error) throw new Error("broken transcript"); return structuredClone(snapshot); },
			subscribe: callback => { listener = callback; return () => { releases++; }; },
		}, () => { closed++; });
	return { viewer, snapshot, tui, emit: () => listener(), remove: () => { removed = true; listener(); }, fail: () => { error = true; listener(); }, releases: () => releases, closed: () => closed,
		open: () => { viewer.handleInput("\x1b[B"); viewer.handleInput("\r"); }, text: () => viewer.render(160).join("\n") };
}

test("picker opens a child and Escape returns before closing", () => {
	const f = fixture();
	assert.match(f.text(), /Parent session/);
	f.open();
	assert.match(f.text(), /Exact assignment/);
	f.viewer.handleInput("\x1b");
	assert.match(f.text(), /Parent session/);
	assert.equal(f.closed(), 0);
	f.viewer.handleInput("\x1b");
	assert.equal(f.closed(), 1);
});

test("live replacements replace rather than append message content", () => {
	const f = fixture(); f.open();
	f.snapshot.messages[0].message.content = "Replacement assignment"; f.emit();
	assert.match(f.text(), /Replacement assignment/);
	assert.doesNotMatch(f.text(), /Exact assignment/);
	f.viewer.dispose();
});

test("scrolling upwards pauses follow and End resumes it", () => {
	const f = fixture(); f.open(); f.viewer.render(80);
	f.viewer.handleInput("\x1b[A");
	assert.match(f.text(), /Follow paused/);
	f.viewer.handleInput("\x1b[F");
	assert.match(f.text(), /Following/);
	f.viewer.dispose();
});

test("instructions expand on demand and remain expanded through updates", () => {
	const f = fixture(); f.open();
	assert.doesNotMatch(f.text(), /Private instructions/);
	f.viewer.handleInput("i"); f.emit();
	assert.match(f.text(), /Private instructions/);
	f.viewer.dispose();
});

test("inspection errors appear as diagnostics", () => {
	const f = fixture(); f.open(); f.fail();
	assert.match(f.text(), /Transcript unavailable: broken transcript/);
	f.viewer.dispose();
});

test("removed conversations retain their readable snapshot", () => {
	const f = fixture(); f.open(); f.remove();
	assert.match(f.text(), /deleted/);
	assert.match(f.text(), /Exact assignment/);
	f.viewer.dispose();
});

test("resizing and invalidation keep wide characters within terminal bounds", () => {
	const f = fixture(); f.open(); f.viewer.handleInput("i"); f.viewer.invalidate();
	f.tui.terminal.rows = 4;
	const lines = f.viewer.render(3);
	assert.equal(lines.length, 4);
	assert.ok(lines.every(line => visibleWidth(line) <= 3));
	f.viewer.dispose();
});

test("disposal releases the subscription exactly once", () => {
	const f = fixture(); f.viewer.dispose(); f.viewer.dispose(); f.emit();
	assert.equal(f.releases(), 1);
});

test("parent selection closes without execution capabilities", () => {
	const f = fixture(); f.viewer.handleInput("\r");
	assert.equal(f.closed(), 1);
	assert.equal(f.releases(), 1);
});

test("available thinking expands without inventing missing thinking", () => {
	const f = fixture();
	f.snapshot.messages = [{ key: "a", message: { role: "assistant", content: [{ type: "thinking", thinking: "Recorded reasoning" }, { type: "text", text: "Answer" }], stopReason: "stop" } }];
	f.open();
	assert.match(f.text(), /Thinking \[t: collapsed\]/);
	assert.doesNotMatch(f.text(), /Recorded reasoning/);
	f.viewer.handleInput("t");
	assert.match(f.text(), /Recorded reasoning/);
	f.viewer.dispose();
});

test("tool arguments and results expand together", () => {
	const f = fixture();
	f.tui.terminal.rows = 40;
	f.snapshot.messages = [
		{ key: "a", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "example", arguments: { value: "argument text" } }], stopReason: "toolUse" } },
		{ key: "r", message: { role: "toolResult", toolCallId: "call", toolName: "example", content: [{ type: "text", text: "result text" }], isError: false } },
	];
	f.open();
	assert.doesNotMatch(f.text(), /result text/);
	f.viewer.handleInput("o");
	assert.match(f.text(), /argument text/);
	assert.match(f.text(), /result text/);
	f.viewer.dispose();
});

test("collapsed tools remain pending until execution completes", () => {
	const f = fixture();
	f.snapshot.messages = [
		{ key: "a", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "file" } }] } },
		{ key: "r", message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [] }, pending: true },
	];
	f.open();
	assert.match(f.text(), /Tool read .*pending/);
	f.snapshot.messages[1].pending = false; f.emit();
	assert.doesNotMatch(f.text(), /Tool read .*pending/);
	f.viewer.dispose();
});

test("tool results without an assistant call remain inspectable", () => {
	const f = fixture();
	f.snapshot.messages = [{ key: "tool", message: { role: "toolResult", toolCallId: "nested", toolName: "read", arguments: { path: "nested.txt" }, content: [{ type: "text", text: "Nested contents" }] } }];
	f.tui.terminal.rows = 30;
	f.open(); f.viewer.handleInput("o");
	assert.match(f.text(), /nested.txt/);
	assert.match(f.text(), /Nested contents/);
	f.viewer.dispose();
});

test("Ctrl+C returns to the picker without invoking parent controls", () => {
	const f = fixture(); f.open(); f.viewer.handleInput("\x03");
	assert.match(f.text(), /Parent session/);
	assert.equal(f.closed(), 0);
	f.viewer.dispose();
});

test("non-terminal invocation only notifies", async () => {
	const notices: string[] = [];
	await showSubagents({ mode: "json", ui: { notify: (text: string) => notices.push(text) } } as any, {} as any);
	assert.deepEqual(notices, ["The subagent viewer requires terminal mode."]);
});
