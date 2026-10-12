import { readFile } from "node:fs/promises";
import path from "node:path";
import { discoverAgents, requireAgent, type AgentDefinition } from "../subagent/agents.ts";
import { createSubprocessModelRegistry, requireExecutableAgents } from "../subagent/models.ts";

import { WORKFLOW_ROLES, type WorkflowRole } from "./state.ts";

export const DEFAULT_MAX_REVIEW_CYCLES = 2;
const DEFAULT_AGENTS: Record<WorkflowRole, string> = { implementer: "implementer", "design-reviewer": "design-reviewer", "code-reviewer": "reviewer" };
export interface WorkflowConfig {
	agents?: Partial<Record<WorkflowRole, string>>;
	"max-review-cycles"?: number;
}
export type CompleteWorkflowConfig = WorkflowConfig & Record<WorkflowRole, AgentDefinition>;

export function workflowConfigPath(agentDir: string): string {
	return path.join(agentDir, "workflow", "config.json");
}

export function parseWorkflowConfig(value: unknown): WorkflowConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workflow configuration must be a JSON object.");
	const config = value as Record<string, unknown>;
	if (Object.keys(config).some((key) => !["agents", "max-review-cycles"].includes(key))) {
		throw new Error("Workflow configuration accepts agents and max-review-cycles only. Put agent prompts and settings in <agent-dir>/agents/<name>.md.");
	}
	const parsed: WorkflowConfig = {};
	if (config.agents !== undefined) {
		if (!config.agents || typeof config.agents !== "object" || Array.isArray(config.agents)) {
			throw new Error("Workflow agents must map workflow roles to agent names.");
		}
		const agents = config.agents as Record<string, unknown>;
		if (Object.keys(agents).some((role) => !WORKFLOW_ROLES.includes(role as WorkflowRole))) {
			throw new Error("Workflow agents supports implementer, design-reviewer and code-reviewer roles only.");
		}
		parsed.agents = {};
		for (const role of WORKFLOW_ROLES) {
			const name = agents[role];
			if (name === undefined) continue;
			if (typeof name !== "string" || !name.trim()) throw new Error(`Workflow agents.${role} must be a non-empty agent name.`);
			parsed.agents[role] = name;
		}
	}
	const max = config["max-review-cycles"];
	if (max !== undefined) {
		if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1) throw new Error("Workflow max-review-cycles must be a positive safe integer.");
		parsed["max-review-cycles"] = max;
	}
	return parsed;
}

export async function loadWorkflowConfig(agentDir: string): Promise<WorkflowConfig> {
	const file = workflowConfigPath(agentDir);
	try { return parseWorkflowConfig(JSON.parse(await readFile(file, "utf8"))); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`Invalid workflow configuration at ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function resolveWorkflowAgents(agentDir: string, settings: WorkflowConfig = {}): Record<WorkflowRole, AgentDefinition> {
	const found = discoverAgents(agentDir);
	return Object.fromEntries(WORKFLOW_ROLES.map((role) => {
		const agent = requireAgent(found, settings.agents?.[role] ?? DEFAULT_AGENTS[role]);
		if (role !== "implementer" && agent.tools.some((tool) => !["read", "grep", "find", "ls"].includes(tool))) {
			throw new Error(`Workflow ${role} tools must remain read-only: read, grep, find, ls. Edit ${agent.filePath}.`);
		}
		return [role, agent];
	})) as Record<WorkflowRole, AgentDefinition>;
}

/** Resolve and preflight all three roles before allocating conversations or changing execution state. */
export async function loadWorkflowExecution(agentDir: string, signal?: AbortSignal): Promise<CompleteWorkflowConfig> {
	const settings = await loadWorkflowConfig(agentDir);
	const agents = resolveWorkflowAgents(agentDir, settings);
	await requireExecutableAgents(Object.values(agents), await createSubprocessModelRegistry(signal));
	return { ...settings, ...agents };
}

export function formatWorkflowModels(agents: Record<WorkflowRole, AgentDefinition>): string {
	return Object.entries(agents).map(([role, agent]) => `${role} → ${agent.name}: ${agent.model} (thinking: ${agent.thinkingLevel ?? "off"}) — ${agent.filePath}`).join("\n");
}
