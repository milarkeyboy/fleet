// Persisted design checkpoints and stable per-todo conversation ownership.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkflowTodos } from "../planner.ts";
import { WorkflowSessionStore } from "../sessions.ts";
import { createWorkflowState, markWorkflowInterrupted, restoreState } from "../state.ts";

function state() {
	const value = createWorkflowState();
	value.todos = createWorkflowTodos([{ title: "First", instructions: ["Implement first."] }, { title: "Second", instructions: ["Implement second."] }]);
	return value;
}

test("design acceptance survives a state roundtrip", () => {
	const value = state();
	value.todos[0].designs.push({ planRevision: 1, baselineTree: "before", resultTree: "after", changedFiles: ["api.h"], reviews: [], accepted: true });
	value.todos[0].designAccepted = 0;
	assert.deepEqual(restoreState(value), value);
});

test("an interrupted design review retains its recovery checkpoint", () => {
	const value = state();
	value.todos[0].designs.push({ planRevision: 1, baselineTree: "before", changedFiles: [], reviews: [] });
	value.todos[0].status = "design-reviewing";
	value.todos[0].checkpoint = { role: "design-reviewer", revisionIndex: 0 };
	markWorkflowInterrupted(value);
	assert.equal(value.todos[0].status, "interrupted");
	assert.deepEqual(value.todos[0].checkpoint, { role: "design-reviewer", revisionIndex: 0 });
});

test("reordering a todo preserves its conversation identity", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "workflow-design-state-"));
	try {
		const value = state();
		value.ownerSessionId = "parent";
		const store = new WorkflowSessionStore(root, "parent", root);
		const lease = store.acquire(value);
		try {
			const todo = value.todos[0];
			const original = store.prepare(value, todo, "design-reviewer").session;
			value.todos.reverse();
			value.todos.forEach((item, index) => item.step = index + 1);
			assert.deepEqual(store.prepare(value, todo, "design-reviewer").session, original);
			assert.ok(restoreState(value));
			store.deleteTodo(value, todo);
			assert.equal(todo.sessions, undefined);
		} finally { lease.release(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});
