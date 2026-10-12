import { randomUUID } from "node:crypto";
import type { MarkdownContent } from "./content.ts";
import { isTodoComplete, type WorkflowPlanTodo, type WorkflowState, type WorkflowTodo } from "./state.ts";

export interface WorkflowTodoInput {
	id?: string;
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
			id: randomUUID(),
			step: index + 1,
			title,
			instructions,
			...(primarySkill ? { primarySkill, skillSource: "plan" as const } : {}),
			...(requestedSkill && !primarySkill ? { skillRequest: requestedSkill } : {}),
			status: "pending",
			attempts: 0,
			automaticReviewCycles: 0,
			revisions: [],
			designs: [],
			feedbackStart: 0,
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

/** Full-plan amendments keep existing identities; completed work remains immutable. */
export function stageWorkflowAmendment(state: WorkflowState, inputs: WorkflowTodoInput[], baseRevision: number, affectedIds: string[], skills: Record<string, MarkdownContent> = {}): void {
	if (!state.amending || baseRevision !== state.planRevision) throw new Error("Plan amendment is stale. Read the current plan and submit again.");
	const proposed = createWorkflowTodos(inputs, skills).map((todo, index): WorkflowPlanTodo => {
		if (todo.skillRequest) throw new Error(`Unknown Agent Skill: ${todo.skillRequest}`);
		return { id: inputs[index].id ?? todo.id, title: todo.title, instructions: todo.instructions, ...(todo.primarySkill ? { primarySkill: todo.primarySkill } : {}) };
	});
	const existing = new Map(state.todos.map((todo) => [todo.id, todo]));
	if (new Set(proposed.map((todo) => todo.id)).size !== proposed.length) throw new Error("Todo identities must be unique.");
	for (const input of inputs) if (input.id && !existing.has(input.id)) throw new Error(`Unknown todo identity: ${input.id}`);
	for (const todo of state.todos) if (!proposed.some((item) => item.id === todo.id)) throw new Error("Retain all existing todo identities; split work by editing an unfinished todo and adding new todos.");
	const affected = new Set(affectedIds);
	for (const id of affected) if (!existing.has(id) || isTodoComplete(existing.get(id)!) || existing.get(id)!.status === "aborted") throw new Error("Affected identities must refer to unfinished todos. Add corrective todos for completed work.");
	for (const todo of proposed) {
		const previous = existing.get(todo.id);
		if (!previous) { affected.add(todo.id); continue; }
		const changed = JSON.stringify(planTodo(previous)) !== JSON.stringify(todo);
		if (changed && (isTodoComplete(previous) || previous.status === "aborted")) throw new Error("Completed todos are immutable; add a corrective todo.");
		if (changed && !affected.has(todo.id)) throw new Error(`Confirm changed todo ${previous.step} in affectedIds.`);
	}
	const completed = state.todos.filter(isTodoComplete).map((todo) => todo.id);
	if (JSON.stringify(proposed.slice(0, completed.length).map((todo) => todo.id)) !== JSON.stringify(completed)) throw new Error("Keep completed todos at the beginning in their existing order.");
	state.pendingAmendment = { baseRevision, todos: proposed, affectedIds: [...affected] };
}

export function planTodo(todo: WorkflowTodo): WorkflowPlanTodo {
	return { id: todo.id, title: todo.title, instructions: [...todo.instructions], ...(todo.primarySkill ? { primarySkill: todo.primarySkill } : {}) };
}

export function applyWorkflowAmendment(state: WorkflowState): void {
	const amendment = state.pendingAmendment;
	if (!state.amending || !amendment || amendment.baseRevision !== state.planRevision) throw new Error("No current plan amendment is awaiting acceptance.");
	state.planHistory.push({ revision: state.planRevision, todos: state.todos.map(planTodo), affectedIds: [...amendment.affectedIds] });
	state.planRevision++;
	const existing = new Map(state.todos.map((todo) => [todo.id, todo]));
	state.todos = amendment.todos.map((input, index) => {
		const todo = existing.get(input.id) ?? createWorkflowTodos([input])[0];
		Object.assign(todo, input, { step: index + 1 });
		if (amendment.affectedIds.includes(todo.id)) {
			// Re-review human edits already made under the superseded assignment.
			const design = todo.designs.at(-1);
			if (design && !design.accepted) todo.designs.push({ planRevision: state.planRevision, baselineTree: design.baselineTree, changedFiles: [], reviews: [] });
			todo.primarySkill = input.primarySkill;
			todo.skillSource = input.primarySkill ? "plan" : undefined;
			todo.skillRequest = undefined;
			todo.status = "pending";
			todo.designAccepted = undefined;
			todo.checkpoint = undefined;
			todo.error = undefined;
			todo.automaticReviewCycles = 0;
			todo.feedbackStart = todo.revisions.length;
		}
		return todo;
	});
	state.currentStep = state.todos.find((todo) => !isTodoComplete(todo) && todo.status !== "aborted")?.step;
	state.pendingAmendment = undefined;
	state.amending = false;
	state.executing = false;
	state.paused = false;
}

export function amendmentPlanningInstructions(state: WorkflowState): string {
	return `Amend the accepted plan through this top-level conversation. Preserve repository files and workflow history.
Submit the complete plan with workflow_submit_plan, baseRevision ${state.planRevision}, existing todo IDs and affectedIds containing every changed or otherwise affected unfinished todo. Omit id for new todos; they are affected automatically. Preserve completed todos and add corrective todos for changes to completed work. Human acceptance uses /workflow plan-approve; submitting only stages the proposal.
Current identities and statuses:
${state.todos.map((todo) => `${todo.step}: ${todo.id} (${todo.status})`).join("\n")}
Accepted plan:
${formatWorkflowPlan(state.todos)}
Current findings and handoffs:
${state.todos.map((todo) => `${todo.step}: ${latestTodoFindings(todo)}`).join("\n")}`;
}

function latestTodoFindings(todo: WorkflowTodo): string {
	const result = todo.revisions.at(-1);
	const design = todo.designs.at(-1)?.reviews.at(-1)?.review;
	return [todo.designs.at(-1)?.changedFiles.length ? `Design files: ${todo.designs.at(-1)!.changedFiles.join(", ")}` : undefined, result?.implementation?.summary, result?.implementation?.blocker?.reason, result?.review?.summary, ...(result?.review?.findings ?? []), result?.review?.blocker?.reason, design?.summary, ...(design?.findings ?? [])].filter(Boolean).join("; ") || "No findings.";
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
- Planning uses the top-level conversation. Every todo begins with human-owned design editing and acceptance before isolated implementation and code review.
- Subagents do not inherit the planning conversation. Summarise external requirements in each todo's instructions.
- Use questionnaire for important scope, design, compatibility, risk, language, or testing decisions.
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
