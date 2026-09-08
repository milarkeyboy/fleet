import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { shouldAutomaticallyRevise, WorkflowOrchestrator } from "../orchestrator.ts";
import { completeTodosManuallyBefore, createWorkflowState, cumulativeRevision, currentTodo, humanCheckpointRevision, isWorkflowComplete, restoreState, type WorkflowTodo } from "../state.ts";

function todo(cycles: number): WorkflowTodo {
	return { step: 1, text: "Task", primarySkill: "python", status: "reviewing", attempts: cycles, automaticReviewCycles: cycles, revisions: [{ changedFiles: [], review: { verdict: "request_changes", summary: "fix", findings: ["issue"] } }] };
}

test("review retries stop after two implement/review cycles", () => {
	assert.equal(shouldAutomaticallyRevise(todo(1)), true);
	assert.equal(shouldAutomaticallyRevise(todo(2)), false);
});

test("restores current workflow state", () => {
	const state = createWorkflowState();
	state.goal = "Goal";
	assert.equal(restoreState(JSON.parse(JSON.stringify(state)))?.goal, "Goal");
	assert.equal(restoreState({ version: 5, todos: [] }), undefined);
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
	assert.equal(restored?.version, 4);
	assert.equal(restored?.todos[0].primarySkill, "cpp");
	assert.equal(restored?.todos[0].skillSource, "plan");
	assert.equal(restored?.todos[1].primarySkill, undefined);
	assert.equal("language" in (restored?.todos[0] ?? {}), false);
});

test("migrates persisted todo results into the first revision", () => {
	const restored = restoreState({
		version: 2,
		planning: false,
		executing: false,
		paused: false,
		createdAt: 1,
		updatedAt: 1,
		todos: [{
			step: 1,
			text: "Task",
			status: "awaiting-user",
			attempts: 1,
			automaticReviewCycles: 1,
			implementation: { status: "completed", summary: "implemented", filesChanged: ["task.ts"], tests: ["npm test"] },
			review: { verdict: "request_changes", summary: "needs a fix", findings: ["Fix task.ts"] },
			baselineTree: "before",
			resultTree: "after",
			changedFiles: ["task.ts"],
			diffPreview: "diff",
		}],
	});
	assert.equal(restored?.version, 4);
	assert.equal(restored?.todos[0].revisions.length, 1);
	assert.equal(restored?.todos[0].revisions[0].implementation?.summary, "implemented");
	assert.equal(restored?.todos[0].revisions[0].review?.findings[0], "Fix task.ts");
	assert.equal(restored?.todos[0].revisions[0].diffPreview, "diff");
	assert.equal("implementation" in (restored?.todos[0] ?? {}), false);
});

test("restores all ordered revisions without collapsing their results", () => {
	const restored = restoreState({
		version: 3,
		todos: [{
			step: 1,
			text: "Task",
			status: "awaiting-user",
			attempts: 2,
			automaticReviewCycles: 2,
			revisions: [
			{ changedFiles: ["one.ts"], implementation: { status: "completed", summary: "first", filesChanged: [], tests: [] } },
			{ changedFiles: ["two.ts"], implementation: { status: "completed", summary: "second", filesChanged: [], tests: [] } },
		],
		}],
	});
	assert.deepEqual(restored?.todos[0].revisions.map((revision) => revision.implementation?.summary), ["first", "second"]);
	assert.deepEqual(restored?.todos[0].revisions.map((revision) => revision.changedFiles), [["one.ts"], ["two.ts"]]);
});

test("human checkpoint results begin at the latest human feedback", () => {
	const todo: WorkflowTodo = {
		step: 1,
		text: "Task",
		status: "awaiting-user",
		attempts: 4,
		automaticReviewCycles: 2,
		revisions: [
			{ baselineTree: "todo-base", resultTree: "first", changedFiles: ["one.ts"], diffPreview: "diff one" },
			{ baselineTree: "first", resultTree: "first-checkpoint", changedFiles: ["two.ts"], diffPreview: "diff two", humanCheckpointChangedFiles: ["one.ts", "two.ts"], humanCheckpointDiffPreview: "first checkpoint diff" },
			{ humanFeedback: "Revise it.", baselineTree: "first-checkpoint", resultTree: "third", changedFiles: ["three.ts"], diffPreview: "diff three" },
			{ baselineTree: "third", resultTree: "second-checkpoint", changedFiles: ["four.ts"], diffPreview: "diff four", humanCheckpointChangedFiles: ["three.ts", "four.ts"], humanCheckpointDiffPreview: "second checkpoint diff" },
		],
	};

	const checkpoint = humanCheckpointRevision(todo);
	assert.equal(checkpoint?.baselineTree, "first-checkpoint");
	assert.equal(checkpoint?.resultTree, "second-checkpoint");
	assert.deepEqual(checkpoint?.changedFiles, ["three.ts", "four.ts"]);
	assert.equal(checkpoint?.diffPreview, "second checkpoint diff");
});

