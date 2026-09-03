import type { MarkdownContent, WorkflowContent, WorkflowRoleContent } from "./content.ts";
import { extractRelevantFiles } from "./planner.ts";
import { cumulativeRevision, latestRevision, type ImplementationResult, type ReviewResult, type WorkflowState, type WorkflowTodo } from "./state.ts";

function dependencyHandoffs(state: WorkflowState, todo: WorkflowTodo): string {
	const prior = state.todos
		.filter((item) => item.step < todo.step && item.status === "approved" && cumulativeRevision(item)?.implementation)
		.map((item) => {
			const revision = cumulativeRevision(item);
			return `- Todo ${item.step}: ${revision?.implementation?.summary}\n  Files: ${revision?.changedFiles.join(", ") || "none"}`;
		});
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

function workflowPlan(state: WorkflowState, current: WorkflowTodo): string {
	return state.todos.map((todo) => {
		const status = todo.step === current.step
			? "current"
			: todo.status === "approved"
				? "approved"
				: todo.status === "aborted"
					? "aborted"
					: "upcoming";
		return `${todo.step}. [${status}] ${todo.text}`;
	}).join("\n");
}

function latestHumanFeedback(todo: WorkflowTodo): string | undefined {
	return [...todo.revisions].reverse().find((revision) => revision.humanFeedback)?.humanFeedback;
}

function latestReviewerFeedback(todo: WorkflowTodo): string | undefined {
	const review = [...todo.revisions].reverse().find((revision) => revision.review?.findings.length)?.review;
	return review?.findings.join("\n- ");
}

export function implementerInvocation(state: WorkflowState, todo: WorkflowTodo, content: WorkflowContent) {
	if (todo.skillRequest) throw new Error(`Todo ${todo.step} requests unknown Agent Skill "${todo.skillRequest}".`);
	const role = content.roles.implementer;
	const skills = selectedSkills(todo, content);
	const relevant = extractRelevantFiles(todo.text);
	const protocol = `Work only on the assigned todo. You may inspect additional files when necessary, but do not start another todo.
The workflow plan is a scope boundary. Do not implement work assigned to upcoming todos. If the current todo cannot be completed without that work, return blocked instead of absorbing future scope. Explicit human revision requirements override this boundary.
${skillProtocol(skills)}
Validate your work with focused tests or checks. Do not claim a test passed unless you ran it.
End with exactly one machine-readable block:
<workflow-implementation>{"status":"completed|blocked","summary":"...","filesChanged":["..."],"tests":["command: result"],"notes":"optional"}</workflow-implementation>`;
	const humanFeedback = latestHumanFeedback(todo);
	const reviewerFeedback = latestReviewerFeedback(todo);
	const task = `Goal: ${state.goal ?? "Complete the accepted workflow plan"}

Workflow plan:
${workflowPlan(state, todo)}

Current assignment:
${todoHeading(todo)}

Relevant files named by the plan:
${relevant.length ? relevant.map((file) => `- ${file}`).join("\n") : "- Discover the minimum relevant files."}

Approved prerequisite handoffs:
${dependencyHandoffs(state, todo)}
${humanFeedback ? `\nHuman revision requirements (take precedence if prior review findings conflict):\n${humanFeedback}` : ""}
${reviewerFeedback ? `\nLatest reviewer findings:\n- ${reviewerFeedback}` : ""}`;
	return { systemPrompt: rolePrompt(role, protocol), task, skillPaths: skills.map((skill) => skill.filePath) };
}

export function reviewerInvocation(state: WorkflowState, todo: WorkflowTodo, content: WorkflowContent) {
	if (todo.skillRequest) throw new Error(`Todo ${todo.step} requests unknown Agent Skill "${todo.skillRequest}".`);
	const role = content.roles.reviewer;
	const skills = selectedSkills(todo, content);
	const result = latestRevision(todo);
	if (!result?.implementation) throw new Error(`Todo ${todo.step} has no implementation to review.`);
	const implementation = result.implementation;
	const protocol = `You are read-only: do not edit or create files. Review only the assigned todo and supplied todo-specific diff.
The workflow plan is a scope boundary. Flag implementation of upcoming todos as scope leakage, and do not request work assigned to them. If the current todo cannot be completed without upcoming work, escalate instead of expanding its scope.
${skillProtocol(skills)}
Apply the selected skills' review guidance where relevant.
Treat supplied human feedback as revision requirements that override the plan boundary when explicit. Escalate if it conflicts with the original todo or cannot be satisfied safely.
A request_changes verdict must contain concrete, actionable findings. Use escalate for ambiguity requiring a human decision.
End with exactly one machine-readable block:
<workflow-review>{"verdict":"approve|request_changes|escalate","summary":"...","findings":["..."]}</workflow-review>`;
	const task = `Workflow plan:
${workflowPlan(state, todo)}

Current assignment:
${todoHeading(todo)}

Human feedback governing this revision:
${latestHumanFeedback(todo) ?? "(none)"}

Implementer summary:
${implementation.summary}

Reported files (this revision):
${implementation.filesChanged.join("\n") || "(none)"}

Files changed in this revision:
${result.changedFiles.join("\n") || "(none)"}

Validation:
${implementation.tests.join("\n") || "(none reported)"}

Todo-specific diff:
${result.diffPreview ?? "(unavailable)"}`;
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
