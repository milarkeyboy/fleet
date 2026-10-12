// Human design review, acceptance and Git phase boundaries.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./design-fixture.ts";

test("execution enters human editing without starting an agent", async () => {
	const f = fixture();
	try {
		await f.orchestrator().execute(f.ctx);
		assert.equal(f.state.todos[0].status, "design-editing");
		assert.equal(f.calls.length, 0);
	} finally { f.close(); }
});

test("an empty design phase skips the reviewer and waits for human acceptance", async () => {
	const f = fixture();
	try {
		const run = f.orchestrator();
		await run.execute(f.ctx);
		await run.reviewDesign(f.ctx);
		assert.equal(f.state.todos[0].status, "awaiting-design");
		assert.equal(f.calls.length, 0);
		await run.approveDesign(f.ctx);
		assert.deepEqual(f.calls.map((call) => call.roleName), ["implementer", "reviewer"]);
	} finally { f.close(); }
});

test("design review captures Markdown, Doxygen and signature edits", async () => {
	const f = fixture();
	try {
		const run = f.orchestrator();
		await run.execute(f.ctx);
		writeFileSync(path.join(f.cwd, "README.md"), "# API\nStarts a task.\n");
		writeFileSync(path.join(f.cwd, "api.h"), "/** Starts a task. */\nvoid start();\n");
		await run.reviewDesign(f.ctx);
		assert.deepEqual(f.state.todos[0].designs[0].changedFiles, ["README.md", "api.h"]);
		assert.match(f.calls[0].task, /void start\(\);/);
		assert.deepEqual(f.calls[0].tools, ["read", "grep", "find", "ls"]);
	} finally { f.close(); }
});

test("edits before entering design remain context rather than design changes", async () => {
	const f = fixture();
	try {
		writeFileSync(path.join(f.cwd, "earlier.md"), "Existing work\n");
		const run = f.orchestrator();
		await run.execute(f.ctx);
		writeFileSync(path.join(f.cwd, "design.md"), "New contract\n");
		await run.reviewDesign(f.ctx);
		assert.deepEqual(f.state.todos[0].designs[0].changedFiles, ["design.md"]);
	} finally { f.close(); }
});

test("repeated design reviews retain the phase baseline and role conversation", async () => {
	const f = fixture();
	try {
		const run = f.orchestrator();
		await run.execute(f.ctx);
		writeFileSync(path.join(f.cwd, "design.md"), "First contract\n");
		await run.reviewDesign(f.ctx);
		const baseline = f.state.todos[0].designs[0].baselineTree;
		writeFileSync(path.join(f.cwd, "design.md"), "Second contract\n");
		await run.reviewDesign(f.ctx, "Reconsider the contract.");
		assert.equal(f.calls[0].sessionFile, f.calls[1].sessionFile);
		assert.equal(f.state.todos[0].designs[0].baselineTree, baseline);
		assert.equal(f.state.todos[0].designs[0].reviews.length, 2);
		assert.match(f.calls[1].task, /Second contract/);
	} finally { f.close(); }
});

test("edits after design review prevent stale acceptance", async () => {
	const f = fixture();
	try {
		const run = f.orchestrator();
		await run.execute(f.ctx);
		await run.reviewDesign(f.ctx);
		writeFileSync(path.join(f.cwd, "design.md"), "Changed contract\n");
		await assert.rejects(run.approveDesign(f.ctx), /Files changed after design review/);
		assert.equal(f.state.todos[0].status, "design-editing");
		assert.equal(f.state.todos[0].designAccepted, undefined);
		assert.equal(f.calls.length, 0);
	} finally { f.close(); }
});

test("design acceptance separates implementation changes from human edits", async () => {
	const f = fixture();
	try {
		const run = f.orchestrator();
		await run.execute(f.ctx);
		writeFileSync(path.join(f.cwd, "design.md"), "Contract\n");
		await run.reviewDesign(f.ctx);
		f.controls.beforeRun = async (options) => {
			if (options.roleName === "implementer") writeFileSync(path.join(f.cwd, "code.ts"), "export const ready = true;\n");
		};
		await run.approveDesign(f.ctx);
		assert.deepEqual(f.state.todos[0].revisions[0].changedFiles, ["code.ts"]);
		assert.match(f.calls[1].systemPrompt, /Contract/);
	} finally { f.close(); }
});

test("a restored design checkpoint requires explicit acceptance", async () => {
	const f = fixture();
	try {
		await f.orchestrator().execute(f.ctx);
		await f.orchestrator().reviewDesign(f.ctx);
		const restored = f.restored();
		await f.orchestrator(restored).execute(f.ctx);
		assert.equal(restored.todos[0].status, "awaiting-design");
		assert.equal(f.calls.length, 0);
	} finally { f.close(); }
});

test("execution fails before state changes outside Git", async () => {
	const f = fixture();
	try {
		await assert.rejects(f.orchestrator().execute({ ...f.ctx, cwd: f.root }), /requires a Git working tree/);
		assert.equal(f.state.todos[0].status, "pending");
		assert.equal(f.calls.length, 0);
	} finally { f.close(); }
});
