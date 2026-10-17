// Exercise real lifecycle tools and subprocesses with deterministic provider/authentication peers.
import "../runtime.ts";
import { appendFileSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { installedPi } from "../pi.ts";
const { discoverAgents, requireAgent } = await import("../../agents.ts");
const { getConversationService } = await import("../../api.ts");

if (process.argv.includes("--mode")) {
	const task = process.argv.at(-1)!;
	const file = process.argv[process.argv.indexOf("--session") + 1];
	const history = readFileSync(file, "utf8");
	const prompt = readFileSync(process.argv[process.argv.indexOf("--append-system-prompt") + 1], "utf8");
	const usage = { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 } };
	const emit = (event: unknown) => process.stdout.write(JSON.stringify(event) + "\n");
	let sequence = 0;
	const message = (value: Record<string, unknown>) => {
		const completed = { ...value, timestamp: Date.now() + sequence };
		appendFileSync(file, JSON.stringify({ type: "message", id: `test-${Date.now()}-${sequence++}`, message: completed }) + "\n");
		emit({ type: "message_end", message: completed });
	};
	message({ role: "system", content: prompt });
	message({ role: "user", content: task });
	emit({ type: "tool_execution_start", toolName: "read", toolCallId: "read-1", args: { path: "file.txt" } });
	if (task.includes("cancel")) {
		setTimeout(() => {}, 30_000);
	} else {
		message({ role: "assistant", content: [{ type: "text", text: "Inspecting." }], usage });
		const snapshot = {
			model: process.argv[process.argv.indexOf("--model") + 1],
			thinking: process.argv[process.argv.indexOf("--thinking") + 1],
			tools: process.argv[process.argv.indexOf("--tools") + 1],
			contextDiscovery: !process.argv.includes("--no-context-files"), prompt,
		};
		if (task.includes("failure")) process.stderr.write("child diagnostics");
		const output = task.includes("large") ? "x".repeat(60_000) : task.includes("failure") ? "partial" : task.includes("recall") ? (history.includes("remember-this") ? "remembered" : "forgotten") : JSON.stringify(snapshot);
		message({ role: "assistant", content: [{ type: "text", text: output }], usage,
			stopReason: task.includes("failure") ? "error" : "stop", ...(task.includes("failure") ? { errorMessage: "model failure" } : {}),
		});
	}
} else {
	const root = process.argv[2];
	const scenario = process.argv[3];
	(globalThis as any).subagentTestRoot = root;
	const source = `
		export * from ${JSON.stringify(installedPi()!.api)};
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
			? { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true } : next(name, context);
	} });
	try {
		const { default: extension } = await import("../../index.ts");
		const handlers: Record<string, any> = {}, tools: Record<string, any> = {};
		extension({ registerTool(value: any) { tools[value.name] = value; }, on(name: string, handler: any) { handlers[name] = handler; }, registerCommand() {}, registerShortcut() {} } as any);
		const updates: string[] = [];
		let shutdown: Promise<void> | undefined;
		const ctx = { cwd: root, signal: undefined, sessionManager: { getSessionId: () => "parent" } };
		const service = getConversationService(path.join(root, "subagents"));
		const owner = { parentSessionId: "parent", creator: "adhoc", cwd: root };
		const call = (name: string, args: any) => tools[name].execute("test", args, undefined, (partial: any) => {
			updates.push(partial.content[0].text);
			if (scenario === "cancel" && !shutdown) shutdown = handlers.session_shutdown({}, ctx);
		}, ctx);
		try {
			if (scenario === "list") console.log(JSON.stringify(await call("subagent_list", {})));
			else if (scenario === "continue") console.log(JSON.stringify(await call("subagent", { agent: "reviewer", task: "recall", handle: process.argv[4] })));
			else {
				const outcome = await call("subagent", { agent: "reviewer", task: scenario === "create" ? "remember-this" : scenario });
				const handle = outcome.structuredContent.handle;
				if (scenario === "normal") {
					const workflowOwner = { ...owner, creator: "workflow:test" };
					const workflowHandle = service.create(workflowOwner, "Workflow review");
					const persistent = await service.run(workflowOwner, workflowHandle, requireAgent(discoverAgents(root), "reviewer"), { task: "normal", instructions: "Workflow assignment." });
					console.log(JSON.stringify({ outcome, updates, persistent }));
				} else if (scenario === "delete") {
					console.log(JSON.stringify({ outcome, deletion: await call("subagent_delete", { handle }), repeated: await call("subagent_delete", { handle }), listed: await call("subagent_list", {}) }));
				} else if (scenario === "ownership") {
					const workflowHandle = service.create({ ...owner, creator: "workflow:test" }, "Workflow review");
					let deletionError = "", reuseError = "";
					try { await call("subagent_delete", { handle: workflowHandle }); } catch (error) { deletionError = String(error); }
					try { await call("subagent", { agent: "reviewer", task: "normal", handle: workflowHandle }); } catch (error) { reuseError = String(error); }
					console.log(JSON.stringify({ outcome, deletionError, reuseError, listed: await call("subagent_list", {}), parentCount: service.listParent("parent").length }));
				} else {
					await shutdown;
					console.log(JSON.stringify({ outcome, updates, shutdownComplete: !!shutdown, conversations: service.list(owner), transcript: service.inspect("parent", handle) }));
				}
			}
		} catch (error) {
			await shutdown;
			console.log(JSON.stringify({ error: String(error), shutdownComplete: !!shutdown, updates }));
		}
	} finally { loader.deregister(); }
}
