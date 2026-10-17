// Deterministic subprocess peer for conversation and runner tests; no provider is contacted.
import { appendFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { getConversationService } from "../../api.ts";
import { AgentRunError, runAgent } from "../../runner.ts";

const usage = { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 1, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
if (process.argv.includes("--mode")) {
	const file = process.argv[process.argv.indexOf("--session") + 1];
	const history = readFileSync(file, "utf8");
	const task = process.argv.at(-1)!;
	const emit = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);
	const save = (message: unknown) => appendFileSync(file, `${JSON.stringify({ type: "message", message })}\n`);
	const user = { role: "user", content: task, timestamp: Date.now() };
	save(user); emit({ type: "message_start", message: user }); emit({ type: "message_end", message: user });
	if (task.includes("compaction")) emit({ type: "compaction_end", result: { usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } } } });
	const message = { role: "assistant", timestamp: Date.now() + 1, content: [{ type: "text", text: history.includes("remember-this") ? "remembered" : "first run" }], usage, stopReason: task.includes("aborted") ? "aborted" : task.includes("length") ? "length" : task.includes("model-error") ? "error" : "stop" };
	emit({ type: "message_start", message: { ...message, content: [], stopReason: "pending" } });
	if (task.includes("stream")) {
		emit({ type: "message_update", usage, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Consider carefully." } });
		emit({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "partial\u2028answer" } });
		emit({ type: "message_update", usage, assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, id: "call-1", toolName: "read" } });
		emit({ type: "message_update", usage, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: '{"path":"source.ts"}' } });
		emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "source.ts" } });
		emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { content: [{ type: "text", text: "file contents" }] }, isError: false });
		process.stderr.write("fixture diagnostic\n");
		if (task.includes("partial-zero")) process.exit(0);
		if (task.includes("partial")) process.exit(2);
		if (task.includes("cancel-tree")) {
			const child = spawn(process.execPath, ["-e", `process.stderr.write("tree-ready\\n");setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(`${file}.descendant`)},"survived"),200);setInterval(()=>{},1000);`], { stdio: ["ignore", "ignore", "pipe"] });
			child.stderr.on("data", (text) => process.stderr.write(text));
			await new Promise((resolve) => setTimeout(resolve, 2000));
		} else if (task.includes("stream-cancel")) await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	save(message); emit({ type: "message_end", message });
	if (task.includes("non-zero")) { process.stderr.write("non-zero diagnostic\n"); process.exitCode = 2; }
} else if (process.argv[2] === "service") {
	const root = process.argv[3];
	const owner = { parentSessionId: "parent", creator: "adhoc", cwd: process.cwd() };
	const service = getConversationService(root);
	const handle = process.argv[4] === "new" ? service.create(owner, "Persistent conversation") : process.argv[4];
	const result = await service.run(owner, handle, { name: "test", description: "test", body: "Role prompt", filePath: "/test.md", model: "test/model", tools: ["read"] }, { task: process.argv[5] });
	console.log(JSON.stringify({ handle, output: result.output, status: service.get(owner, handle).status, messages: service.inspect("parent", handle).messages.length }));
} else {
	const controller = new AbortController();
	const processes: Array<number | undefined> = [];
	const events: string[] = [];
	const stderr: string[] = [];
	const detailed = process.argv[3].includes("compaction") || process.argv[3].includes("stream") || process.argv[3].includes("non-zero") || process.argv[3].includes("length") || process.argv[3].includes("model-error") || process.argv[3].includes("cancel");
	try {
		const result = await runAgent({
			cwd: process.cwd(), roleName: "test", sessionFile: process.argv[2], systemPrompt: "Role prompt", task: process.argv[3],
			skillPaths: [], tools: ["read"], model: "test/model", signal: controller.signal,
			onProcess(pid) { processes.push(pid); if (pid && process.argv[3] === "cancel") controller.abort(); },
			onEvent(event) { events.push(event.type); if (process.argv[3].includes("observer-error")) throw new Error("observer failure"); },
			onStderr(text) {
				stderr.push(text);
				if (process.argv[3] === "stream-cancel" || text.includes("tree-ready")) controller.abort();
				if (process.argv[3].includes("observer-error")) throw new Error("observer failure");
			},
			onUpdate() { if (process.argv[3].includes("observer-error")) throw new Error("observer failure"); },
		});
		console.log(JSON.stringify({ ok: true, output: result.output, listeners: getEventListeners(controller.signal, "abort").length, ...(detailed ? { result, events, stderr, processes } : {}) }));
	} catch (error) {
		console.log(JSON.stringify({ ok: false, error: String(error), listeners: getEventListeners(controller.signal, "abort").length,
			...(detailed ? { result: error instanceof AgentRunError ? error.result : undefined, events, stderr, processes } : {}) }));
	}
}
