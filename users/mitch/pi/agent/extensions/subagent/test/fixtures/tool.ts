// Exercise the real tool and subprocess runner with deterministic model/authentication peers.
import "../runtime.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
const { discoverAgents, requireAgent } = await import("../../agents.ts");
const { runSubagent } = await import("../../api.ts");

if (process.argv.includes("--mode")) {
	const task = process.argv.at(-1)!;
	const usage = { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 } };
	const emit = (event: unknown) => process.stdout.write(JSON.stringify(event) + "\n");
	emit({ type: "tool_execution_start", toolName: "read" });
	if (task.includes("cancel")) {
		setTimeout(() => {}, 30_000);
	} else {
		emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Inspecting." }], usage } });
		const prompt = readFileSync(process.argv[process.argv.indexOf("--append-system-prompt") + 1], "utf8");
		const snapshot = {
			ephemeral: process.argv.includes("--no-session"),
			model: process.argv[process.argv.indexOf("--model") + 1],
			thinking: process.argv[process.argv.indexOf("--thinking") + 1],
			tools: process.argv[process.argv.indexOf("--tools") + 1],
			contextDiscovery: !process.argv.includes("--no-context-files"),
			prompt,
		};
		if (task.includes("failure")) process.stderr.write("child diagnostics");
		const output = task.includes("large") ? "x".repeat(60_000) : task.includes("failure") ? "partial" : JSON.stringify(snapshot);
		emit({ type: "message_end", message: {
			role: "assistant", content: [{ type: "text", text: output }], usage,
			stopReason: task.includes("failure") ? "error" : "stop",
			...(task.includes("failure") ? { errorMessage: "model failure" } : {}),
		} });
	}
} else {
	const root = process.argv[2];
	const scenario = process.argv[3];
	(globalThis as any).subagentTestRoot = root;
	const source = `
		export const getAgentDir = () => globalThis.subagentTestRoot;
		export class ModelRuntime { static async create() { return {}; } }
		export class ModelRegistry {
			find(provider, id) { return {provider, id}; }
			hasConfiguredAuth() { return true; }
			async getApiKeyAndHeaders() { return {ok:true, apiKey:"test"}; }
		}
	`;
	const loader = registerHooks({ resolve(name, context, next) {
		return name === "@earendil-works/pi-coding-agent"
			? { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true }
			: next(name, context);
	} });
	try {
		const { default: extension } = await import("../../index.ts");
		const handlers: Record<string, any> = {};
		let tool: any;
		extension({ registerTool(value: any) { tool = value; }, on(name: string, handler: any) { handlers[name] = handler; } } as any);
		const updates: string[] = [];
		let shutdown: Promise<void> | undefined;
		const ctx = { cwd: root, signal: undefined };
		const update = (partial: any) => {
			updates.push(partial.content[0].text);
			if (scenario === "cancel" && !shutdown) shutdown = handlers.session_shutdown();
		};
		try {
			const outcome = await tool.execute("test", { agent: "reviewer", task: scenario }, undefined, update, ctx);
			if (scenario === "normal") {
				const file = root + "/persistent.jsonl";
				writeFileSync(file, '{"type":"session"}\n');
				const persistent = await runSubagent(requireAgent(discoverAgents(root), "reviewer"), {
					cwd: root, task: "normal", sessionFile: file, instructions: "Workflow assignment.",
				});
				console.log(JSON.stringify({ outcome, updates, persistent }));
			} else console.log(JSON.stringify({ outcome, updates }));
		} catch (error) {
			await shutdown;
			console.log(JSON.stringify({ error: String(error), shutdownComplete: !!shutdown, updates }));
		}
	} finally { loader.deregister(); }
}
