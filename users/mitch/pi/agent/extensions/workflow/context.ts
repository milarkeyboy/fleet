import type { MarkdownContent, WorkflowContent, WorkflowRoleContent } from "./content.ts";
import { extractRelevantFiles } from "./planner.ts";
import type { ImplementationResult, ReviewResult, WorkflowState, WorkflowTodo } from "./state.ts";

function dependencyHandoffs(state: WorkflowState, todo: WorkflowTodo): string {
	const prior = state.todos
		.filter((item) => item.step < todo.step && item.status === "approved" && item.implementation)
		.map((item) => `- Todo ${item.step}: ${item.implementation?.summary}\n  Files: ${item.changedFiles.join(", ") || "none"}`);
	return prior.length ? prior.join("\n") : "- None";
}

function rolePrompt(role: WorkflowRoleContent, protocol: string): string {
	return `${role.body.trim()}\n\n---\n\n# Workflow Protocol (required)\n\n${protocol}`;
}

function selectedSkills(todo: WorkflowTodo, content: WorkflowContent): MarkdownContent[] {
	if (!todo.primarySkill) return [];
	const skill = Object.hasOwn(content.skills, todo.primarySkill) ? content.skills[todo.primarySkill] : undefined;
	if (!skill) throw new Error(`Workflow requires undiscovered Agent Skill "${todo.primarySkill}".`);
	return [skill];
}

function skillProtocol(skills: MarkdownContent[]): string {
	if (!skills.length) return "No Agent Skills are selected for this task. Work from the role, task, and repository context only.";
	return `Read and follow only these selected Agent Skills:\n${skills.map((skill) => `- ${skill.name}: ${skill.filePath}`).join("\n")}`;
}

function todoHeading(todo: WorkflowTodo): string {
	return `Todo ${todo.step}${todo.primarySkill ? ` [${todo.primarySkill}]` : ""}: ${todo.text}`;
}

export function implementerInvocation(state: WorkflowState, todo: WorkflowTodo, content: WorkflowContent) {
	if (todo.skillRequest) throw new Error(`Todo ${todo.step} requests unknown Agent Skill "${todo.skillRequest}".`);
	const role = content.roles.implementer;
	const skills = selectedSkills(todo, content);
	const relevant = extractRelevantFiles(todo.text);
	const protocol = `Work only on the assigned todo. You may inspect additional files when necessary, but do not start another todo.
${skillProtocol(skills)}
Validate your work with focused tests or checks. Do not claim a test passed unless you ran it.
End with exactly one machine-readable block:
<workflow-implementation>{"status":"completed|blocked","summary":"...","filesChanged":["..."],"tests":["command: result"],"notes":"optional"}</workflow-implementation>`;
	const feedback = todo.humanFeedback || todo.review?.findings?.join("\n- ");
	const task = `Goal: ${state.goal ?? "Complete the accepted workflow plan"}

${todoHeading(todo)}

Relevant files named by the plan:
${relevant.length ? relevant.map((file) => `- ${file}`).join("\n") : "- Discover the minimum relevant files."}

Approved prerequisite handoffs:
${dependencyHandoffs(state, todo)}
${feedback ? `\nRevision feedback:\n${feedback}` : ""}`;
	return { systemPrompt: rolePrompt(role, protocol), task, skillPaths: skills.map((skill) => skill.filePath) };
}

export function reviewerInvocation(todo: WorkflowTodo, content: WorkflowContent) {
	if (todo.skillRequest) throw new Error(`Todo ${todo.step} requests unknown Agent Skill "${todo.skillRequest}".`);
	const role = content.roles.reviewer;
	const skills = selectedSkills(todo, content);
	const implementation = todo.implementation as ImplementationResult;
	const protocol = `You are read-only: do not edit or create files. Review only the assigned todo and supplied todo-specific diff.
${skillProtocol(skills)}
Apply the selected skills' review guidance where relevant.
A request_changes verdict must contain concrete, actionable findings. Use escalate for ambiguity requiring a human decision.
End with exactly one machine-readable block:
<workflow-review>{"verdict":"approve|request_changes|escalate","summary":"...","findings":["..."]}</workflow-review>`;
	const task = `${todoHeading(todo)}

Implementer summary:
${implementation.summary}

Reported files:
${implementation.filesChanged.join("\n") || "(none)"}

Validation:
${implementation.tests.join("\n") || "(none reported)"}

Todo-specific diff:
${todo.diffPreview ?? "(unavailable)"}`;
	return { systemPrompt: rolePrompt(role, protocol), task, skillPaths: skills.map((skill) => skill.filePath) };
}

export function validateImplementation(value: ImplementationResult): ImplementationResult {
	if (!value || !["completed", "blocked"].includes(value.status) || typeof value.summary !== "string") {
		throw new Error("Implementer returned an invalid result schema.");
	}
	return { ...value, filesChanged: Array.isArray(value.filesChanged) ? value.filesChanged : [], tests: Array.isArray(value.tests) ? value.tests : [] };
}

export function validateReview(value: ReviewResult): ReviewResult {
	if (!value || !["approve", "request_changes", "escalate"].includes(value.verdict) || typeof value.summary !== "string") {
		throw new Error("Reviewer returned an invalid result schema.");
	}
	return { ...value, findings: Array.isArray(value.findings) ? value.findings : [] };
}
