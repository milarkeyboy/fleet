import { readFile } from "node:fs/promises";
import path from "node:path";
import { discoverAgents, requireAgent, type AgentDefinition } from "../subagent/agents.ts";
import { createSubprocessModelRegistry, requireExecutableAgents } from "../subagent/models.ts";

export const DEFAULT_MAX_REVIEW_CYCLES = 2;
export interface WorkflowConfig {
	agents?: Partial<Record<"implementer" | "reviewer", string>>;
	"max-review-cycles"?: number;
}
export type CompleteWorkflowConfig = WorkflowConfig & Record<"implementer" | "reviewer", AgentDefinition>;

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
			throw new Error("Workflow agents must map implementer and reviewer roles to agent names.");
		}
		const agents = config.agents as Record<string, unknown>;
		if (Object.keys(agents).some((role) => !["implementer", "reviewer"].includes(role))) {
			throw new Error("Workflow agents supports implementer and reviewer roles only.");
		}
		parsed.agents = {};
		for (const role of ["implementer", "reviewer"] as const) {
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

export function resolveWorkflowAgents(agentDir: string, settings: WorkflowConfig = {}): Pick<CompleteWorkflowConfig, "implementer" | "reviewer"> {
	const found = discoverAgents(agentDir);
	const implementer = requireAgent(found, settings.agents?.implementer ?? "implementer");
	const reviewer = requireAgent(found, settings.agents?.reviewer ?? "reviewer");
	if (reviewer.tools.some((tool) => !["read", "grep", "find", "ls"].includes(tool))) {
		throw new Error(`Workflow reviewer tools must remain read-only: read, grep, find, ls. Edit ${reviewer.filePath}.`);
	}
	return { implementer, reviewer };
}

/** Resolve and preflight both roles before allocating conversations or changing execution state. */
export async function loadWorkflowExecution(agentDir: string, signal?: AbortSignal): Promise<CompleteWorkflowConfig> {
	const settings = await loadWorkflowConfig(agentDir);
	const agents = resolveWorkflowAgents(agentDir, settings);
	await requireExecutableAgents(Object.values(agents), await createSubprocessModelRegistry(signal));
	return { ...settings, ...agents };
}

export function formatWorkflowModels(agents: Pick<CompleteWorkflowConfig, "implementer" | "reviewer">): string {
	return Object.entries(agents).map(([role, agent]) => `${role} → ${agent.name}: ${agent.model} (thinking: ${agent.thinkingLevel ?? "off"}) — ${agent.filePath}`).join("\n");
}
