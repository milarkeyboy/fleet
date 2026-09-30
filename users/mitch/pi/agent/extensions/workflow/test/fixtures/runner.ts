// Deterministic subprocess peer for runner tests; no model or credentials are used.
import { appendFileSync, readFileSync } from "node:fs";
import { getEventListeners } from "node:events";
import { runAgent } from "../../runner.ts";

if (process.argv.includes("--mode")) {
	const file = process.argv[process.argv.indexOf("--session") + 1];
	const history = readFileSync(file, "utf8");
	const task = process.argv.at(-1)!;
	appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "user", content: task } })}\n`);
	const message = { role: "assistant", content: [{ type: "text", text: history.includes("remember-this") ? "remembered" : "first run" }], stopReason: task.includes("aborted") ? "aborted" : "stop" };
	appendFileSync(file, `${JSON.stringify({ type: "message", message })}\n`);
	process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);
} else {
	const controller = new AbortController();
	try {
		const result = await runAgent({
			cwd: process.cwd(), roleName: "test", sessionFile: process.argv[2], systemPrompt: "Role prompt", task: process.argv[3],
			skillPaths: [], tools: ["read"], model: "test/model", signal: controller.signal,
			onProcess(pid) { if (pid && process.argv[3] === "cancel") controller.abort(); },
		});
		console.log(JSON.stringify({ ok: true, output: result.output, listeners: getEventListeners(controller.signal, "abort").length }));
	} catch (error) {
		console.log(JSON.stringify({ ok: false, error: String(error), listeners: getEventListeners(controller.signal, "abort").length }));
	}
}