test("initial human checkpoint results begin at the todo baseline", () => {
	const todo: WorkflowTodo = {
		step: 1,
		text: "Task",
		status: "awaiting-user",
		attempts: 2,
		automaticReviewCycles: 2,
		revisions: [
			{ baselineTree: "todo-base", resultTree: "first", changedFiles: ["one.ts"], diffPreview: "diff one" },
			{ baselineTree: "first", resultTree: "checkpoint", changedFiles: ["two.ts"], diffPreview: "diff two", humanCheckpointChangedFiles: ["one.ts", "two.ts"], humanCheckpointDiffPreview: "checkpoint diff" },
		],
	};

	assert.equal(humanCheckpointRevision(todo)?.baselineTree, "todo-base");
});

test("cumulative todo results retain files changed across revisions", () => {
	const restored = restoreState({
		version: 3,
		todos: [{
			step: 1,
			text: "Task",
			status: "awaiting-user",
			attempts: 2,
			automaticReviewCycles: 2,
			revisions: [
				{ baselineTree: "base", resultTree: "first", changedFiles: ["one.ts"], diffPreview: "diff one", implementation: { status: "completed", summary: "first", filesChanged: ["one.ts"], tests: [] } },
				{ baselineTree: "first", resultTree: "second", changedFiles: ["two.ts"], diffPreview: "diff two", implementation: { status: "completed", summary: "second", filesChanged: ["two.ts"], tests: [] } },
			],
		}],
	});
	const cumulative = cumulativeRevision(restored!.todos[0]);
	assert.equal(cumulative?.baselineTree, "base");
	assert.equal(cumulative?.resultTree, "second");
	assert.deepEqual(cumulative?.changedFiles, ["one.ts", "two.ts"]);
	assert.match(cumulative?.diffPreview ?? "", /diff one/);
	assert.match(cumulative?.diffPreview ?? "", /diff two/);
});

test("manual completion persists, advances the current todo, and counts toward completion", () => {
	const state = createWorkflowState();
	state.currentStep = 1;
	state.todos = [
		{ step: 1, text: "Manual change", status: "awaiting-user", attempts: 1, automaticReviewCycles: 1, revisions: [] },
		{ step: 2, text: "Skipped change", status: "failed", attempts: 1, automaticReviewCycles: 1, revisions: [], error: "failed" },
		{ step: 3, text: "Next change", status: "pending", attempts: 0, automaticReviewCycles: 0, revisions: [] },
	];

	const completed = completeTodosManuallyBefore(state, 3);
	state.currentStep = 3;
	assert.deepEqual(completed.map((todo) => todo.step), [1, 2]);
	assert.deepEqual(state.todos.map((todo) => todo.status), ["completed-manually", "completed-manually", "pending"]);
	assert.equal(state.todos[1].error, undefined);
	assert.equal(currentTodo(state)?.step, 3);
	assert.equal(isWorkflowComplete(state), false);

	state.todos[2].status = "approved";
	assert.equal(isWorkflowComplete(state), true);
	assert.equal(restoreState(JSON.parse(JSON.stringify(state)))?.todos[0].status, "completed-manually");
});

