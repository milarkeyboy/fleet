// Design checkpoint recovery and validation of the current working tree.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { implementerInvocation } from "../context.ts";
import { markWorkflowInterrupted } from "../state.ts";
import { fixture } from "./design-fixture.ts";

test("failed design review retries preserve feedback and conversation identity", async () => {
	const f = fixture();
	try {
		await f.orchestrator().execute(f.ctx);
		writeFileSync(path.join(f.cwd, "design.md"), "Contract\n");
		f.controls.beforeRun = async () => { throw new Error("Disconnected"); };
		await f.orchestrator().reviewDesign(f.ctx, "Consider error handling.");
		assert.equal(f.state.todos[0].status, "failed");
		const restored = f.restored();
		f.controls.beforeRun = async () => {};
		await f.orchestrator(restored).execute(f.ctx);
		assert.equal(restored.todos[0].status, "awaiting-design");
		assert.equal(f.calls[0].sessionFile, f.calls[1].sessionFile);
		assert.match(f.calls[1].task, /Consider error handling/);
	} finally { f.close(); }
});

test("restored in-flight design review remains idle until explicitly resumed", async () => {
	const f = fixture();
	try {
		await f.orchestrator().execute(f.ctx);
		f.state.todos[0].status = "design-reviewing";
		f.state.todos[0].checkpoint = { role: "design-reviewer", revisionIndex: 0 };
		const restored = f.restored();
		markWorkflowInterrupted(restored);
		assert.equal(restored.todos[0].status, "interrupted");
		assert.deepEqual(f.calls, []);
		await f.orchestrator(restored).execute(f.ctx);
		assert.equal(restored.todos[0].status, "awaiting-design");
	} finally { f.close(); }
});

test("edits during design review require another review before acceptance", async () => {
	const f = fixture();
	try {
		await f.orchestrator().execute(f.ctx);
		writeFileSync(path.join(f.cwd, "design.md"), "First contract\n");
		f.controls.beforeRun = async () => { writeFileSync(path.join(f.cwd, "design.md"), "Second contract\n"); };
		await f.orchestrator().reviewDesign(f.ctx);
		assert.equal(f.state.todos[0].status, "design-editing");
		await assert.rejects(f.orchestrator().approveDesign(f.ctx), /No design is awaiting/);
	} finally { f.close(); }
});

test("returning to editing after review retains all human changes", async () => {
	const f = fixture();
	try {
		const run = f.orchestrator();
		await run.execute(f.ctx);
		writeFileSync(path.join(f.cwd, "first.md"), "First contract\n");
		await run.reviewDesign(f.ctx);
		await run.enterDesign(f.ctx);
		writeFileSync(path.join(f.cwd, "second.md"), "Second contract\n");
		await run.reviewDesign(f.ctx);
		assert.deepEqual(f.state.todos[0].designs[0].changedFiles, ["first.md", "second.md"]);
		assert.equal(f.state.todos[0].designs.length, 1);
	} finally { f.close(); }
});

test("code acceptance rejects files changed after review", async () => {
	const f = fixture();
	try {
		const run = f.orchestrator();
		await run.execute(f.ctx);
		await run.reviewDesign(f.ctx);
		await run.approveDesign(f.ctx);
		writeFileSync(path.join(f.cwd, "code.ts"), "export const changed = true;\n");
		await assert.rejects(run.checkCodeAcceptance(f.ctx), /Files changed after code review/);
		assert.equal(f.state.todos[0].status, "interrupted");
		await run.execute(f.ctx);
		assert.deepEqual(f.calls.map((call) => call.roleName), ["implementer", "reviewer", "reviewer"]);
	} finally { f.close(); }
});

test("returning to design after a crash retains partial implementation for review", async () => {
	const f = fixture();
	try {
		const initial = f.orchestrator();
		await initial.execute(f.ctx);
		await initial.reviewDesign(f.ctx);
		// A crash can retain the launch checkpoint while omitting cleanup results.
		const restored = f.restored();
		const todo = restored.todos[0];
		todo.designs[0].accepted = true;
		todo.designAccepted = 0;
		todo.status = "implementing";
		todo.revisions = [{ planRevision: 1, designIndex: 0, baselineTree: todo.designs[0].resultTree, changedFiles: [] }];
		todo.checkpoint = { role: "implementer", revisionIndex: 0 };
		markWorkflowInterrupted(restored);
		writeFileSync(path.join(f.cwd, "partial.ts"), "export const partial = true;\n");
		const run = f.orchestrator(restored);
		await run.enterDesign(f.ctx);
		writeFileSync(path.join(f.cwd, "design.md"), "Revised contract\n");
		await run.reviewDesign(f.ctx);
		await run.approveDesign(f.ctx);
		assert.deepEqual(todo.revisions[0].changedFiles, ["partial.ts"]);
		assert.deepEqual(todo.designs[1].changedFiles, ["design.md"]);
		assert.match(f.calls.at(-1)!.task, /export const partial = true/);
	} finally { f.close(); }
});

test("superseded plan feedback is excluded from the authoritative assignment", () => {
	const f = fixture();
	try {
		const todo = f.state.todos[0];
		todo.revisions = [{ changedFiles: [], humanFeedback: "Old requirement." }, { changedFiles: [], humanFeedback: "Current requirement." }];
		todo.feedbackStart = 1;
		const invocation = implementerInvocation(f.state, todo, f.content);
		assert.doesNotMatch(invocation.systemPrompt, /Old requirement/);
		assert.match(invocation.systemPrompt, /Current requirement/);
	} finally { f.close(); }
});

test("persisted live leases prevent entering human design editing", async () => {
	const f = fixture();
	try {
		await f.orchestrator().execute(f.ctx);
		const lease = f.store.acquire(f.state);
		try {
			await assert.rejects(f.orchestrator().enterDesign(f.ctx), /still owns|active/);
			assert.throws(() => f.orchestrator().checkIdle(f.ctx), /still owns|active/);
		} finally { lease.release(); }
	} finally { f.close(); }
});
