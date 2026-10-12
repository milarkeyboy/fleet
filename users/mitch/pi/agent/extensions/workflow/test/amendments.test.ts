// Plan amendment validation, stable identities and selective approval invalidation.
import assert from "node:assert/strict";
import test from "node:test";
import { applyWorkflowAmendment, createWorkflowTodos, planTodo, stageWorkflowAmendment } from "../planner.ts";
import { createWorkflowState, restoreState } from "../state.ts";

function fixture() {
	const state = createWorkflowState();
	state.todos = createWorkflowTodos([{ title: "First", instructions: ["First requirement."] }, { title: "Second", instructions: ["Second requirement."] }]);
	state.amending = true;
	return state;
}

test("submitting an amendment leaves the accepted plan unchanged", () => {
	const state = fixture();
	const first = state.todos[0];
	stageWorkflowAmendment(state, [{ ...planTodo(first), instructions: ["New requirement."] }, planTodo(state.todos[1])], 1, [first.id]);
	assert.deepEqual(first.instructions, ["First requirement."]);
	assert.equal(state.planRevision, 1);
	assert.ok(restoreState(state));
});

test("accepting an amendment preserves history and invalidates only affected work", () => {
	const state = fixture();
	for (const todo of state.todos) {
		todo.designs.push({ planRevision: 1, baselineTree: "before", reviews: [], changedFiles: [], accepted: true });
		todo.designAccepted = 0;
		todo.status = "awaiting-user";
	}
	const second = state.todos[1];
	stageWorkflowAmendment(state, [planTodo(state.todos[0]), { ...planTodo(second), instructions: ["Changed requirement."] }], 1, [second.id]);
	applyWorkflowAmendment(state);
	assert.equal(state.todos[0].designAccepted, 0);
	assert.equal(state.todos[0].status, "awaiting-user");
	assert.equal(second.designAccepted, undefined);
	assert.equal(second.status, "pending");
	assert.deepEqual(state.planHistory[0].todos[1].instructions, ["Second requirement."]);
	assert.equal(state.planRevision, 2);
});

test("reordering retains todo identities and completed work", () => {
	const state = fixture();
	const first = state.todos[0];
	const second = state.todos[1];
	stageWorkflowAmendment(state, [planTodo(second), planTodo(first)], 1, []);
	applyWorkflowAmendment(state);
	assert.equal(state.todos[0].id, second.id);
	assert.equal(state.todos[1].id, first.id);
	assert.equal(first.step, 2);
	assert.ok(restoreState(state));
});

test("splitting work creates a new affected todo", () => {
	const state = fixture();
	stageWorkflowAmendment(state, [planTodo(state.todos[0]), { title: "Split", instructions: ["Split requirement."] }, planTodo(state.todos[1])], 1, []);
	applyWorkflowAmendment(state);
	assert.equal(state.todos[1].title, "Split");
	assert.equal(state.todos[1].status, "pending");
	assert.equal(state.planHistory[0].affectedIds.length, 1);
});

test("changed assignments require explicit affected-todo confirmation", () => {
	const state = fixture();
	assert.throws(() => stageWorkflowAmendment(state, [{ ...planTodo(state.todos[0]), instructions: ["Changed."] }, planTodo(state.todos[1])], 1, []), /Confirm changed todo/);
});

test("stale amendments cannot replace the current plan", () => {
	const state = fixture();
	assert.throws(() => stageWorkflowAmendment(state, state.todos.map(planTodo), 2, []), /stale/);
});

test("completed work requires corrective todos", () => {
	const state = fixture();
	state.todos[0].status = "approved";
	assert.throws(() => stageWorkflowAmendment(state, [{ ...planTodo(state.todos[0]), instructions: ["Changed."] }, planTodo(state.todos[1])], 1, []), /Completed todos are immutable/);
});

test("affected design edits retain their original phase baseline", () => {
	const state = fixture();
	state.todos[0].designs.push({ planRevision: 1, baselineTree: "original", resultTree: "reviewed", changedFiles: ["api.h"], reviews: [] });
	stageWorkflowAmendment(state, state.todos.map(planTodo), 1, [state.todos[0].id]);
	applyWorkflowAmendment(state);
	assert.deepEqual(state.todos[0].designs[1], { planRevision: 2, baselineTree: "original", changedFiles: [], reviews: [] });
});
