import type { MarkdownContent } from "./content.ts";
import type { WorkflowState, WorkflowTodo } from "./state.ts";

export interface WorkflowTodoInput {
	title: string;
	instructions: string[];
	primarySkill?: string;
}

export function resolveSkillTag(value: string | undefined, skills: Record<string, MarkdownContent>): string | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	return Object.hasOwn(skills, normalized) ? normalized : undefined;
}

export function createWorkflowTodos(inputs: WorkflowTodoInput[], skills: Record<string, MarkdownContent> = {}): WorkflowTodo[] {
	if (inputs.length === 0) throw new Error("A workflow plan must contain at least one todo.");
	if (inputs.length > 40) throw new Error("A workflow plan cannot contain more than 40 todos.");
	return inputs.map((input, index) => {
		const title = input.title.trim();
		const instructions = input.instructions.map((instruction) => instruction.trim()).filter(Boolean);
		if (!title) throw new Error(`Workflow todo ${index + 1} requires a title.`);
		if (!instructions.length) throw new Error(`Workflow todo ${index + 1} requires at least one instruction.`);
		const requestedSkill = input.primarySkill?.trim().toLowerCase();
		const primarySkill = resolveSkillTag(requestedSkill, skills);
		return {
			step: index + 1,
			title,
			instructions,
			...(primarySkill ? { primarySkill, skillSource: "plan" as const } : {}),
			...(requestedSkill && !primarySkill ? { skillRequest: requestedSkill } : {}),
			status: "pending",
			attempts: 0,
			automaticReviewCycles: 0,
			revisions: [],
		};
	});
}

export function submitWorkflowPlan(state: WorkflowState, inputs: WorkflowTodoInput[], skills: Record<string, MarkdownContent> = {}): WorkflowTodo[] {
	const todos = createWorkflowTodos(inputs, skills);
	state.todos = todos;
	state.currentStep = todos[0]?.step;
	state.executing = false;
	state.paused = false;
	return todos;
}

export function formatWorkflowTodo(todo: Pick<WorkflowTodo, "step" | "title" | "instructions" | "primarySkill" | "skillRequest">): string {
	const skill = todo.primarySkill ?? todo.skillRequest;
	const lines = [`${todo.step}. ${skill ? `[${skill}] ` : ""}${todo.title}`];
	for (const instruction of todo.instructions) {
		const [first = "", ...continuation] = instruction.split("\n");
		lines.push(`   - ${first}`, ...continuation.map((line) => `     ${line}`));
	}
	return lines.join("\n");
}

export function formatWorkflowPlan(todos: Array<Pick<WorkflowTodo, "step" | "title" | "instructions" | "primarySkill" | "skillRequest">>): string {
	return `Plan:\n${todos.map(formatWorkflowTodo).join("\n\n")}`;
}

export function extractRelevantFiles(todo: Pick<WorkflowTodo, "title" | "instructions">): string[] {
	const files = new Set<string>();
	const text = [todo.title, ...todo.instructions].join("\n");
	for (const match of text.matchAll(/`([^`]+\.[A-Za-z0-9_+-]+)`/g)) files.add(match[1]);
	for (const match of text.matchAll(/(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.(?:py|ts|tsx|js|jsx|cpp|cc|cxx|h|hpp|hxx|toml|txt))/g)) files.add(match[1]);
	return [...files].slice(0, 30);
}

export function planFormatInstructions(skills: Record<string, MarkdownContent> = {}): string {
	const available = Object.values(skills)
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((skill) => `- ${skill.name}: ${skill.description}`);
	return `
Workflow plan submission:
- Submit every final plan with workflow_submit_plan instead of writing a Markdown plan.
- Give each todo a concise title and an instructions array containing every requirement the implementer and reviewer must follow.
- Todos must be independently implementable and reviewable.
- A todo may select one discovered Agent Skill when that skill directly applies.
- Skills are optional. Leave primarySkill unset when no discovered skill is relevant; never guess an unrelated skill.
- Use exact skill names.

Discovered Agent Skills:
${available.length ? available.join("\n") : "- None. Leave primarySkill unset."}
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
