import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface MarkdownContent {
	name: string;
	description: string;
	body: string;
	filePath: string;
	source: "bundled" | "user" | "project";
	/** Supplemental Agent Skills requested by a workflow role. */
	skills: string[];
}

export interface WorkflowContent {
	roles: Record<"implementer" | "reviewer", MarkdownContent>;
	skills: Record<string, MarkdownContent>;
	diagnostics: string[];
	projectAgentsDir?: string;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	const quoted = trimmed.match(/^(['"])(.*)\1$/);
	return (quoted?.[2] ?? trimmed).trim();
}

function parseSkillList(value: string): string[] {
	const inline = value.trim().replace(/^\[/, "").replace(/\]$/, "");
	if (!inline) return [];
	return inline.split(",").map(unquote).filter(Boolean);
}

export function parseMarkdown(content: string, filePath: string, source: MarkdownContent["source"]): MarkdownContent {
	let body = content;
	const fields = new Map<string, string>();
	const supplementalSkills: string[] = [];
	if (content.startsWith("---\n")) {
		const end = content.indexOf("\n---", 4);
		if (end >= 0) {
			const lines = content.slice(4, end).split("\n");
			let listField: string | undefined;
			for (const line of lines) {
				const listItem = line.match(/^\s+-\s+(.+?)\s*$/);
				if (listItem && listField === "skills") {
					supplementalSkills.push(unquote(listItem[1]));
					continue;
				}
				const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
				if (!match) continue;
				fields.set(match[1], unquote(match[2]));
				listField = match[2].trim() ? undefined : match[1];
			}
			body = content.slice(end + 4).replace(/^\s+/, "");
		}
	}
	for (const skill of parseSkillList(fields.get("skills") ?? "")) supplementalSkills.push(skill);
	return {
		name: fields.get("name") || path.basename(path.dirname(filePath)) || path.basename(filePath, ".md"),
		description: fields.get("description") || "",
		body,
		filePath,
		source,
		skills: [...new Set(supplementalSkills)],
	};
}

function readMarkdown(filePath: string, source: MarkdownContent["source"]): MarkdownContent | undefined {
	try {
		return parseMarkdown(readFileSync(filePath, "utf8"), filePath, source);
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

function rolePath(root: string, role: string): string {
	return path.join(root, "workflow", "roles", `${role}.md`);
}

function resolveOne(paths: Array<{ filePath: string; source: MarkdownContent["source"] }>): MarkdownContent {
	let resolved: MarkdownContent | undefined;
	for (const candidate of paths) resolved = readMarkdown(candidate.filePath, candidate.source) ?? resolved;
	if (!resolved) throw new Error(`Missing bundled workflow content: ${paths[0]?.filePath}`);
	return resolved;
}

function discoverSkillScope(root: string, source: MarkdownContent["source"], diagnostics: string[]): Map<string, MarkdownContent> {
	const found = new Map<string, MarkdownContent>();
	for (const filePath of listMarkdownFiles(root).filter((file) => path.basename(file) === "SKILL.md").sort()) {
		const skill = readMarkdown(filePath, source);
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
	const roleSources = (role: string) => [
		{ filePath: path.join(bundled, "roles", `${role}.md`), source: "bundled" as const },
		{ filePath: rolePath(userAgents, role), source: "user" as const },
		...(projectAgents ? [{ filePath: rolePath(projectAgents, role), source: "project" as const }] : []),
	];
	const roles = {
		implementer: resolveOne(roleSources("implementer")),
		reviewer: resolveOne(roleSources("reviewer")),
	};

	const skills = new Map<string, MarkdownContent>();
	const scopes: Array<[string, MarkdownContent["source"]]> = [
		[path.join(bundled, "skills"), "bundled"],
		[path.join(userAgents, "skills"), "user"],
		...(projectAgents ? [[path.join(projectAgents, "skills"), "project"] as [string, MarkdownContent["source"]]] : []),
	];
	for (const [root, source] of scopes) {
		for (const [name, skill] of discoverSkillScope(root, source, diagnostics)) {
			const prior = skills.get(name);
			if (prior) diagnostics.push(`${source} Agent Skill "${name}" overrides ${prior.source}: ${skill.filePath}`);
			skills.set(name, skill);
		}
	}

	for (const [roleName, role] of Object.entries(roles)) {
		for (const name of role.skills) {
			if (!skills.has(name)) diagnostics.push(`${roleName} role requests undiscovered Agent Skill "${name}".`);
		}
	}
	return { roles, skills: Object.fromEntries(skills), diagnostics, projectAgentsDir: projectAgents };
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

export function bundledContentRoot(): string {
	return path.join(extensionRoot(), "content");
}
