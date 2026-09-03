import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { currentTodo, isTodoComplete, isWorkflowComplete, type WorkflowState, type WorkflowTodo } from "./state.ts";

const STATUS_KEY = "workflow-status";
const WIDGET_KEY = "workflow-todos";

const ICONS: Record<string, string> = {
	pending: "☐",
	implementing: "⚙",
	reviewing: "◎",
	revising: "↻",
	"awaiting-user": "?",
	approved: "✓",
	"completed-manually": "✓*",
	failed: "!",
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
		const color = label === "failed" ? "error" : label === "awaiting-user" ? "warning" : "accent";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, `Workflow ${done}/${state.todos.length} · ${label}`));
	}

	ctx.ui.setWidget(WIDGET_KEY, state.todos.map((todo) => {
		const icon = ICONS[todo.status] ?? "·";
		const skill = todo.primarySkill ? `[${todo.primarySkill}] ` : "";
		const request = todo.skillRequest ? `[unknown: ${todo.skillRequest}] ` : "";
		if (isTodoComplete(todo)) return ctx.ui.theme.fg("success", `${icon} ${todo.step}. `) + ctx.ui.theme.fg("muted", `${skill}${request}${todo.text}`);
		if (todo.status === "failed") return ctx.ui.theme.fg("error", `${icon} ${todo.step}. ${skill}${request}${todo.text}`);
		if (todo.status === "awaiting-user") return ctx.ui.theme.fg("warning", `${icon} ${todo.step}. ${skill}${request}${todo.text}`);
		return ctx.ui.theme.fg("muted", `${icon} ${todo.step}. `) + `${skill}${request}${todo.text}`;
	}));
}

export function clearWorkflowUi(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
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
	const skill = todo.primarySkill ? ` [${todo.primarySkill}]` : "";
	const lines = [
		`Todo ${todo.step}${skill}: ${todo.text}`,
		`Status: ${todo.status}`,
		`Attempts: ${todo.attempts}`,
	];
	if (todo.skillRequest) lines.push(`Unknown requested skill: ${todo.skillRequest}`);
	if (todo.revisions.length) lines.push("", "Checkpoint history:");
	for (const [index, revision] of todo.revisions.entries()) {
		lines.push("", `Revision ${index + 1}:`);
		// A revision is one chronological exchange: human feedback, implementation,
		// then review. Keeping these together makes later acceptance checkpoints
		// show the complete back-and-forth instead of only the latest result.
		if (revision.humanFeedback) lines.push("", "Human feedback:", revision.humanFeedback);
		if (revision.implementation) {
			lines.push("", `Implementer${revision.implementation.model ? ` (${revision.implementation.model}${revision.implementation.thinkingLevel ? `, thinking: ${revision.implementation.thinkingLevel}` : ""})` : ""}:`, revision.implementation.summary);
			if (revision.implementation.tests.length) lines.push("", "Validation:", ...revision.implementation.tests.map((test) => `- ${test}`));
		}
		if (revision.review) {
			lines.push("", `Reviewer${revision.review.model ? ` (${revision.review.model}${revision.review.thinkingLevel ? `, thinking: ${revision.review.thinkingLevel}` : ""})` : ""}: ${revision.review.verdict}`, revision.review.summary);
			if (revision.review.findings.length) lines.push(...revision.review.findings.map((finding) => `- ${finding}`));
		}
		if (revision.changedFiles.length) lines.push("", "Files changed:", ...revision.changedFiles.map((file) => `- ${file}`));
	}
	if (todo.error) lines.push("", `Error: ${todo.error}`);
	return lines.join("\n");
}
