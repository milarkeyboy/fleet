import assert from "node:assert/strict";
import test from "node:test";
import { shouldAutomaticallyRevise, WorkflowOrchestrator } from "../orchestrator.ts";
import { createWorkflowState, restoreState, type WorkflowTodo } from "../state.ts";

function todo(cycles: number): WorkflowTodo {
	return { step: 1, text: "Task", primarySkill: "python-development", status: "reviewing", attempts: cycles, automaticReviewCycles: cycles, changedFiles: [], review: { verdict: "request_changes", summary: "fix", findings: ["issue"] } };
}

test("review retries stop after two implement/review cycles", () => {
	assert.equal(shouldAutomaticallyRevise(todo(1)), true);
	assert.equal(shouldAutomaticallyRevise(todo(2)), false);
});

test("restores current workflow state", () => {
	const state = createWorkflowState();
	state.goal = "Goal";
	assert.equal(restoreState(JSON.parse(JSON.stringify(state)))?.goal, "Goal");
	assert.equal(restoreState({ version: 3, todos: [] }), undefined);
});

test("migrates explicit legacy languages and clears inferred assignments", () => {
	const restored = restoreState({
		version: 1,
		planning: false,
		executing: false,
		paused: false,
		createdAt: 1,
		updatedAt: 1,
		todos: [
			{ step: 1, text: "C++", language: "cpp", languageSource: "plan", status: "pending", attempts: 0, automaticReviewCycles: 0, changedFiles: [] },
			{ step: 2, text: "Inferred Python", language: "python", languageSource: "inferred", status: "pending", attempts: 0, automaticReviewCycles: 0, changedFiles: [] },
		],
	});
	assert.equal(restored?.version, 2);
	assert.equal(restored?.todos[0].primarySkill, "cpp-development");
	assert.equal(restored?.todos[0].skillSource, "plan");
	assert.equal(restored?.todos[1].primarySkill, undefined);
	assert.equal("language" in (restored?.todos[0] ?? {}), false);
});

test("model preflight fails before workflow execution changes todo state", async () => {
	const state = createWorkflowState();
	state.todos = [{ step: 1, text: "Task", status: "pending", attempts: 0, automaticReviewCycles: 0, changedFiles: [] }];
	let contentLoaded = false;
	const orchestrator = new WorkflowOrchestrator(state, {
		persist() {},
		updateUi() {},
		content() { contentLoaded = true; throw new Error("content should not load"); },
		async models() { throw new Error("reviewer model is not authenticated"); },
	});

	await assert.rejects(orchestrator.execute({ ui: { notify() {} } } as any), /not authenticated/);
	assert.equal(state.executing, false);
	assert.equal(state.currentStep, undefined);
	assert.equal(state.todos[0].status, "pending");
	assert.equal(state.todos[0].attempts, 0);
	assert.equal(contentLoaded, false);
});