test("model preflight fails before workflow execution changes todo state", async () => {
	const state = createWorkflowState();
	state.todos = [{ step: 1, text: "Task", status: "pending", attempts: 0, automaticReviewCycles: 0, revisions: [] }];
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

test("orchestration caches net diffs between human checkpoints", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-checkpoints-"));
	try {
		execFileSync("git", ["init", "-q", cwd]);
		const state = createWorkflowState();
		state.todos = [{ step: 1, text: "Task", status: "pending", attempts: 0, automaticReviewCycles: 0, revisions: [] }];
		let calls = 0;
		const orchestrator = new WorkflowOrchestrator(state, {
			persist() {},
			updateUi() {},
			content() {
				return {
					planner: "",
					roles: {
						implementer: { name: "implementer", body: "Implement", filePath: "/implementer.md", source: "bundled" },
						reviewer: { name: "reviewer", body: "Review", filePath: "/reviewer.md", source: "bundled" },
					},
					skills: {},
					diagnostics: [],
				};
			},
			async models() {
				return { implementer: { model: "test/implementer" }, reviewer: { model: "test/reviewer" } } as any;
			},
			async runAgent(options) {
				calls++;
				if (options.roleName === "workflow-implementer") {
					const file = ["one.ts", "two.ts", "three.ts", "four.ts"][Math.floor(calls / 2)]!;
					await writeFile(path.join(cwd, file), `${file}\n`);
					return { exitCode: 0, output: `<workflow-implementation>{"status":"completed","summary":"${file}","filesChanged":["${file}"],"tests":[]}</workflow-implementation>`, stderr: "", messages: [] };
				}
				const verdict = calls === 2 || calls === 6 ? "request_changes" : "approve";
				return { exitCode: 0, output: `<workflow-review>{"verdict":"${verdict}","summary":"reviewed","findings":${verdict === "request_changes" ? '["revise"]' : "[]"}}</workflow-review>`, stderr: "", messages: [] };
			},
		});
		const ctx = { cwd, signal: undefined, ui: { notify() {} } } as any;

		await orchestrator.execute(ctx);
		assert.deepEqual(state.todos[0].revisions.at(-1)?.humanCheckpointChangedFiles?.sort(), ["one.ts", "two.ts"]);
		assert.match(state.todos[0].revisions.at(-1)?.humanCheckpointDiffPreview ?? "", /one\.ts/);
		assert.match(state.todos[0].revisions.at(-1)?.humanCheckpointDiffPreview ?? "", /two\.ts/);

		await orchestrator.reviseFromHuman(ctx, state.todos[0], "Revise after my review.");
		const checkpoint = state.todos[0].revisions.at(-1);
		assert.deepEqual(checkpoint?.humanCheckpointChangedFiles?.sort(), ["four.ts", "three.ts"]);
		assert.match(checkpoint?.humanCheckpointDiffPreview ?? "", /three\.ts/);
		assert.match(checkpoint?.humanCheckpointDiffPreview ?? "", /four\.ts/);
		assert.doesNotMatch(checkpoint?.humanCheckpointDiffPreview ?? "", /one\.ts|two\.ts/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("forcing a later todo cancels the active run without recording a failure", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-force-"));
	try {
		const state = createWorkflowState();
		state.todos = [
			{ step: 1, text: "First task", status: "pending", attempts: 0, automaticReviewCycles: 0, revisions: [] },
			{ step: 2, text: "Second task", status: "pending", attempts: 0, automaticReviewCycles: 0, revisions: [] },
		];
		const notifications: string[] = [];
		let calls = 0;
		let entered!: () => void;
		const active = new Promise<void>((resolve) => { entered = resolve; });
		const orchestrator = new WorkflowOrchestrator(state, {
			persist() {},
			updateUi() {},
			content() {
				return {
					planner: "",
					roles: {
						implementer: { name: "implementer", body: "Implement", filePath: "/implementer.md", source: "bundled" },
						reviewer: { name: "reviewer", body: "Review", filePath: "/reviewer.md", source: "bundled" },
					},
					skills: {},
					diagnostics: [],
				};
			},
			async models() {
				return { implementer: { model: "test/implementer" }, reviewer: { model: "test/reviewer" } } as any;
			},
			async runAgent(options) {
				calls++;
				if (calls === 1) {
					entered();
					await new Promise<void>((_resolve, reject) => {
						const abort = () => reject(new Error("cancelled"));
						if (options.signal?.aborted) abort();
						else options.signal?.addEventListener("abort", abort, { once: true });
					});
				}
				const output = calls === 2
					? '<workflow-implementation>{"status":"completed","summary":"done","filesChanged":[],"tests":[]}</workflow-implementation>'
					: '<workflow-review>{"verdict":"approve","summary":"ready","findings":[]}</workflow-review>';
				return { exitCode: 0, output, stderr: "", messages: [] };
			},
		});
		const ctx = { cwd, signal: undefined, ui: { notify(message: string) { notifications.push(message); } } } as any;

		const firstRun = orchestrator.execute(ctx);
		await active;
		await orchestrator.executeFrom(ctx, 2);
		await firstRun;

		assert.equal(calls, 3);
		assert.equal(state.todos[0].status, "completed-manually");
		assert.equal(state.todos[0].error, undefined);
		assert.equal(state.todos[1].status, "awaiting-user");
		assert.equal(state.currentStep, 2);
		assert.equal(notifications.some((message) => /todo 1 failed/i.test(message)), false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
