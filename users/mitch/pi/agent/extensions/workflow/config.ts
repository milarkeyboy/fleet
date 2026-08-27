import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export const WORKFLOW_ROLES = ["implementer", "reviewer"] as const;
export type WorkflowRole = typeof WORKFLOW_ROLES[number];

export const WORKFLOW_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type WorkflowThinkingLevel = typeof WORKFLOW_THINKING_LEVELS[number];

export interface WorkflowRoleModelConfig {
	model: string;
	thinkingLevel?: WorkflowThinkingLevel;
}

export type WorkflowModelConfig = Partial<Record<WorkflowRole, WorkflowRoleModelConfig>>;
export type CompleteWorkflowModelConfig = Record<WorkflowRole, WorkflowRoleModelConfig>;

type WorkflowModelRegistry = Pick<ModelRegistry, "find" | "hasConfiguredAuth" | "getApiKeyAndHeaders">;

export async function createWorkflowSubprocessModelRegistry(signal?: AbortSignal): Promise<ModelRegistry> {
	const { ModelRegistry, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const runtime = await ModelRuntime.create({ allowModelNetwork: false, signal });
	return new ModelRegistry(runtime);
}

export function workflowConfigPath(agentDir: string): string {
	return path.join(agentDir, "workflow", "config.json");
}

export function isWorkflowRole(value: string): value is WorkflowRole {
	return WORKFLOW_ROLES.includes(value as WorkflowRole);
}

export function isWorkflowThinkingLevel(value: string): value is WorkflowThinkingLevel {
	return WORKFLOW_THINKING_LEVELS.includes(value as WorkflowThinkingLevel);
}

export function isProviderModel(value: string): boolean {
	const separator = value.indexOf("/");
	return separator > 0 && separator < value.length - 1 && !/\s/.test(value);
}

function parseRoleConfig(value: unknown, role: WorkflowRole): WorkflowRoleModelConfig | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Workflow model configuration for ${role} must be an object.`);
	const candidate = value as { model?: unknown; thinkingLevel?: unknown };
	if (typeof candidate.model !== "string" || !isProviderModel(candidate.model)) {
		throw new Error(`Workflow model configuration for ${role} must use a provider/model identifier.`);
	}
	if (candidate.thinkingLevel !== undefined && (typeof candidate.thinkingLevel !== "string" || !isWorkflowThinkingLevel(candidate.thinkingLevel))) {
		throw new Error(`Workflow thinking level for ${role} must be one of: ${WORKFLOW_THINKING_LEVELS.join(", ")}.`);
	}
	return {
		model: candidate.model,
		...(candidate.thinkingLevel !== undefined ? { thinkingLevel: candidate.thinkingLevel as WorkflowThinkingLevel } : {}),
	};
}

export function parseWorkflowModelConfig(value: unknown): WorkflowModelConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workflow model configuration must be a JSON object.");
	const candidate = value as Record<string, unknown>;
	const config: WorkflowModelConfig = {};
	for (const role of WORKFLOW_ROLES) {
		const roleConfig = parseRoleConfig(candidate[role], role);
		if (roleConfig) config[role] = roleConfig;
	}
	return config;
}

export async function loadWorkflowModelConfig(agentDir: string): Promise<WorkflowModelConfig> {
	const filePath = workflowConfigPath(agentDir);
	let source: string;
	try {
		source = await readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	try {
		return parseWorkflowModelConfig(JSON.parse(source));
	} catch (error) {
		throw new Error(`Invalid workflow model configuration at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function requireExecutableWorkflowModels(
	config: WorkflowModelConfig,
	registry: WorkflowModelRegistry,
): Promise<CompleteWorkflowModelConfig> {
	const validated = parseWorkflowModelConfig(config);
	const missing = WORKFLOW_ROLES.filter((role) => !validated[role]);
	if (missing.length) {
		throw new Error(
			`Workflow execution requires explicit model configuration for both roles. Missing: ${missing.join(", ")}. ` +
			`Use /workflow model <implementer|reviewer> <provider/model> [thinking-level].`,
		);
	}

	const complete = validated as CompleteWorkflowModelConfig;
	for (const role of WORKFLOW_ROLES) {
		const assignment = complete[role];
		const separator = assignment.model.indexOf("/");
		const provider = assignment.model.slice(0, separator);
		const modelId = assignment.model.slice(separator + 1);
		const model = registry.find(provider, modelId);
		if (!model) {
			throw new Error(
				`Workflow ${role} model "${assignment.model}" is not available to the isolated workflow subprocess. ` +
				"Subagents run with --no-extensions, so extension-registered models cannot be used; configure the model in pi's built-in catalog or global models.json.",
			);
		}
		if (!registry.hasConfiguredAuth(model)) {
			throw new Error(
				`Workflow ${role} model "${assignment.model}" is not authenticated in the isolated workflow subprocess. ` +
				`Top-level --api-key overrides are runtime-only and are not inherited; run /login ${provider} or configure credentials through auth.json, models.json, or the subprocess environment.`,
			);
		}
		const auth = await registry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			throw new Error(`Workflow ${role} model "${assignment.model}" subprocess authentication failed: ${auth.error}`);
		}
	}
	return complete;
}

export async function writeWorkflowModelConfig(config: WorkflowModelConfig, agentDir: string): Promise<void> {
	const validated = parseWorkflowModelConfig(config);
	const filePath = workflowConfigPath(agentDir);
	const directory = path.dirname(filePath);
	const tempPath = path.join(directory, `.config.json.${process.pid}.${randomUUID()}.tmp`);
	await mkdir(directory, { recursive: true });
	try {
		await writeFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await rename(tempPath, filePath);
	} finally {
		await rm(tempPath, { force: true });
	}
}

export async function setWorkflowRoleModel(
	role: WorkflowRole,
	model: string,
	thinkingLevel: WorkflowThinkingLevel | undefined,
	agentDir: string,
): Promise<WorkflowModelConfig> {
	const config = await loadWorkflowModelConfig(agentDir);
	config[role] = { model, ...(thinkingLevel ? { thinkingLevel } : {}) };
	await writeWorkflowModelConfig(config, agentDir);
	return config;
}

export function formatWorkflowModels(config: WorkflowModelConfig): string {
	return WORKFLOW_ROLES.map((role) => {
		const assignment = config[role];
		if (!assignment) return `${role}: not configured`;
		return `${role}: ${assignment.model}${assignment.thinkingLevel ? ` (thinking: ${assignment.thinkingLevel})` : ""}`;
	}).join("\n");
}
