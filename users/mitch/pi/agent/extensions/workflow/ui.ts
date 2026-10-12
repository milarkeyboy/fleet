import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { formatWorkflowPlan, formatWorkflowTodo } from "./planner.ts";
import { currentTodo, isTodoComplete, isWorkflowComplete, type WorkflowState, type WorkflowTodo } from "./state.ts";

const STATUS_KEY = "workflow-status";
const WIDGET_KEY = "workflow-todos";

const ICONS: Record<string, string> = {
	pending: "☐",
	"design-editing": "✎",
	"design-reviewing": "◎",
	"awaiting-design": "?",
	"awaiting-change": "!",
	implementing: "⚙",
	reviewing: "◎",
	revising: "↻",
	"awaiting-user": "?",
	approved: "✓",
	"completed-manually": "✓*",
	failed: "!",
	interrupted: "Ⅱ",
	aborted: "×",
};

export function updateWorkflowUi(ctx: ExtensionContext, state: WorkflowState): void {
	if (state.todos.length === 0 && !state.planning) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	if (state.planning) {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "Workflow: planning"));
	} else if (isWorkflowComplete(state)) {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("success", `Workflow: ${state.todos.length}/${state.todos.length} ✓`));
	} else {
		const done = state.todos.filter(isTodoComplete).length;
		const todo = currentTodo(state);
		const label = state.paused ? "paused" : todo?.status ?? "ready";
		const color = label === "failed" ? "error" : label.startsWith("awaiting-") ? "warning" : "accent";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, `Workflow ${done}/${state.todos.length} · ${label}`));
	}

	ctx.ui.setWidget(WIDGET_KEY, state.todos.map((todo) => {
		const icon = ICONS[todo.status] ?? "·";
		const skill = todo.primarySkill ? `[${todo.primarySkill}] ` : "";
		const request = todo.skillRequest ? `[unknown: ${todo.skillRequest}] ` : "";
		if (isTodoComplete(todo)) return ctx.ui.theme.fg("success", `${icon} ${todo.step}. `) + ctx.ui.theme.fg("muted", `${skill}${request}${todo.title}`);
		if (todo.status === "failed") return ctx.ui.theme.fg("error", `${icon} ${todo.step}. ${skill}${request}${todo.title}`);
		if (todo.status.startsWith("awaiting-")) return ctx.ui.theme.fg("warning", `${icon} ${todo.step}. ${skill}${request}${todo.title}`);
		return ctx.ui.theme.fg("muted", `${icon} ${todo.step}. `) + `${skill}${request}${todo.title}`;
	}));
}

export function clearWorkflowUi(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}

export function workflowStatusSummary(state: WorkflowState): string {
	const mode = state.planning ? "planning" : state.paused ? "paused" : state.executing ? "executing" : "idle";
	if (!state.todos.length) return `Workflow: ${mode}\nNo todos.`;
	const statuses = state.todos.map((todo) => `- Todo ${todo.step} (${todo.id}): ${todo.status}`).join("\n");
	return `Workflow: ${mode} · plan revision ${state.planRevision}\n\n${formatWorkflowPlan(state.todos)}\n\nTodo status:\n${statuses}${state.pendingAmendment ? `\n\nProposed amendment:\n${formatWorkflowPlan(state.pendingAmendment.todos.map((todo, index) => ({ ...todo, step: index + 1 })))}\nAffected todos: ${state.pendingAmendment.affectedIds.join(", ")}\nUse /workflow plan-approve or plan-reject.` : ""}`;
}

/** Render a raw unified Git diff with Pi's native diff palette. */
export function formatWorkflowDiff(diff: string, theme: Theme): string {
	return diff.split("\n").map((line) => {
		if (!line) return "";
		if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("toolDiffAdded", line);
		if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("toolDiffRemoved", line);
		return theme.fg("toolDiffContext", line);
	}).join("\n");
}

export function todoSummary(todo: WorkflowTodo): string {
	const lines = [
		formatWorkflowTodo(todo),
		`Status: ${todo.status}`,
		`Attempts: ${todo.attempts}`,
	];
	if (todo.skillRequest) lines.push(`Unknown requested skill: ${todo.skillRequest}`);
	for (const [index, design] of todo.designs.entries()) {
		lines.push("", `Design ${index + 1} (plan ${design.planRevision}): ${todo.designAccepted === index ? "accepted" : design.accepted ? "historical acceptance" : "awaiting acceptance"}`);
		if (design.changedFiles.length) lines.push("Human design files:", ...design.changedFiles.map((file) => `- ${file}`));
		else lines.push("No design changes.");
		for (const entry of design.reviews) {
			if (entry.feedback) lines.push("Design feedback:", entry.feedback);
			lines.push(`Design reviewer (${entry.review.model ?? "unknown"}): ${entry.review.verdict}`, entry.review.summary, ...entry.review.findings.map((finding) => `- ${finding}`));
		}
	}
	if (todo.revisions.length) lines.push("", "Checkpoint history:");
	for (const [index, revision] of todo.revisions.entries()) {
		lines.push("", `Revision ${index + 1}${revision.designIndex !== undefined ? ` (design ${revision.designIndex + 1})` : ""}:`);
		// A revision is one chronological exchange: human feedback, implementation,
		// then review. Keeping these together makes later acceptance checkpoints
		// show the complete back-and-forth instead of only the latest result.
		if (revision.humanFeedback) lines.push("", "Human feedback:", revision.humanFeedback);
		if (revision.implementation) {
			lines.push("", `Implementer${revision.implementation.model ? ` (${revision.implementation.model}${revision.implementation.thinkingLevel ? `, thinking: ${revision.implementation.thinkingLevel}` : ""})` : ""}:`, revision.implementation.summary);
			if (revision.implementation.tests.length) lines.push("", "Validation:", ...revision.implementation.tests.map((test) => `- ${test}`));
		}
		if (revision.review) {
			lines.push("", `Code reviewer${revision.review.model ? ` (${revision.review.model}${revision.review.thinkingLevel ? `, thinking: ${revision.review.thinkingLevel}` : ""})` : ""}: ${revision.review.verdict}`, revision.review.summary);
			if (revision.review.findings.length) lines.push(...revision.review.findings.map((finding) => `- ${finding}`));
		}
		if (revision.implementation?.blocker) lines.push(`Blocker (${revision.implementation.blocker.kind}): ${revision.implementation.blocker.reason}`);
		if (revision.review?.blocker) lines.push(`Blocker (${revision.review.blocker.kind}): ${revision.review.blocker.reason}`);
		if (revision.changedFiles.length) lines.push("", "Files changed:", ...revision.changedFiles.map((file) => `- ${file}`));
	}
	if (todo.error) lines.push("", `Error: ${todo.error}`);
	return lines.join("\n");
}
