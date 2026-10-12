// Workflow's handle adapter delegates storage and ownership to the conversation service.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getConversationService } from "../../subagent/api.ts";
import { WorkflowSessionStore } from "../sessions.ts";
import { createWorkflowState } from "../state.ts";
import { createWorkflowTodos } from "../planner.ts";

function fixture() {
	const root = mkdtempSync(path.join(os.tmpdir(), "workflow-sessions-"));
	const state = createWorkflowState();
	state.ownerSessionId = "parent";
	state.todos = createWorkflowTodos([{ title: "First", instructions: ["Implement first."] }, { title: "Second", instructions: ["Implement second."] }]);
	const store = new WorkflowSessionStore(root, "parent", root);
	const service = getConversationService(root);
	const owner = { parentSessionId: "parent", creator: `workflow:${state.id}`, cwd: root };
	return { root, state, store, service, owner, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("role handles persist and remain isolated between roles and todos", () => {
	const f = fixture();
	try {
		const first = f.store.prepare(f.state, f.state.todos[0], "implementer");
		assert.equal(first.hasHistory, false);
		assert.equal(f.state.todos[0].sessions?.implementer, first.handle);
		assert.deepEqual(f.store.prepare(f.state, f.state.todos[0], "implementer"), first);
		assert.notEqual(f.store.prepare(f.state, f.state.todos[0], "code-reviewer").handle, first.handle);
		assert.notEqual(f.store.prepare(f.state, f.state.todos[1], "implementer").handle, first.handle);
	} finally { f.close(); }
});

test("run forwards assignments through the selected agent and retains history", async () => {
	const f = fixture();
	try {
		const { handle } = f.store.prepare(f.state, f.state.todos[0], "implementer");
		const result = await f.store.run(f.state, handle, { name: "worker", body: "Agent prompt.", model: "test/model", tools: ["read"] } as any,
			{ task: "Implement first.", instructions: "Canonical instructions.", skillPaths: ["/skills/check/SKILL.md"] }, async (options) => {
				assert.equal(options.task, "Implement first.");
				assert.equal(options.roleName, "worker");
				assert.match(options.systemPrompt, /Agent prompt\./);
				assert.match(options.systemPrompt, /Canonical instructions\./);
				assert.deepEqual(options.skillPaths, ["/skills/check/SKILL.md"]);
				appendFileSync(options.sessionFile, '{"type":"message","id":"user0001","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":"Implement first.","timestamp":1}}\n');
				return { exitCode: 0, output: "Done.", stderr: "", messages: [] };
			});
		assert.equal(result.output, "Done.");
		assert.deepEqual(f.store.prepare(f.state, f.state.todos[0], "implementer"), { handle, hasHistory: true });
	} finally { f.close(); }
});

test("foreign parent sessions cannot allocate or delete workflow conversations", () => {
	const f = fixture();
	try {
		const foreign = new WorkflowSessionStore(f.root, "other", f.root);
		assert.throws(() => foreign.prepare(f.state, f.state.todos[0], "implementer"), /ownership changed/);
		assert.throws(() => foreign.deleteWorkflow(f.state), /ownership changed/);
	} finally { f.close(); }
});

test("todo cleanup preserves other todos' handles", () => {
	const f = fixture();
	try {
		f.store.prepare(f.state, f.state.todos[0], "implementer");
		const second = f.store.prepare(f.state, f.state.todos[1], "code-reviewer");
		f.store.deleteTodo(f.state, f.state.todos[0]);
		assert.equal(f.state.todos[0].sessions, undefined);
		assert.equal(f.service.list(f.owner).length, 1);
		assert.equal(f.state.todos[1].sessions?.["code-reviewer"], second.handle);
	} finally { f.close(); }
});

test("full cleanup removes allocations absent from workflow state", () => {
	const f = fixture();
	try {
		f.service.create(f.owner, "Interrupted allocation");
		f.store.deleteWorkflow(f.state);
		assert.deepEqual(f.service.list(f.owner), []);
	} finally { f.close(); }
});
