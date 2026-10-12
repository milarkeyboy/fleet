// Role invocations supply workflow plans, skills, feedback, and revision context.
import assert from "node:assert/strict";
import test from "node:test";
import type { MarkdownContent, WorkflowContent } from "../content.ts";
import { implementerInvocation, codeReviewerInvocation } from "../context.ts";
import { formatWorkflowPlan, formatWorkflowTodo } from "../planner.ts";
import { createWorkflowState, type WorkflowTodo } from "../state.ts";

function skill(name: string): MarkdownContent {
	return { name, description: name, body: `${name} body`, filePath: `/content/${name}/SKILL.md`, source: "user" };
}

function content(): WorkflowContent {
	return {
		planner: "Planner prompt",
		skills: { cpp: skill("cpp"), python: skill("python") },
		diagnostics: [],
	};
}

function todo(primarySkill?: string): WorkflowTodo {
	return {
		id: "00000000-0000-0000-0000-000000000001", designs: [], feedbackStart: 0, step: 1,
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
	assert.match(invocation.systemPrompt, /^# Workflow Protocol/);
	assert.doesNotMatch(invocation.task, /\[unassigned\]/);
});

test("the todo primary skill is supplied to implementers and reviewers", () => {
	const implementationTodo = todo("cpp");
	const implementation = implementerInvocation(stateWith(implementationTodo), implementationTodo, content());
	const reviewed = todo("python");
	const review = codeReviewerInvocation(stateWith(reviewed), reviewed, content());
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
	assert.match(invocation.systemPrompt, /Keep the compatibility behavior\./);
	assert.match(invocation.task, /Use the compatibility adapter\./);
	assert.match(invocation.systemPrompt, /Human revision requirements \(take precedence/);
});

for (const [role, invoke] of [["implementer", implementerInvocation], ["code-reviewer", codeReviewerInvocation]] as const) {
	test(`${role} receives all human feedback chronologically through automatic retries`, () => {
		const task = todo();
		task.revisions = [
			{ humanFeedback: "Remove the fallback.\nKeep errors visible.", changedFiles: [] },
			{ changedFiles: [] },
			{ humanFeedback: "Change the label to Retry.", changedFiles: [] },
			{ implementation: { status: "completed", summary: "updated label", filesChanged: [], tests: [] }, changedFiles: [] },
		];
		const invocation = invoke(stateWith(task), task, content());
		assert.ok(invocation.systemPrompt.includes("Revision 1:\nRemove the fallback.\nKeep errors visible.\n\nRevision 3:\nChange the label to Retry."));
	});

	test(`${role} is instructed to preserve earlier requirements unless explicitly superseded`, () => {
		const task = todo();
		const invocation = invoke(stateWith(task), task, content());
		assert.ok(invocation.systemPrompt.includes("Human feedback is listed in chronological order. Preserve all earlier human requirements unless later human feedback explicitly supersedes them."));
	});

	test(`${role} receives human feedback only for the assigned todo`, () => {
		const prior = todo();
		prior.status = "approved";
		prior.revisions[0].humanFeedback = "Remove the earlier task's fallback.";
		const current = todo();
		current.step = 2;
		current.revisions[0].humanFeedback = "Keep the current task's fallback.";
		const invocation = invoke(stateWith(prior, current), current, content());
		assert.match(invocation.systemPrompt, /Keep the current task's fallback\./);
		assert.doesNotMatch(invocation.systemPrompt, /Remove the earlier task's fallback\./);
	});
}

test("continuations use a short update while requirements stay in the authoritative snapshot", () => {
	const task = todo();
	task.revisions[0].humanFeedback = "Keep errors visible.";
	const invocation = implementerInvocation(stateWith(task), task, content(), { continuing: true });
	assert.match(invocation.task, /^Continue todo 1/);
	assert.doesNotMatch(invocation.task, /Canonical workflow plan|Completed prerequisite handoffs|Keep errors visible/);
	assert.match(invocation.systemPrompt, /Keep errors visible\./);
});

test("interrupted implementers reconcile edits before repeating work", () => {
	const task = todo();
	const invocation = implementerInvocation(stateWith(task), task, content(), { continuing: true, interrupted: true });
	assert.match(invocation.task, /Reconcile the existing edits/);
	assert.match(invocation.task, /do not blindly repeat earlier tool calls/);
});

test("returning reviewers reassess current changes despite earlier verdicts", () => {
	const task = todo();
	const invocation = codeReviewerInvocation(stateWith(task), task, content(), { continuing: true });
	assert.match(invocation.task, /^Review again todo 1/);
	assert.match(invocation.task, /independently of your earlier verdicts/);
	assert.match(invocation.task, /newest supplied diff/);
});

test("implementers and reviewers receive the identical complete canonical plan", () => {
	const approved = todo();
	Object.assign(approved, { id: "00000000-0000-0000-0000-000000000001", designs: [], feedbackStart: 0, step: 1, title: "Prepare state", instructions: ["Create `state.ts`.", "Keep the public API."], status: "approved" });
	const current = todo();
	Object.assign(current, { id: "00000000-0000-0000-0000-000000000002", designs: [], feedbackStart: 0, step: 2, title: "Implement current behavior", instructions: ["Move `old.ts` to `exact/new.ts`.", "Run focused tests."], status: "implementing" });
	const upcoming = todo();
	Object.assign(upcoming, { id: "00000000-0000-0000-0000-000000000003", designs: [], feedbackStart: 0, step: 3, title: "Add later UI", instructions: ["Add the widget later."], status: "pending" });
	const aborted = todo();
	Object.assign(aborted, { id: "00000000-0000-0000-0000-000000000004", designs: [], feedbackStart: 0, step: 4, title: "Discarded task", instructions: ["Do not implement this."], status: "aborted" });
	const state = stateWith(approved, current, upcoming, aborted);
	const canonical = formatWorkflowPlan(state.todos);

	const implementation = implementerInvocation(state, current, content());
	const review = codeReviewerInvocation(state, current, content());
	assert.ok(implementation.systemPrompt.includes(canonical));
	assert.ok(review.systemPrompt.includes(canonical));
	assert.ok(implementation.systemPrompt.includes(formatWorkflowTodo(current)));
	assert.ok(review.systemPrompt.includes(formatWorkflowTodo(current)));
	assert.match(implementation.systemPrompt, /Move `old\.ts` to `exact\/new\.ts`\./);
	assert.match(review.systemPrompt, /Move `old\.ts` to `exact\/new\.ts`\./);
	assert.match(implementation.systemPrompt, /Todo 1: approved/);
	assert.match(review.systemPrompt, /Todo 3: upcoming/);
	assert.match(implementation.systemPrompt, /Do not implement work assigned to upcoming todos/);
	assert.match(implementation.systemPrompt, /return blocked instead of absorbing future scope/);
	assert.match(implementation.systemPrompt, /Human code feedback must remain within this boundary and the accepted design/);
	assert.match(review.systemPrompt, /Flag implementation of upcoming todos as scope leakage/);
	assert.match(review.systemPrompt, /do not request work assigned to them/);
	assert.match(review.systemPrompt, /escalate instead of expanding its scope/);
	assert.match(review.systemPrompt, /within the accepted design and plan/);
});

test("later implementers are told when prerequisite todos were completed manually", () => {
	const manual = todo();
	Object.assign(manual, { id: "00000000-0000-0000-0000-000000000001", designs: [], feedbackStart: 0, step: 1, title: "Manual prerequisite", instructions: ["Complete by hand."], status: "completed-manually", revisions: [] });
	const current = todo();
	Object.assign(current, { id: "00000000-0000-0000-0000-000000000002", designs: [], feedbackStart: 0, step: 2, title: "Continue work", instructions: ["Use the prerequisite."], status: "implementing" });
	const invocation = implementerInvocation(stateWith(manual, current), current, content());
	assert.match(invocation.systemPrompt, /Todo 1: completed-manually/);
	assert.match(invocation.task, /Todo 1: Completed manually; inspect the current worktree/);
});

test("code reviewers receive the current diff and retained implementation history", () => {
	const reviewed = todo();
	reviewed.revisions = [
		{ humanFeedback: "Preserve the public API.", implementation: { status: "completed", summary: "first", filesChanged: ["one.ts"], tests: [] }, changedFiles: ["one.ts"], diffPreview: "diff one" },
		{ implementation: { status: "completed", summary: "second", filesChanged: ["two.ts"], tests: [] }, changedFiles: ["two.ts"], diffPreview: "diff two", cumulativeChangedFiles: ["one.ts", "two.ts"], cumulativeDiffPreview: "diff one\ndiff two", humanCheckpointChangedFiles: ["one.ts", "two.ts"], humanCheckpointDiffPreview: "human checkpoint only" },
	];
	const invocation = codeReviewerInvocation(stateWith(reviewed), reviewed, content());
	assert.match(invocation.systemPrompt, /Treat supplied human feedback as code revision requirements/);
	assert.match(invocation.systemPrompt, /Preserve the public API\./);
	assert.match(invocation.task, /second/);
	assert.match(invocation.task, /two\.ts/);
	assert.match(invocation.task, /diff two/);
	assert.match(invocation.task, /one\.ts/);
	assert.match(invocation.task, /diff one/);
	assert.doesNotMatch(invocation.task, /human checkpoint only/);
});
