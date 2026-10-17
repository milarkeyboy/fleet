// Live transcript reconstruction and canonical native-history reconciliation.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getConversationService } from "../api.ts";
import { LiveTranscript, nativeTranscript, reconcile } from "../transcript.ts";
import { AgentRunError } from "../runner.ts";

const agent = { name: "reviewer", description: "Review", body: "Review", filePath: "/reviewer.md", model: "test/model", tools: ["read"] };
const success = { exitCode: 0, output: "Done", stderr: "", messages: [] };

test("message_end replaces streamed thinking, text and tool arguments", () => {
	const live = new LiveTranscript();
	live.observe({ type: "message_start", message: { role: "assistant", timestamp: 1, content: [] } });
	live.observe({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Consider" } });
	live.observe({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Draft" } });
	live.observe({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, id: "call", toolName: "read" } });
	live.observe({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: '{"path":' } });
	assert.equal(live.messages[0].message.content[2].argumentsText, '{"path":');
	const message = { role: "assistant", timestamp: 1, content: [{ type: "thinking", thinking: "Final thought" }, { type: "text", text: "Final answer" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "source.ts" } }] };
	live.observe({ type: "message_end", message });
	assert.equal(live.messages.length, 1);
	assert.deepEqual(live.messages[0].message, message);
	assert.equal(live.messages[0].pending, undefined);
});

test("tool execution results reconcile with the final tool-result message", () => {
	const live = new LiveTranscript();
	live.observe({ type: "tool_execution_start", toolCallId: "call", toolName: "read", args: { path: "source.ts" } });
	live.observe({ type: "tool_execution_update", toolCallId: "call", toolName: "read", partialResult: { content: [{ type: "text", text: "Partial" }] } });
	assert.deepEqual(live.messages[0].message.arguments, { path: "source.ts" });
	assert.equal(live.messages[0].message.content[0].text, "Partial");
	live.observe({ type: "tool_execution_end", toolCallId: "call", toolName: "read", result: { content: [{ type: "text", text: "Done" }] }, isError: false });
	const message = { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "Final contents" }], timestamp: 2 };
	live.observe({ type: "message_start", message }); live.observe({ type: "message_end", message });
	assert.equal(live.messages.length, 1);
	assert.deepEqual(live.messages[0].message, message);
});

test("overlapping tool results retain their distinct call identities", () => {
	const live = new LiveTranscript();
	live.observe({ type: "message_start", message: { role: "toolResult", toolCallId: "a", content: [] } });
	live.observe({ type: "message_start", message: { role: "toolResult", toolCallId: "b", content: [] } });
	live.observe({ type: "message_end", message: { role: "toolResult", toolCallId: "a", content: [{ type: "text", text: "First" }] } });
	live.observe({ type: "message_end", message: { role: "toolResult", toolCallId: "b", content: [{ type: "text", text: "Second" }] } });
	assert.deepEqual(live.messages.map(item => [item.message.toolCallId, item.message.content[0].text]), [["a", "First"], ["b", "Second"]]);
});

test("live reads tolerate an incomplete trailing native record without changing it", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "subagent-native-"));
	const file = path.join(root, "session.jsonl");
	const text = '{"type":"session","version":3,"id":"handle","cwd":"/repo"}\n{"type":"message","id":"one","message":{"role":"user","content":"Question"}}\n{"type":';
	try {
		writeFileSync(file, text);
		assert.deepEqual(nativeTranscript(file, "handle", "/repo", true).map(item => item.message.content), ["Question"]);
		assert.equal(readFileSync(file, "utf8"), text);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("canonical history replaces live messages without duplicate completed responses", () => {
	const message = { role: "assistant", timestamp: 1, content: [{ type: "text", text: "Final" }] };
	assert.deepEqual(reconcile([{ key: "native:one", message }], [{ key: "live:one", message: { ...message, content: [{ type: "text", text: "Draft" }] }, pending: true }]), [{ key: "native:one", message }]);
});

test("interrupted responses retain their position before subsequent native messages", () => {
	const first = { key: "native:first", message: { role: "user", content: "First", timestamp: 1 } };
	const later = { key: "native:later", message: { role: "user", content: "Later", timestamp: 3 } };
	const partial = { key: "live:partial", message: { role: "assistant", content: [{ type: "text", text: "Partial" }], timestamp: 2 }, pending: true, after: "native:first" };
	assert.deepEqual(reconcile([first, later], [partial]).map((item) => item.message.timestamp), [1, 2, 3]);
});

test("snapshots seed existing native history and reconcile successive invocations", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "subagent-transcript-"));
	const owner = { parentSessionId: "parent", creator: "adhoc", cwd: process.cwd() };
	const service = getConversationService(root);
	try {
		const handle = service.create(owner, "Review");
		const file = path.join(root, "conversations", handle, "session.jsonl");
		appendFileSync(file, '{"type":"message","id":"old","message":{"role":"user","content":"Old question","timestamp":1}}\n');
		await service.run(owner, handle, agent, { task: "Review" }, async (options) => {
			options.onEvent!({ type: "message_start", message: { role: "assistant", timestamp: 2, content: [] } });
			options.onEvent!({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Draft" } });
			assert.deepEqual(service.inspect("parent", handle).messages.map((item) => item.message.role), ["user", "assistant"]);
			const message = { role: "assistant", timestamp: 2, content: [{ type: "text", text: "Done" }] };
			appendFileSync(file, `${JSON.stringify({ type: "message", id: "new", message })}\n`);
			options.onEvent!({ type: "message_end", message });
			return success;
		});
		await service.run(owner, handle, agent, { task: "Continue" }, async (options) => {
			options.onEvent!({ type: "message_start", message: { role: "assistant", timestamp: 3, content: [] } });
			assert.equal(service.inspect("parent", handle).messages.length, 3);
			return success;
		});
		assert.equal(service.inspect("parent", handle).messages.length, 3);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed partial messages and stderr remain inspectable after a fresh service load", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "subagent-recovery-"));
	const owner = { parentSessionId: "parent", creator: "adhoc", cwd: process.cwd() };
	const service = getConversationService(root);
	try {
		const handle = service.create(owner, "Review");
		await assert.rejects(service.run(owner, handle, agent, { task: "Review" }, async (options) => {
			options.onEvent!({ type: "message_start", message: { role: "assistant", timestamp: 1, content: [] } });
			options.onEvent!({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Reasoning" } });
			options.onEvent!({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Partial answer" } });
			options.onStderr!("Provider disconnected\n");
			throw new AgentRunError("Failed", { ...success, exitCode: 2 });
		}), /Failed/);
		const fresh = await import(`../api.ts?restart=${Date.now()}`);
		const snapshot = fresh.getConversationService(root).inspect("parent", handle);
		assert.equal(snapshot.messages[0].message.content[0].thinking, "Reasoning");
		assert.equal(snapshot.messages[0].message.content[1].text, "Partial answer");
		assert.equal(snapshot.messages[0].pending, true);
		assert.equal(snapshot.diagnostics, "Provider disconnected\nFailed\n");
	} finally { rmSync(root, { recursive: true, force: true }); }
});
