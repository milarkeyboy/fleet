import assert from "node:assert/strict";
import test from "node:test";
import type { MarkdownContent, WorkflowContent } from "../content.ts";
import { implementerInvocation, reviewerInvocation } from "../context.ts";
import { formatWorkflowPlan, formatWorkflowTodo } from "../planner.ts";
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
		skills: { cpp: skill("cpp"), python: skill("python") },
		diagnostics: [],
	};
}

function todo(primarySkill?: string): WorkflowTodo {
	return {
		step: 1,
		title: "Implement task",
		instructions: ["Move `old/task.ts` to `new/task.ts`.", "Preserve existing behavior."],
		...(primarySkill ? { primarySkill } : {}),
		status: "pending",
		attempts: 0,
		automaticReviewCycles: 0,
		revisions: [{ implementation: { status: "completed", summary: "done", filesChanged: [], tests: [] }, changedFiles: [] }],
	};
}

function stateWith(...todos: WorkflowTodo[]) {
	const state = createWorkflowState();
	state.todos = todos;
	return state;
}

test("untagged todos run without an Agent Skill", () => {
	const task = todo();
	const invocation = implementerInvocation(stateWith(task), task, content());
	assert.deepEqual(invocation.skillPaths, []);
	assert.match(invocation.systemPrompt, /^Implementer prompt/);
	assert.doesNotMatch(invocation.task, /\[unassigned\]/);
});

test("the todo primary skill is supplied to implementers and reviewers", () => {
	const implementationTodo = todo("cpp");
	const implementation = implementerInvocation(stateWith(implementationTodo), implementationTodo, content());
	const reviewed = todo("python");
	const review = reviewerInvocation(stateWith(reviewed), reviewed, content());
	assert.deepEqual(implementation.skillPaths, ["/content/cpp/SKILL.md"]);
	assert.deepEqual(review.skillPaths, ["/content/python/SKILL.md"]);
});

test("missing primary skills fail clearly", () => {
	const task = todo("missing");
	assert.throws(() => implementerInvocation(stateWith(task), task, content()), /requires undiscovered Agent Skill "missing"/);
});

test("implementers retain human requirements alongside later reviewer findings", () => {
	const retried = todo();
	retried.revisions = [
		{ humanFeedback: "Keep the compatibility behavior.", changedFiles: [], implementation: { status: "completed", summary: "first", filesChanged: [], tests: [] }, review: { verdict: "request_changes", summary: "needs another fix", findings: ["Use the compatibility adapter."] } },
		{ changedFiles: [] },
	];
	const invocation = implementerInvocation(stateWith(retried), retried, content());
	assert.match(invocation.task, /Keep the compatibility behavior\./);
	assert.match(invocation.task, /Use the compatibility adapter\./);
	assert.match(invocation.task, /Human revision requirements \(take precedence/);
});

test("implementers and reviewers receive the identical complete canonical plan", () => {
	const approved = todo();
	Object.assign(approved, { step: 1, title: "Prepare state", instructions: ["Create `state.ts`.", "Keep the public API."], status: "approved" });
	const current = todo();
	Object.assign(current, { step: 2, title: "Implement current behavior", instructions: ["Move `old.ts` to `exact/new.ts`.", "Run focused tests."], status: "implementing" });
	const upcoming = todo();
	Object.assign(upcoming, { step: 3, title: "Add later UI", instructions: ["Add the widget later."], status: "pending" });
	const aborted = todo();
	Object.assign(aborted, { step: 4, title: "Discarded task", instructions: ["Do not implement this."], status: "aborted" });
	const state = stateWith(approved, current, upcoming, aborted);
	const canonical = formatWorkflowPlan(state.todos);

	const implementation = implementerInvocation(state, current, content());
	const review = reviewerInvocation(state, current, content());
	assert.ok(implementation.task.includes(canonical));
	assert.ok(review.task.includes(canonical));
	assert.ok(implementation.task.includes(formatWorkflowTodo(current)));
	assert.ok(review.task.includes(formatWorkflowTodo(current)));
	assert.match(implementation.task, /Move `old\.ts` to `exact\/new\.ts`\./);
	assert.match(review.task, /Move `old\.ts` to `exact\/new\.ts`\./);
	assert.match(implementation.task, /Todo 1: approved/);
	assert.match(review.task, /Todo 3: upcoming/);
	assert.match(implementation.systemPrompt, /Do not implement work assigned to upcoming todos/);
	assert.match(implementation.systemPrompt, /return blocked instead of absorbing future scope/);
	assert.match(implementation.systemPrompt, /Explicit human revision requirements override this boundary/);
	assert.match(review.systemPrompt, /Flag implementation of upcoming todos as scope leakage/);
	assert.match(review.systemPrompt, /do not request work assigned to them/);
	assert.match(review.systemPrompt, /escalate instead of expanding its scope/);
	assert.match(review.systemPrompt, /override the plan boundary when explicit/);
});

test("later implementers are told when prerequisite todos were completed manually", () => {
	const manual = todo();
	Object.assign(manual, { step: 1, title: "Manual prerequisite", instructions: ["Complete by hand."], status: "completed-manually", revisions: [] });
	const current = todo();
	Object.assign(current, { step: 2, title: "Continue work", instructions: ["Use the prerequisite."], status: "implementing" });
	const invocation = implementerInvocation(stateWith(manual, current), current, content());
	assert.match(invocation.task, /Todo 1: completed-manually/);
	assert.match(invocation.task, /Todo 1: Completed manually; inspect the current worktree/);
});

test("reviewers receive only the current revision files and diff", () => {
	const reviewed = todo();
	reviewed.revisions = [
		{ humanFeedback: "Preserve the public API.", implementation: { status: "completed", summary: "first", filesChanged: ["one.ts"], tests: [] }, changedFiles: ["one.ts"], diffPreview: "diff one" },
		{ implementation: { status: "completed", summary: "second", filesChanged: ["two.ts"], tests: [] }, changedFiles: ["two.ts"], diffPreview: "diff two", cumulativeChangedFiles: ["one.ts", "two.ts"], cumulativeDiffPreview: "diff one\ndiff two", humanCheckpointChangedFiles: ["one.ts", "two.ts"], humanCheckpointDiffPreview: "human checkpoint only" },
	];
	const invocation = reviewerInvocation(stateWith(reviewed), reviewed, content());
	assert.match(invocation.systemPrompt, /Treat supplied human feedback as revision requirements/);
	assert.match(invocation.task, /Preserve the public API\./);
	assert.match(invocation.task, /second/);
	assert.match(invocation.task, /two\.ts/);
	assert.match(invocation.task, /diff two/);
	assert.doesNotMatch(invocation.task, /one\.ts/);
	assert.doesNotMatch(invocation.task, /diff one/);
	assert.doesNotMatch(invocation.task, /human checkpoint only/);
});
