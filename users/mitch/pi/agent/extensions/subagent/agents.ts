import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
const TOOLS = new Set(["read", "grep", "find", "ls", "bash", "edit", "write"]);

export interface AgentDefinition {
	name: string;
	description: string;
	body: string;
	filePath: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
	tools: string[];
	contextFileDiscovery?: boolean;
}

export interface AgentDiscovery {
	agents: Record<string, AgentDefinition>;
	diagnostics: string[];
}

/** Resolve global definitions once per invocation so every caller uses the same settings. */
export function discoverAgents(agentDir: string): AgentDiscovery {
	const directory = path.join(agentDir, "agents");
	let entries;
	try { entries = readdirSync(directory, { withFileTypes: true }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { agents: {}, diagnostics: [] };
		throw error;
	}
	const agents: Record<string, AgentDefinition> = {};
	const diagnostics: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
		const filePath = path.join(directory, entry.name);
		try {
			const agent = parseAgent(readFileSync(filePath, "utf8"), filePath);
			agents[agent.name] = agent;
		} catch (error) {
			diagnostics.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { agents, diagnostics };
}

export function parseAgent(markdown: string, filePath: string): AgentDefinition {
	const { frontmatter: config, body } = parseFrontmatter<Record<string, unknown>>(markdown);
	const name = config.name;
	if (typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
		throw new Error("name must use lowercase letters, numbers and hyphens.");
	}
	if (path.basename(filePath) !== `${name}.md`) throw new Error("name must match the Markdown filename.");
	if (typeof config.description !== "string" || !config.description.trim()) throw new Error("description must be a non-empty string.");
	if (typeof config.model !== "string" || !/^[^/\s]+\/\S+$/.test(config.model)) throw new Error("model must be an explicit provider/model identifier.");
	if (config.thinkingLevel !== undefined && !THINKING_LEVELS.includes(config.thinkingLevel as ThinkingLevel)) {
		throw new Error(`thinkingLevel must be one of: ${THINKING_LEVELS.join(", ")}.`);
	}
	const tools = Array.isArray(config.tools) ? config.tools : typeof config.tools === "string" ? config.tools.split(",").map((tool) => tool.trim()) : [];
	if (!tools.length || tools.some((tool) => typeof tool !== "string" || !TOOLS.has(tool))) {
		throw new Error(`tools must be a non-empty list drawn from: ${[...TOOLS].join(", ")}.`);
	}
	const discovery = config["context-file-discovery"];
	if (discovery !== undefined && typeof discovery !== "boolean") throw new Error("context-file-discovery must be a boolean.");
	if (!body.trim()) throw new Error("The agent prompt must be non-empty.");
	return {
		name, description: config.description, body, filePath, model: config.model,
		tools: [...new Set(tools)] as string[],
		...(config.thinkingLevel !== undefined ? { thinkingLevel: config.thinkingLevel as ThinkingLevel } : {}),
		...(discovery !== undefined ? { contextFileDiscovery: discovery } : {}),
	};
}

export function requireAgent(discovery: AgentDiscovery, name: string): AgentDefinition {
	if (Object.hasOwn(discovery.agents, name)) return discovery.agents[name];
	throw new Error(`Unknown or invalid subagent "${name}". Configure <agent-dir>/agents/${name}.md.\n${discovery.diagnostics.join("\n")}`.trim());
}
