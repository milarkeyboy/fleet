import assert from "node:assert/strict";
import test from "node:test";
import { formatWorkflowDiff, todoSummary } from "../ui.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { WorkflowTodo } from "../state.ts";

test("todo summaries show optional skills and actual role models", () => {
	const todo: WorkflowTodo = {
		step: 1,
		text: "Task",
		primarySkill: "rust",
		status: "awaiting-user",
		attempts: 1,
		automaticReviewCycles: 1,
		revisions: [{
			changedFiles: [],
			implementation: { status: "completed", summary: "done", filesChanged: [], tests: [], model: "openai/coder", thinkingLevel: "medium" },
			review: { verdict: "approve", summary: "ready", findings: [], model: "anthropic/reviewer", thinkingLevel: "high" },
		}],
	};
	const summary = todoSummary(todo);
	assert.match(summary, /Todo 1 \[rust\]/);
	assert.match(summary, /Implementer \(openai\/coder, thinking: medium\)/);
	assert.match(summary, /Reviewer \(anthropic\/reviewer, thinking: high\): approve/);
});

test("todo summaries preserve implementer and reviewer responses for each round", () => {
	const todo: WorkflowTodo = {
		step: 1,
		text: "Task",
		status: "awaiting-user",
		attempts: 2,
		automaticReviewCycles: 0,
		revisions: [
			{ changedFiles: ["first.ts"], implementation: { status: "completed", summary: "first implementation", filesChanged: ["first.ts"], tests: [] }, review: { verdict: "request_changes", summary: "first review", findings: ["first finding"] } },
			{ humanFeedback: "Please address the finding.", changedFiles: ["second.ts"], implementation: { status: "completed", summary: "second implementation", filesChanged: ["second.ts"], tests: [] }, review: { verdict: "approve", summary: "second review", findings: [] } },
		],
	};
	const summary = todoSummary(todo);
	assert.match(summary, /first implementation/);
	assert.match(summary, /first review/);
	assert.match(summary, /first finding/);
	assert.match(summary, /Please address the finding\./);
	assert.match(summary, /second implementation/);
	assert.match(summary, /second review/);
	assert.ok(summary.indexOf("first implementation") < summary.indexOf("first review"));
	assert.ok(summary.indexOf("first review") < summary.indexOf("Please address the finding."));
	assert.ok(summary.indexOf("Please address the finding.") < summary.indexOf("second implementation"));
	assert.ok(summary.indexOf("second implementation") < summary.indexOf("second review"));
});

test("workflow diffs use native diff colors without styling file headers as changes", () => {
	const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` } as Theme;
	const rendered = formatWorkflowDiff("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n-old\n+new\n unchanged", theme);
	assert.equal(rendered, [
		"<toolDiffContext>diff --git a/a.ts b/a.ts</toolDiffContext>",
		"<toolDiffContext>--- a/a.ts</toolDiffContext>",
		"<toolDiffContext>+++ b/a.ts</toolDiffContext>",
		"<toolDiffRemoved>-old</toolDiffRemoved>",
		"<toolDiffAdded>+new</toolDiffAdded>",
		"<toolDiffContext> unchanged</toolDiffContext>",
	].join("\n"));
});

test("untagged todo summaries do not imply missing configuration", () => {
	const todo: WorkflowTodo = { step: 1, text: "General task", status: "pending", attempts: 0, automaticReviewCycles: 0, revisions: [] };
	assert.equal(todoSummary(todo).split("\n")[0], "Todo 1: General task");
});
