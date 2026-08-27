import assert from "node:assert/strict";
import test from "node:test";
import { todoSummary } from "../ui.ts";
import type { WorkflowTodo } from "../state.ts";

test("todo summaries show optional skills and actual role models", () => {
	const todo: WorkflowTodo = {
		step: 1,
		text: "Task",
		primarySkill: "rust",
		status: "awaiting-user",
		attempts: 1,
		automaticReviewCycles: 1,
		changedFiles: [],
		implementation: { status: "completed", summary: "done", filesChanged: [], tests: [], model: "openai/coder", thinkingLevel: "medium" },
		review: { verdict: "approve", summary: "ready", findings: [], model: "anthropic/reviewer", thinkingLevel: "high" },
	};
	const summary = todoSummary(todo);
	assert.match(summary, /Todo 1 \[rust\]/);
	assert.match(summary, /Implementer \(openai\/coder, thinking: medium\)/);
	assert.match(summary, /Reviewer \(anthropic\/reviewer, thinking: high\): approve/);
});

test("untagged todo summaries do not imply missing configuration", () => {
	const todo: WorkflowTodo = { step: 1, text: "General task", status: "pending", attempts: 0, automaticReviewCycles: 0, changedFiles: [] };
	assert.equal(todoSummary(todo).split("\n")[0], "Todo 1: General task");
});
