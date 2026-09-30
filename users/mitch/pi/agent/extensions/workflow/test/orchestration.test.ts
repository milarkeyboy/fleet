// Per-todo conversation continuity and stage recovery without model credentials.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WorkflowOrchestrator } from "../orchestrator.ts";
import { createWorkflowTodos } from "../planner.ts";
import type { AgentRunOptions } from "../runner.ts";
import { WorkflowSessionStore } from "../sessions.ts";
import { cloneState, createWorkflowState, markWorkflowInterrupted, restoreState, type WorkflowState } from "../state.ts";

function fixture() {
	const root = mkdtempSync(path.join(os.tmpdir(), "workflow-orchestration-"));
	const cwd = path.join(root, "work");
	execFileSync("git", ["init", "-q", cwd]);
	const store = new WorkflowSessionStore(path.join(root, "sessions"), "parent", cwd);
	const ctx = { cwd, ui: { notify() {} } } as unknown as ExtensionContext;
	const state = createWorkflowState();
	state.todos = createWorkflowTodos([{ title: "First", instructions: ["Implement first."] }, { title: "Second", instructions: ["Implement second."] }]);
	const calls: AgentRunOptions[] = [];
	const saved: WorkflowState[] = [];
	const verdicts: string[] = [];
	const controls = { beforeRun: async (_options: AgentRunOptions) => {} };
	function orchestrator(current = state) {
		return new WorkflowOrchestrator(current, {
			persist() { saved.push(cloneState(current)); }, updateUi() {}, sessions: () => store,
			async models() { return { implementer: { model: "test/impl" }, reviewer: { model: "test/review" } }; },
			content: () => ({ planner: "", skills: {}, diagnostics: [], roles: {
				implementer: { name: "implementer", body: "Implement.", filePath: "/impl.md", source: "bundled" },
				reviewer: { name: "reviewer", body: "Review.", filePath: "/review.md", source: "bundled" },
			} }),
			async runAgent(options) {
				calls.push(options);
				appendFileSync(options.sessionFile, `${JSON.stringify({ type: "message", message: { role: "user", content: options.task } })}\n`);
				await controls.beforeRun(options);
				const output = options.roleName === "workflow-implementer"
					? '<workflow-implementation>{"status":"completed","summary":"done","filesChanged":[],"tests":[]}</workflow-implementation>'
					: `<workflow-review>{"verdict":"${verdicts.shift() ?? "approve"}","summary":"reviewed","findings":["Review finding."]}</workflow-review>`;
				return { exitCode: 0, output, stderr: "", messages: [] };
			},
		});
	}
	return { root, cwd, ctx, state, store, calls, saved, verdicts, controls, orchestrator, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("automatic and human revisions reuse each role's distinct conversation", async () => {
	const f = fixture();
	try {
		f.verdicts.push("request_changes", "approve", "approve");
		const run = f.orchestrator();
		await run.execute(f.ctx);
		await run.reviseFromHuman(f.ctx, f.state.todos[0], "Remove the fallback.");
		assert.equal(f.calls.length, 6);
		assert.equal(f.calls[0].sessionFile, f.calls[2].sessionFile);
		assert.equal(f.calls[2].sessionFile, f.calls[4].sessionFile);
		assert.equal(f.calls[1].sessionFile, f.calls[3].sessionFile);
		assert.equal(f.calls[3].sessionFile, f.calls[5].sessionFile);
		assert.notEqual(f.calls[0].sessionFile, f.calls[1].sessionFile);
		assert.match(f.calls[2].task, /^Continue todo 1/);
		assert.match(f.calls[3].task, /^Review again todo 1/);
		assert.match(f.calls[5].systemPrompt, /Remove the fallback/);
		assert.equal(f.state.todos[0].status, "awaiting-user");
	} finally { f.close(); }
});

test("a new todo gets new role sessions", async () => {
	const f = fixture();
	try {
		const run = f.orchestrator();
		await run.execute(f.ctx);
		f.state.todos[0].status = "approved";
		f.state.currentStep = 2;
		await run.execute(f.ctx);
		assert.notEqual(f.calls[0].sessionFile, f.calls[2].sessionFile);
		assert.notEqual(f.calls[1].sessionFile, f.calls[3].sessionFile);
		assert.match(f.calls[2].task, /^Implement todo 2/);
	} finally { f.close(); }
});

test("a restored human checkpoint continues the persisted conversations", async () => {
	const f = fixture();
	try {
		await f.orchestrator().execute(f.ctx);
		const restored = restoreState(cloneState(f.state))!;
		await f.orchestrator(restored).reviseFromHuman(f.ctx, restored.todos[0], "Change the label.");
		assert.equal(f.calls[0].sessionFile, f.calls[2].sessionFile);
		assert.equal(f.calls[1].sessionFile, f.calls[3].sessionFile);
		assert.match(f.calls[2].task, /^Continue todo 1/);
	} finally { f.close(); }
});

test("failed review resumes review without reimplementing completed work", async () => {
	const f = fixture();
	try {
		f.controls.beforeRun = async (options) => { if (options.roleName === "workflow-reviewer") throw new Error("review disconnected"); };
		await f.orchestrator().execute(f.ctx);
		assert.equal(f.state.todos[0].status, "failed");
		assert.deepEqual(f.state.todos[0].checkpoint, { role: "reviewer", revisionIndex: 0 });
		const restored = restoreState(cloneState(f.state))!;
		f.controls.beforeRun = async () => {};
		await f.orchestrator(restored).execute(f.ctx);
		assert.deepEqual(f.calls.map((call) => call.roleName), ["workflow-implementer", "workflow-reviewer", "workflow-reviewer"]);
		assert.equal(f.calls[1].sessionFile, f.calls[2].sessionFile);
		assert.equal(restored.todos[0].attempts, 1);
		assert.equal(restored.todos[0].status, "awaiting-user");
	} finally { f.close(); }
});

test("retrying an interrupted implementer retains edits in the original diff boundary", async () => {
	const f = fixture();
	try {
		f.controls.beforeRun = async () => { writeFileSync(path.join(f.cwd, "partial.txt"), "partial work\n"); throw new Error("disconnected"); };
		await f.orchestrator().execute(f.ctx);
		const baseline = f.state.todos[0].revisions[0].baselineTree;
		const restored = restoreState(cloneState(f.state))!;
		f.controls.beforeRun = async () => {};
		await f.orchestrator(restored).execute(f.ctx);
		assert.equal(restored.todos[0].revisions.length, 1);
		assert.equal(restored.todos[0].revisions[0].baselineTree, baseline);
		assert.deepEqual(restored.todos[0].revisions[0].changedFiles, ["partial.txt"]);
		assert.match(f.calls[1].task, /Reconcile the existing edits/);
		assert.match(f.calls[2].task, /partial work/);
	} finally { f.close(); }
});

test("restored in-flight work is stopped until explicitly resumed", () => {
	const f = fixture();
	try {
		f.state.executing = true;
		f.state.todos[0].status = "reviewing";
		markWorkflowInterrupted(f.state);
		assert.equal(f.state.executing, false);
		assert.equal(f.state.todos[0].status, "interrupted");
		assert.equal(f.calls.length, 0);
	} finally { f.close(); }
});

test("stopping awaits the worker before transcript deletion", async () => {
	const f = fixture();
	try {
		let entered!: () => void;
		const active = new Promise<void>((resolve) => { entered = resolve; });
		f.controls.beforeRun = async (options) => {
			entered();
			await new Promise<void>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
		};
		const run = f.orchestrator();
		const execution = run.execute(f.ctx);
		await active;
		const file = f.calls[0].sessionFile;
		assert.throws(() => run.cleanupWorkflow(f.ctx), /Stop the workflow/);
		await run.stop();
		await execution;
		assert.equal(f.calls[0].signal?.aborted, true);
		assert.equal(f.state.todos[0].status, "interrupted");
		assert.equal(f.calls.length, 1);
		run.cleanupWorkflow(f.ctx);
		assert.equal(existsSync(file), false);
	} finally { f.close(); }
});
