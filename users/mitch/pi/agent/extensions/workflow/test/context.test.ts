import assert from "node:assert/strict";
import test from "node:test";
import type { MarkdownContent, WorkflowContent } from "../content.ts";
import { implementerInvocation, reviewerInvocation } from "../context.ts";
import { createWorkflowState, type WorkflowTodo } from "../state.ts";

function skill(name: string): MarkdownContent {
	return { name, description: name, body: `${name} body`, filePath: `/content/${name}/SKILL.md`, source: "user" };
}

function content(): WorkflowContent {
	return {
		roles: {
			implementer: { name: "implementer", body: "Implementer prompt", filePath: "/roles/implementer.md", source: "bundled" },
			reviewer: { name: "reviewer", body: "Reviewer prompt", filePath: "/roles/reviewer.md", source: "bundled" },
		},
		skills: {
			cpp: skill("cpp"),
			python: skill("python"),
		},
		diagnostics: [],
	};
}

function todo(primarySkill?: string): WorkflowTodo {
	return {
		step: 1, text: "Implement task", ...(primarySkill ? { primarySkill } : {}), status: "pending", attempts: 0, automaticReviewCycles: 0, changedFiles: [],
		implementation: { status: "completed", summary: "done", filesChanged: [], tests: [] },
	};
}

test("untagged todos run without an Agent Skill", () => {
	const invocation = implementerInvocation(createWorkflowState(), todo(), content());
	assert.deepEqual(invocation.skillPaths, []);
	assert.match(invocation.systemPrompt, /^Implementer prompt/);
	assert.doesNotMatch(invocation.task, /\[unassigned\]/);
});

test("the todo primary skill is supplied to implementers and reviewers", () => {
	const implementation = implementerInvocation(createWorkflowState(), todo("cpp"), content());
	const review = reviewerInvocation(todo("python"), content());
	assert.deepEqual(implementation.skillPaths, ["/content/cpp/SKILL.md"]);
	assert.deepEqual(review.skillPaths, ["/content/python/SKILL.md"]);
});

test("missing primary skills fail clearly", () => {
	assert.throws(() => implementerInvocation(createWorkflowState(), todo("missing"), content()), /requires undiscovered Agent Skill "missing"/);
});
