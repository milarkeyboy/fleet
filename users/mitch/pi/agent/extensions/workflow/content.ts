import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ContentSource = "user" | "project";

export interface MarkdownContent {
	name: string;
	description: string;
	body: string;
	filePath: string;
	source: ContentSource;
}

export interface WorkflowContent {
	planner: string;
	skills: Record<string, MarkdownContent>;
	diagnostics: string[];
	projectAgentsDir?: string;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	const quoted = trimmed.match(/^(['"])(.*)\1$/);
	return (quoted?.[2] ?? trimmed).trim();
}

export function parseAgentSkill(content: string, filePath: string, source: ContentSource): MarkdownContent {
	let body = content;
	const fields = new Map<string, string>();
	if (content.startsWith("---\n")) {
		const end = content.indexOf("\n---", 4);
		if (end >= 0) {
			for (const line of content.slice(4, end).split("\n")) {
				const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
				if (match) fields.set(match[1], unquote(match[2]));
			}
			body = content.slice(end + 4).replace(/^\s+/, "");
		}
	}
	return {
		name: fields.get("name") || path.basename(path.dirname(filePath)),
		description: fields.get("description") || "",
		body,
		filePath,
		source,
	};
}

function readAgentSkill(filePath: string, source: ContentSource): MarkdownContent | undefined {
	try {
		return parseAgentSkill(readFileSync(filePath, "utf8"), filePath, source);
	} catch {
		return undefined;
	}
}

function extensionRoot(): string {
	return path.dirname(fileURLToPath(import.meta.url));
}

function nearestProjectAgents(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	while (true) {
		const agents = path.join(current, ".agents");
		if (existsSync(agents) && statSync(agents).isDirectory()) return agents;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function discoverSkillScope(root: string, source: ContentSource, diagnostics: string[]): Map<string, MarkdownContent> {
	const found = new Map<string, MarkdownContent>();
	for (const filePath of listMarkdownFiles(root).filter((file) => path.basename(file) === "SKILL.md").sort()) {
		const skill = readAgentSkill(filePath, source);
		if (!skill) {
			diagnostics.push(`Could not read Agent Skill: ${filePath}`);
			continue;
		}
		if (!skill.description) {
			diagnostics.push(`Ignored Agent Skill without a description: ${filePath}`);
			continue;
		}
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || skill.name.length > 64) {
			diagnostics.push(`Ignored Agent Skill with invalid name "${skill.name}": ${filePath}`);
			continue;
		}
		if (path.basename(path.dirname(filePath)) !== skill.name) {
			diagnostics.push(`Ignored Agent Skill "${skill.name}" because its directory name does not match: ${filePath}`);
			continue;
		}
		if (found.has(skill.name)) {
			diagnostics.push(`Ignored duplicate ${source} Agent Skill "${skill.name}": ${filePath}`);
			continue;
		}
		found.set(skill.name, skill);
	}
	return found;
}

export function discoverWorkflowContent(cwd: string, projectTrusted: boolean, home = os.homedir()): WorkflowContent {
	const bundled = path.join(extensionRoot(), "content");
	const userAgents = path.join(home, ".agents");
	const projectAgents = projectTrusted ? nearestProjectAgents(cwd) : undefined;
	const diagnostics: string[] = [];
	const planner = readFileSync(path.join(bundled, "planner.md"), "utf8");

	const skills = new Map<string, MarkdownContent>();
	const scopes: Array<[string, ContentSource]> = [
		[path.join(userAgents, "skills"), "user"],
		...(projectAgents ? [[path.join(projectAgents, "skills"), "project"] as [string, ContentSource]] : []),
	];
	for (const [root, source] of scopes) {
		for (const [name, skill] of discoverSkillScope(root, source, diagnostics)) {
			const prior = skills.get(name);
			if (prior) diagnostics.push(`${source} Agent Skill "${name}" overrides ${prior.source}: ${skill.filePath}`);
			skills.set(name, skill);
		}
	}

	return { planner, skills: Object.fromEntries(skills), diagnostics, projectAgentsDir: projectAgents };
}

export function listMarkdownFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const output: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) output.push(...listMarkdownFiles(full));
		else if (entry.isFile() && entry.name.endsWith(".md")) output.push(full);
	}
	return output;
}
