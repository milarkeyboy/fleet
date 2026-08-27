import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentTodo, isWorkflowComplete, type WorkflowState, type WorkflowTodo } from "./state.ts";

const STATUS_KEY = "workflow-status";
const WIDGET_KEY = "workflow-todos";

const ICONS: Record<string, string> = {
	pending: "☐",
	implementing: "⚙",
	reviewing: "◎",
	revising: "↻",
	"awaiting-user": "?",
	approved: "✓",
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
		const done = state.todos.filter((todo) => todo.status === "approved").length;
		const todo = currentTodo(state);
		const label = state.paused ? "paused" : todo?.status ?? "ready";
		const color = label === "failed" ? "error" : label === "awaiting-user" ? "warning" : "accent";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, `Workflow ${done}/${state.todos.length} · ${label}`));
	}

	ctx.ui.setWidget(WIDGET_KEY, state.todos.map((todo) => {
		const icon = ICONS[todo.status] ?? "·";
		const skill = todo.primarySkill ? `[${todo.primarySkill}] ` : "";
		const request = todo.skillRequest ? `[unknown: ${todo.skillRequest}] ` : "";
		if (todo.status === "approved") return ctx.ui.theme.fg("success", `${icon} ${todo.step}. `) + ctx.ui.theme.fg("muted", `${skill}${request}${todo.text}`);
		if (todo.status === "failed") return ctx.ui.theme.fg("error", `${icon} ${todo.step}. ${skill}${request}${todo.text}`);
		if (todo.status === "awaiting-user") return ctx.ui.theme.fg("warning", `${icon} ${todo.step}. ${skill}${request}${todo.text}`);
		return ctx.ui.theme.fg("muted", `${icon} ${todo.step}. `) + `${skill}${request}${todo.text}`;
	}));
}

export function clearWorkflowUi(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}

export function todoSummary(todo: WorkflowTodo): string {
	const skill = todo.primarySkill ? ` [${todo.primarySkill}]` : "";
	const lines = [
		`Todo ${todo.step}${skill}: ${todo.text}`,
		`Status: ${todo.status}`,
		`Attempts: ${todo.attempts}`,
	];
	if (todo.skillRequest) lines.push(`Unknown requested skill: ${todo.skillRequest}`);
	if (todo.implementation) {
		lines.push("", `Implementer${todo.implementation.model ? ` (${todo.implementation.model}${todo.implementation.thinkingLevel ? `, thinking: ${todo.implementation.thinkingLevel}` : ""})` : ""}:`, todo.implementation.summary);
		if (todo.implementation.tests.length) lines.push("", "Validation:", ...todo.implementation.tests.map((test) => `- ${test}`));
	}
	if (todo.review) {
		lines.push("", `Reviewer${todo.review.model ? ` (${todo.review.model}${todo.review.thinkingLevel ? `, thinking: ${todo.review.thinkingLevel}` : ""})` : ""}: ${todo.review.verdict}`, todo.review.summary);
		if (todo.review.findings.length) lines.push(...todo.review.findings.map((finding) => `- ${finding}`));
	}
	if (todo.changedFiles.length) lines.push("", "Files changed:", ...todo.changedFiles.map((file) => `- ${file}`));
	if (todo.error) lines.push("", `Error: ${todo.error}`);
	return lines.join("\n");
}
