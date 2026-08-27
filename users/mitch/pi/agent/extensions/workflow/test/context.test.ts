import assert from "node:assert/strict";
import test from "node:test";
import type { MarkdownContent, WorkflowContent } from "../content.ts";
import { implementerInvocation, reviewerInvocation } from "../context.ts";
import { createWorkflowState, type WorkflowTodo } from "../state.ts";

function markdown(name: string, skills: string[] = []): MarkdownContent {
	return { name, description: name, body: `${name} body`, filePath: `/content/${name}/SKILL.md`, source: "bundled", skills };
}

function content(implementerSkills: string[] = [], reviewerSkills: string[] = []): WorkflowContent {
	return {
		roles: {
			implementer: { ...markdown("workflow-implementer", implementerSkills), filePath: "/roles/implementer.md" },
			reviewer: { ...markdown("workflow-reviewer", reviewerSkills), filePath: "/roles/reviewer.md" },
		},
		skills: {
			rust: markdown("rust"),
			testing: markdown("testing"),
			"security-review": markdown("security-review"),
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

test("untagged todos load role supplemental skills without a primary skill", () => {
	const invocation = implementerInvocation(createWorkflowState(), todo(), content(["testing"]));
	assert.deepEqual(invocation.skillPaths, ["/content/testing/SKILL.md"]);
	assert.doesNotMatch(invocation.task, /\[unassigned\]/);
});

test("primary and supplemental skills are ordered and deduplicated", () => {
	const invocation = implementerInvocation(createWorkflowState(), todo("rust"), content(["rust", "testing"]));
	assert.deepEqual(invocation.skillPaths, ["/content/rust/SKILL.md", "/content/testing/SKILL.md"]);
	assert.match(invocation.systemPrompt, /rust.*testing/s);
});

test("reviewers use their own supplemental skills", () => {
	const invocation = reviewerInvocation(todo("rust"), content([], ["security-review"]));
	assert.deepEqual(invocation.skillPaths, ["/content/rust/SKILL.md", "/content/security-review/SKILL.md"]);
});

test("missing role skills fail clearly", () => {
	assert.throws(() => implementerInvocation(createWorkflowState(), todo(), content(["missing"])), /requires undiscovered Agent Skill "missing"/);
});
