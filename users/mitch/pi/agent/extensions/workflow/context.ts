import type { MarkdownContent, WorkflowContent } from "./content.ts";
import { extractRelevantFiles, formatWorkflowPlan, formatWorkflowTodo } from "./planner.ts";
import { cumulativeRevision, isTodoComplete, latestRevision, type ImplementationResult, type ReviewResult, type WorkflowState, type WorkflowTodo } from "./state.ts";

function dependencyHandoffs(state: WorkflowState, todo: WorkflowTodo): string {
	const prior = state.todos
		.filter((item) => item.step < todo.step && isTodoComplete(item))
		.map((item) => {
			const revision = cumulativeRevision(item);
			if (item.status === "completed-manually") return `- Todo ${item.step}: Completed manually; inspect the current worktree for its changes.`;
			return `- Todo ${item.step} (${item.title}): ${revision?.implementation?.summary ?? "Approved without a recorded implementation summary."}\n  Files: ${revision?.changedFiles.join(", ") || "none"}`;
		});
	return prior.length ? prior.join("\n") : "- None";
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

function workflowStatuses(state: WorkflowState, current: WorkflowTodo): string {
	return state.todos.map((todo) => {
		const status = todo.step === current.step
			? "current"
			: todo.status === "approved"
				? "approved"
				: todo.status === "completed-manually"
					? "completed-manually"
					: todo.status === "aborted"
						? "aborted"
						: "upcoming";
		return `- Todo ${todo.step}: ${status}`;
	}).join("\n");
}

const HUMAN_FEEDBACK_PROTOCOL = "Human feedback is listed in chronological order. Preserve all earlier human requirements unless later human feedback explicitly supersedes them.";

function humanFeedbackHistory(todo: WorkflowTodo): string | undefined {
	// The authoritative system snapshot preserves exact requirements across compaction.
	const feedback = todo.revisions.slice(todo.feedbackStart).flatMap((revision, index) =>
		revision.humanFeedback ? [`Revision ${index + todo.feedbackStart + 1}:\n${revision.humanFeedback}`] : [],
	);
	return feedback.length ? feedback.join("\n\n") : undefined;
}

function latestReviewerFeedback(todo: WorkflowTodo): string | undefined {
	const review = [...todo.revisions].reverse().find((revision) => revision.designIndex === todo.designAccepted && revision.review?.findings.length)?.review;
	return review?.findings.join("\n- ");
}

interface InvocationOptions {
	continuing?: boolean;
	interrupted?: boolean;
}

/** Pi checkpoints system prompts during compaction; historical exchanges can be summarised separately. */
function authoritativePrompt(state: WorkflowState, todo: WorkflowTodo, protocol: string): string {
	return `# Workflow Protocol (required)\n\nAgent Markdown customises personality and review preferences. Follow the workflow protocol and authoritative assignment when custom guidance conflicts.\n\n${protocol}

# Authoritative workflow assignment
Use this current snapshot when older conversation messages describe different requirements.
Goal: ${state.goal ?? "Complete the accepted workflow plan"}
Plan revision: ${state.planRevision}
Earlier assignments and findings are historical where superseded by this snapshot.
Human code feedback stays within the accepted design and plan scope. Request design editing or plan amendment for contract or scope changes.

Canonical workflow plan (the exact plan presented for human review):
${formatWorkflowPlan(state.todos)}

Workflow orchestration status (not part of the canonical plan):
${workflowStatuses(state, todo)}

Current assignment (rendered from the same todo data as the canonical plan):
${formatWorkflowTodo(todo)}

Human revision requirements (take precedence if prior review findings conflict):
${humanFeedbackHistory(todo) ?? "(none)"}

Current design review requests (chronological):
${[...(todo.designs.at(-1)?.reviews.map((entry) => entry.feedback) ?? []), todo.designs.at(-1)?.pendingFeedback].filter(Boolean).join("\n") || "(none)"}

Human-owned design changes (chronological; later accepted changes supersede earlier contracts):
${todo.designs.filter((design, index) => design.accepted && index <= (todo.designAccepted ?? -1)).map((design, index) => `Design ${index + 1}, plan revision ${design.planRevision}:\nFiles: ${design.changedFiles.join(", ") || "none"}\n${design.diffPreview ?? "No changes."}`).join("\n\n") || "(none accepted)"}
Preserve human-authored design, including documentation, Doxygen, signatures and types. Propose required changes to the human rather than editing the design. Inspect current files and reconcile retained implementation work against the accepted design.`;
}

export function implementerInvocation(state: WorkflowState, todo: WorkflowTodo, content: WorkflowContent, options: InvocationOptions = {}) {
	if (todo.skillRequest) throw new Error(`Todo ${todo.step} requests unknown Agent Skill "${todo.skillRequest}".`);
	const skills = selectedSkills(todo, content);
	const relevant = extractRelevantFiles(todo);
	const protocol = `Work only on the assigned todo. You may inspect additional files when necessary, but do not start another todo.
The workflow plan is a scope boundary. Do not implement work assigned to upcoming todos. If the current todo cannot be completed without that work, return blocked instead of absorbing future scope. Human code feedback must remain within this boundary and the accepted design. Return blocked with a design or plan blocker when either contract needs changing; preserve partial work and explain the decision needed.
${HUMAN_FEEDBACK_PROTOCOL}
${skillProtocol(skills)}
Validate your work with focused tests or checks. Do not claim a test passed unless you ran it.
End with exactly one machine-readable block:
<workflow-implementation>{"status":"completed|blocked","summary":"...","filesChanged":["..."],"tests":["command: result"],"notes":"optional","blocker":{"kind":"design|plan","reason":"human decision needed; omit when unblocked"}}</workflow-implementation>`;
	const reviewerFeedback = latestReviewerFeedback(todo);
	const task = `${options.continuing ? "Continue" : "Implement"} todo ${todo.step}, revision ${todo.revisions.length}, using the authoritative workflow assignment and human requirements in the system prompt.
Inspect the current worktree before editing; earlier file reads may be stale.
${options.interrupted ? "The previous invocation was interrupted. Reconcile the existing edits before continuing; do not blindly repeat earlier tool calls. Return a complete implementation result for this revision." : ""}
${!options.continuing ? `
Relevant files named by the plan:
${relevant.length ? relevant.map((file) => `- ${file}`).join("\n") : "- Discover the minimum relevant files."}

Completed prerequisite handoffs:
${dependencyHandoffs(state, todo)}` : ""}
${reviewerFeedback ? `\nLatest reviewer findings:\n- ${reviewerFeedback}` : ""}`;
	return { systemPrompt: authoritativePrompt(state, todo, protocol), task, skillPaths: skills.map((skill) => skill.filePath) };
}

export function codeReviewerInvocation(state: WorkflowState, todo: WorkflowTodo, content: WorkflowContent, options: InvocationOptions = {}) {
	if (todo.skillRequest) throw new Error(`Todo ${todo.step} requests unknown Agent Skill "${todo.skillRequest}".`);
	const skills = selectedSkills(todo, content);
	const result = latestRevision(todo);
	if (!result?.implementation) throw new Error(`Todo ${todo.step} has no implementation to review.`);
	const implementation = result.implementation;
	const protocol = `You are read-only: do not edit or create files. Review only the assigned todo and supplied todo-specific diff.
The workflow plan is a scope boundary. Flag implementation of upcoming todos as scope leakage, and do not request work assigned to them. If the current todo cannot be completed without upcoming work, escalate instead of expanding its scope.
${skillProtocol(skills)}
Apply the selected skills' review guidance where relevant.
Treat supplied human feedback as code revision requirements within the accepted design and plan. Escalate if it requires changing that contract or scope.
${HUMAN_FEEDBACK_PROTOCOL}
A request_changes verdict must contain concrete, actionable code findings within the accepted design. Use escalate with a design or plan blocker when human-owned design or scope needs changing; propose changes for the human to make.
End with exactly one machine-readable block:
<workflow-review>{"verdict":"approve|request_changes|escalate","summary":"...","findings":["..."],"blocker":{"kind":"design|plan","reason":"human decision needed; omit when unblocked"}}</workflow-review>`;
	const task = `${options.continuing ? "Review again" : "Review"} todo ${todo.step}, revision ${todo.revisions.length}, against the authoritative workflow assignment and all human requirements in the system prompt.
Reassess the current changes independently of your earlier verdicts. Use the newest supplied diff and inspect current files; earlier diffs and file reads are historical context.
${options.interrupted ? "The previous invocation was interrupted. Recheck the current worktree and produce a new complete review result." : ""}

Implementer summary:
${implementation.summary}

Reported files (this revision):
${implementation.filesChanged.join("\n") || "(none)"}

Files changed in this revision:
${result.changedFiles.join("\n") || "(none)"}

Validation:
${implementation.tests.join("\n") || "(none reported)"}

Todo-specific diff:
${result.diffPreview ?? "(unavailable)"}

Retained implementation files requiring reassessment:
${[...new Set(todo.revisions.slice(0, -1).flatMap((revision) => revision.changedFiles))].join("\n") || "(none)"}

Retained implementation history (human design edits are supplied separately):
${todo.revisions.slice(0, -1).filter((revision) => revision.diffPreview).map((revision, index) => `Implementation ${index + 1}:\n${revision.diffPreview}`).join("\n\n") || "(none)"}
Review all retained implementation work against the current accepted design; historical diffs identify work to inspect, while current files determine correctness.`;
	return { systemPrompt: authoritativePrompt(state, todo, protocol), task, skillPaths: skills.map((skill) => skill.filePath) };
}

export function designReviewerInvocation(state: WorkflowState, todo: WorkflowTodo, content: WorkflowContent, feedback?: string) {
	const skills = selectedSkills(todo, content);
	const design = todo.designs.at(-1);
	if (!design?.resultTree) throw new Error("No design snapshot is available for review.");
	const protocol = `You are read-only: propose design changes for the human to make. Review the human edits and relevant repository context for consistency, feasibility, missing decisions and testability.
Human changes may include Markdown, Doxygen, signatures and types, and may temporarily break compilation. Respect the current todo boundary; identify required scope changes for conversational replanning.
Findings and verdicts are advisory; explicit human acceptance authorises implementation. Preserve all repository files and propose required design edits for the human to make.
${skillProtocol(skills)}
End with exactly one machine-readable block:
<workflow-review>{"verdict":"approve|request_changes|escalate","summary":"...","findings":["..."]}</workflow-review>`;
	const task = `Review todo ${todo.step}'s current design changes. Reassess independently of earlier verdicts and inspect current files.
Human design files:
${design.changedFiles.join("\n")}
Design diff since entering this phase:
${design.diffPreview}
Human request:
${feedback ?? "(none)"}
Earlier design review findings:
${design.reviews.map((entry) => entry.review.findings.join("\n")).join("\n") || "(none)"}`;
	return { systemPrompt: authoritativePrompt(state, todo, protocol), task, skillPaths: skills.map((skill) => skill.filePath) };
}

export function extractProtocolJson<T>(output: string, tag: string): T {
	const match = output.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i"));
	if (!match) throw new Error(`Agent output did not contain <${tag}> structured result.`);
	try { return JSON.parse(match[1]) as T; }
	catch (error) { throw new Error(`Invalid ${tag} JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function validateBlocker(value: ImplementationResult | ReviewResult): void {
	if (value.blocker && (!["design", "plan"].includes(value.blocker.kind) || typeof value.blocker.reason !== "string" || !value.blocker.reason.trim())) throw new Error("Invalid workflow blocker.");
	if (value.blocker && ("status" in value ? value.status !== "blocked" : value.verdict !== "escalate")) throw new Error("A workflow blocker requires blocked implementation or escalated review.");
}

export function validateImplementation(value: ImplementationResult): ImplementationResult {
	if (!value || !["completed", "blocked"].includes(value.status) || typeof value.summary !== "string") {
		throw new Error("Implementer returned an invalid result schema.");
	}
	validateBlocker(value);
	return { ...value, filesChanged: Array.isArray(value.filesChanged) ? value.filesChanged : [], tests: Array.isArray(value.tests) ? value.tests : [] };
}

export function validateReview(value: ReviewResult): ReviewResult {
	if (!value || !["approve", "request_changes", "escalate"].includes(value.verdict) || typeof value.summary !== "string") {
		throw new Error("Reviewer returned an invalid result schema.");
	}
	validateBlocker(value);
	return { ...value, findings: Array.isArray(value.findings) ? value.findings : [] };
}
