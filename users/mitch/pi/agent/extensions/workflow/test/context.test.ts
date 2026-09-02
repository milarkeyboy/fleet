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
		planner: "Planner prompt",
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
		step: 1, text: "Implement task", ...(primarySkill ? { primarySkill } : {}), status: "pending", attempts: 0, automaticReviewCycles: 0,
		revisions: [{ implementation: { status: "completed", summary: "done", filesChanged: [], tests: [] }, changedFiles: [] }],
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

test("implementers retain the latest feedback when a retry starts a new revision", () => {
	const retried = todo();
	retried.revisions = [
		{ humanFeedback: "Keep the compatibility behavior.", implementation: { status: "completed", summary: "first", filesChanged: [], tests: [] }, changedFiles: [] },
		{ changedFiles: [] },
	];
	const invocation = implementerInvocation(createWorkflowState(), retried, content());
	assert.match(invocation.task, /Keep the compatibility behavior\./);
});

test("implementers retain human requirements alongside later reviewer findings", () => {
	const retried = todo();
	retried.revisions = [
		{ humanFeedback: "Keep the compatibility behavior.", changedFiles: [], implementation: { status: "completed", summary: "first", filesChanged: [], tests: [] }, review: { verdict: "request_changes", summary: "needs another fix", findings: ["Use the compatibility adapter."] } },
		{ changedFiles: [] },
	];
	const invocation = implementerInvocation(createWorkflowState(), retried, content());
	assert.match(invocation.task, /Keep the compatibility behavior\./);
	assert.match(invocation.task, /Use the compatibility adapter\./);
	assert.match(invocation.task, /Human revision requirements \(take precedence/);
});

test("reviewers receive only the current revision files and diff", () => {
	const reviewed = todo();
	reviewed.revisions = [
		{ humanFeedback: "Preserve the public API.", implementation: { status: "completed", summary: "first", filesChanged: ["one.ts"], tests: [] }, changedFiles: ["one.ts"], diffPreview: "diff one" },
		{ implementation: { status: "completed", summary: "second", filesChanged: ["two.ts"], tests: [] }, changedFiles: ["two.ts"], diffPreview: "diff two", cumulativeChangedFiles: ["one.ts", "two.ts"], cumulativeDiffPreview: "diff one\ndiff two" },
	];
	const invocation = reviewerInvocation(reviewed, content());
	assert.match(invocation.systemPrompt, /Treat supplied human feedback as revision requirements/);
	assert.match(invocation.task, /Preserve the public API\./);
	assert.match(invocation.task, /second/);
	assert.match(invocation.task, /two\.ts/);
	assert.match(invocation.task, /diff two/);
	assert.doesNotMatch(invocation.task, /one\.ts/);
	assert.doesNotMatch(invocation.task, /diff one/);
});
