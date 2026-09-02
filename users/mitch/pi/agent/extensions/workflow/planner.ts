import type { MarkdownContent } from "./content.ts";
import type { WorkflowTodo } from "./state.ts";

export function resolveSkillTag(value: string | undefined, skills: Record<string, MarkdownContent>): string | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	return Object.hasOwn(skills, normalized) ? normalized : undefined;
}

export function extractWorkflowTodos(message: string, skills: Record<string, MarkdownContent> = {}): WorkflowTodo[] {
	const header = message.match(/(?:^|\n)\s*\*{0,2}(?:Workflow\s+)?Plan\s*:\*{0,2}\s*\n/i);
	if (!header) return [];
	const section = message.slice((header.index ?? 0) + header[0].length);
	const todos: WorkflowTodo[] = [];
	for (const match of section.matchAll(/^\s*(?:[-*]\s+)?\d+[.)]\s+(?:\[([^\]]+)\]\s*)?(.+\S)\s*$/gm)) {
		const tag = match[1]?.trim().toLowerCase();
		const primarySkill = resolveSkillTag(tag, skills);
		const text = match[2].replace(/\s+/g, " ").trim();
		if (text.length < 4) continue;
		todos.push({
			step: todos.length + 1,
			text,
			...(primarySkill ? { primarySkill, skillSource: "plan" as const } : {}),
			...(tag && !primarySkill ? { skillRequest: tag } : {}),
			status: "pending",
			attempts: 0,
			automaticReviewCycles: 0,
			changedFiles: [],
		});
	}
	return todos.slice(0, 40);
}

export function extractRelevantFiles(text: string): string[] {
	const files = new Set<string>();
	for (const match of text.matchAll(/`([^`]+\.[A-Za-z0-9_+-]+)`/g)) files.add(match[1]);
	for (const match of text.matchAll(/(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.(?:py|ts|tsx|js|jsx|cpp|cc|cxx|h|hpp|hxx|toml|txt))/g)) files.add(match[1]);
	return [...files].slice(0, 30);
}

export function planFormatInstructions(skills: Record<string, MarkdownContent> = {}): string {
	const available = Object.values(skills)
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((skill) => `- [${skill.name}]: ${skill.description}`);
	return `
Workflow plan format:
- Produce the final plan under exactly "Plan:".
- Use numbered todos that are independently implementable and reviewable.
- A todo may start with one discovered Agent Skill tag when that skill directly applies.
- Tags are optional. Leave a todo untagged when no discovered skill is relevant; never guess an unrelated skill.
- Use exact skill names.

Discovered Agent Skills:
${available.length ? available.join("\n") : "- None. Produce untagged todos."}

Example:
Plan:
1. Implement the general workflow state migration.
2. [python] Update Python bindings and focused tests.
`.trim();
}

export function appendPlanningInstructions(
	systemPrompt: string,
	plannerPrompt: string,
	skills: Record<string, MarkdownContent> = {},
): string {
	const planning = [plannerPrompt.trim(), planFormatInstructions(skills)].filter(Boolean).join("\n\n");
	return `${systemPrompt}\n\n${planning}`;
}
