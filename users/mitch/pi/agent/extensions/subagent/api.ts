import type { AgentDefinition } from "./agents.ts";
import { runAgent, type AgentRunOptions, type AgentRunResult } from "./runner.ts";

export interface AgentInvocation {
	cwd: string;
	task: string;
	sessionFile?: string;
	/** Caller-owned assignment context and protocols are appended to the shared prompt. */
	instructions?: string;
	skillPaths?: string[];
	signal?: AbortSignal;
	onUpdate?: AgentRunOptions["onUpdate"];
	onProcess?: AgentRunOptions["onProcess"];
}

export function runSubagent(
	agent: AgentDefinition,
	invocation: AgentInvocation,
	run: typeof runAgent = runAgent,
): Promise<AgentRunResult> {
	const { instructions, ...options } = invocation;
	return run({
		...options, roleName: agent.name,
		systemPrompt: [agent.body.trim(), instructions?.trim()].filter(Boolean).join("\n\n---\n\n"),
		skillPaths: invocation.skillPaths ?? [],
		model: agent.model, thinkingLevel: agent.thinkingLevel,
		tools: agent.tools, contextFileDiscovery: agent.contextFileDiscovery,
	});
}
