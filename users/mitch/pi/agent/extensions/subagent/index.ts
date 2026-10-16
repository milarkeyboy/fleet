import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents, requireAgent } from "./agents.ts";
import { runSubagent } from "./api.ts";
import { createSubprocessModelRegistry, requireExecutableAgents } from "./models.ts";
import { AgentRunError } from "./runner.ts";

const OUTPUT_LIMIT = 50 * 1024;

function bounded(text: string): string {
	if (Buffer.byteLength(text) <= OUTPUT_LIMIT) return text;
	const suffix = "\n[Output truncated; full result is retained in tool details.]";
	// Streaming decoding leaves an incomplete trailing UTF-8 character out of the excerpt.
	const prefix = new TextDecoder().decode(Buffer.from(text).subarray(0, OUTPUT_LIMIT - Buffer.byteLength(suffix)), { stream: true });
	return prefix + suffix;
}

export default function subagentExtension(pi: ExtensionAPI): void {
	const found = discoverAgents(getAgentDir());
	// Each call owns its cancellation; independent callers choose whether runs may overlap.
	const active = new Map<AbortController, Promise<unknown>>();
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate one task to a global subagent with a fresh, isolated conversation.",
			"Supply all necessary context in the task; children share the working tree.",
			"Callers are responsible for avoiding conflicting concurrent work.",
			"Available agents:",
			...Object.values(found.agents).map((agent) => `${agent.name}: ${agent.description}`),
			...found.diagnostics,
		].join("\n"),
		parameters: Type.Object({
			agent: Type.String({ minLength: 1, description: "Name of a global agent definition" }),
			task: Type.String({ minLength: 1, description: "Self-contained assignment and relevant context" }),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const controller = new AbortController();
			const signals = [controller.signal, signal, ctx.signal].filter((value): value is AbortSignal => value !== undefined);
			const combined = AbortSignal.any(signals);
			const promise = (async () => {
				combined.throwIfAborted();
				const agent = requireAgent(discoverAgents(getAgentDir()), params.agent);
				await requireExecutableAgents([agent], await createSubprocessModelRegistry(combined));
				return runSubagent(agent, {
					cwd: ctx.cwd, task: params.task, signal: combined,
					onUpdate(text) { onUpdate?.({ content: [{ type: "text", text: bounded(text) }], details: undefined }); },
				});
			})();
			active.set(controller, promise);
			try {
				const result = await promise;
				return { content: [{ type: "text", text: bounded(result.output) }], details: result, usage: result.usage };
			} catch (error) {
				// Preserve usage and partial results when a child fails after producing events.
				if (!(error instanceof AgentRunError)) throw error;
				return {
					content: [{ type: "text", text: bounded(`${error.message}\n\n${error.result.output}`) }],
					details: error.result, usage: error.result.usage, isError: true,
				};
			} finally { active.delete(controller); }
		},
	});

	async function stop(): Promise<void> {
		for (const controller of active.keys()) controller.abort();
		await Promise.allSettled([...active.values()]);
	}
	pi.on("session_shutdown", stop);
	pi.on("session_before_tree", stop);
	pi.on("session_before_fork", stop);
}
