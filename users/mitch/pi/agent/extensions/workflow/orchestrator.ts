import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_REVIEW_CYCLES, type CompleteWorkflowModelConfig } from "./config.ts";
import type { WorkflowContent } from "./content.ts";
import { implementerInvocation, reviewerInvocation, validateImplementation, validateReview } from "./context.ts";
import { diffForHumanCheckpoint, diffTrees, snapshotWorktree } from "./git.ts";
import { extractProtocolJson, runAgent } from "./runner.ts";
import { WorkflowSessionStore, type WorkflowLease } from "./sessions.ts";
import { completeTodosManuallyBefore, currentTodo, isWorkflowComplete, latestRevision, nextPendingTodo, type ImplementationResult, type ReviewResult, type WorkflowRevision, type WorkflowState, type WorkflowTodo } from "./state.ts";
import { todoSummary } from "./ui.ts";

export interface OrchestratorHooks {
	persist: () => void;
	updateUi: (ctx: ExtensionContext) => void;
	content: () => WorkflowContent;
	models: (ctx: ExtensionContext, signal?: AbortSignal) => Promise<CompleteWorkflowModelConfig>;
	sessions: (ctx: ExtensionContext) => WorkflowSessionStore;
	runAgent?: typeof runAgent;
}

export function shouldAutomaticallyRevise(todo: WorkflowTodo, maxReviewCycles = DEFAULT_MAX_REVIEW_CYCLES): boolean {
	return latestRevision(todo)?.review?.verdict === "request_changes" && todo.automaticReviewCycles < maxReviewCycles;
}

export class WorkflowOrchestrator {
	private running = false;
	private stopping = false;
	private activeRun?: { controller: AbortController; promise: Promise<void> };
	private readonly state: WorkflowState;
	private readonly hooks: OrchestratorHooks;

	constructor(state: WorkflowState, hooks: OrchestratorHooks) {
		this.state = state;
		this.hooks = hooks;
	}

	isRunning(): boolean { return this.running; }

	private changed(ctx: ExtensionContext): void {
		this.state.updatedAt = Date.now();
		this.hooks.persist();
		this.hooks.updateUi(ctx);
	}

	private store(ctx: ExtensionContext): WorkflowSessionStore {
		const store = this.hooks.sessions(ctx);
		this.state.ownerSessionId ??= store.ownerSessionId;
		return store;
	}

	private async runExclusive(
		ctx: ExtensionContext,
		run: (signal: AbortSignal, models: CompleteWorkflowModelConfig, store: WorkflowSessionStore, lease: WorkflowLease) => Promise<void>,
	): Promise<void> {
		if (this.running || this.stopping) throw new Error("A workflow subagent is already running or stopping.");
		this.running = true;
		const controller = new AbortController();
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
		const promise = (async () => {
			const models = await this.hooks.models(ctx, signal);
			signal.throwIfAborted();
			const store = this.store(ctx);
			const lease = store.acquire(this.state);
			try { await run(signal, models, store, lease); }
			finally { lease.release(); }
		})();
		this.activeRun = { controller, promise };
		try { await promise; }
		finally {
			if (this.activeRun?.promise === promise) this.activeRun = undefined;
			this.running = false;
		}
	}

	/** Keep the instance fenced until the caller has completed its state transition. */
	async stop(): Promise<void> {
		this.stopping = true;
		const active = this.activeRun;
		if (!active) return;
		active.controller.abort();
		try { await active.promise; }
		catch (error) { if (!active.controller.signal.aborted) throw error; }
	}

	/** Terminal transitions keep summary artefacts but release the role conversations. */
	cleanupTodos(ctx: ExtensionContext, todos: WorkflowTodo[]): void {
		if (this.running) throw new Error("Stop the workflow before deleting its sessions.");
		if (!todos.some((todo) => Object.keys(todo.sessions ?? {}).length)) {
			for (const todo of todos) todo.checkpoint = undefined;
			return;
		}
		const store = this.store(ctx);
		const lease = store.acquire(this.state, true);
		try { for (const todo of todos) store.deleteTodo(this.state, todo); }
		finally { lease.release(); }
	}

	cleanupWorkflow(ctx: ExtensionContext): void {
		if (this.running) throw new Error("Stop the workflow before deleting its sessions.");
		if (!this.state.ownerSessionId) return;
		const store = this.store(ctx);
		if (!store.hasDirectory(this.state)) {
			for (const todo of this.state.todos) { todo.sessions = undefined; todo.checkpoint = undefined; }
			return;
		}
		const lease = store.acquire(this.state, true);
		try { store.deleteWorkflow(this.state); }
		finally { lease.release(); }
	}

	async execute(ctx: ExtensionContext): Promise<void> {
		if (this.running || this.stopping) throw new Error("A workflow subagent is already running or stopping.");
		if (this.state.paused) throw new Error("Workflow is paused. Run /workflow resume first.");
		const todo = currentTodo(this.state) ?? nextPendingTodo(this.state);
		if (!todo) {
			ctx.ui.notify(isWorkflowComplete(this.state) ? "Workflow is complete." : "There are no workflow todos to execute.", "info");
			return;
		}
		if (todo.status === "awaiting-user") {
			ctx.ui.notify(`${todoSummary(todo)}\n\nUse /workflow review, approve, or feedback.`, "info");
			return;
		}
		if (todo.skillRequest) throw new Error(`Todo ${todo.step} requests unknown Agent Skill "${todo.skillRequest}". Use /workflow skill ${todo.step} <name|none>.`);
		await this.runExclusive(ctx, async (signal, models, store, lease) => {
			this.state.executing = true;
			this.state.currentStep = todo.step;
			await this.runTodo(ctx, todo, models, store, lease, signal);
		});
	}

	async executeFrom(ctx: ExtensionContext, targetStep: number): Promise<void> {
		const selected = currentTodo(this.state) ?? nextPendingTodo(this.state);
		const target = this.state.todos.find((todo) => todo.step === targetStep);
		if (!selected) throw new Error("There is no current workflow todo to bypass.");
		if (!target) throw new Error(`Todo ${targetStep} does not exist.`);
		if (target.step <= selected.step) throw new Error(`Todo ${targetStep} is not later than the current todo ${selected.step}.`);
		if (target.status !== "pending") throw new Error(`Todo ${targetStep} is ${target.status}, not pending.`);
		if (target.skillRequest) throw new Error(`Todo ${target.step} requests unknown Agent Skill "${target.skillRequest}".`);
		await this.stop();
		try {
			const earlier = this.state.todos.filter((todo) => todo.step < targetStep);
			const completed = completeTodosManuallyBefore(this.state, targetStep);
			this.changed(ctx);
			this.cleanupTodos(ctx, earlier);
			this.state.currentStep = targetStep;
			this.state.executing = false;
			this.state.paused = false;
			this.changed(ctx);
			ctx.ui.notify(`Marked todo${completed.length === 1 ? "" : "s"} ${completed.map((todo) => todo.step).join(", ")} completed manually. Starting todo ${targetStep}.`, "info");
		} finally { this.stopping = false; }
		await this.execute(ctx);
	}

	async reviseFromHuman(ctx: ExtensionContext, todo: WorkflowTodo, feedback: string): Promise<void> {
		await this.runExclusive(ctx, async (signal, models, store, lease) => {
			todo.revisions.push({ humanFeedback: feedback, changedFiles: [] });
			todo.checkpoint = undefined;
			todo.automaticReviewCycles = 0;
			todo.status = "revising";
			todo.error = undefined;
			this.state.paused = false;
			this.state.executing = true;
			this.state.currentStep = todo.step;
			this.changed(ctx);
			await this.runTodo(ctx, todo, models, store, lease, signal);
		});
	}

	private async captureDiffs(ctx: ExtensionContext, todo: WorkflowTodo, record: WorkflowRevision, reconcileReview = false): Promise<void> {
		const resultTree = await snapshotWorktree(ctx.cwd);
		if (reconcileReview && (!record.resultTree || record.resultTree !== resultTree)) record.review = undefined;
		record.resultTree = resultTree;
		const diff = await diffTrees(ctx.cwd, record.baselineTree, record.resultTree);
		record.changedFiles = diff.changedFiles.length ? diff.changedFiles : record.implementation?.filesChanged ?? [];
		record.diffPreview = diff.preview;
		// A resumed stage can update the same revision, so invalidate its cached checkpoint diff.
		record.humanCheckpointChangedFiles = undefined;
		record.humanCheckpointDiffPreview = undefined;
		const human = await diffForHumanCheckpoint(ctx.cwd, todo);
		record.humanCheckpointChangedFiles = human.changedFiles;
		record.humanCheckpointDiffPreview = human.preview;
		const firstBaseline = todo.revisions.find((revision) => revision.baselineTree)?.baselineTree;
		if (firstBaseline && record.resultTree) {
			const cumulative = await diffTrees(ctx.cwd, firstBaseline, record.resultTree);
			record.cumulativeChangedFiles = cumulative.changedFiles;
			record.cumulativeDiffPreview = cumulative.preview;
		} else {
			record.cumulativeChangedFiles = [...new Set(todo.revisions.flatMap((revision) => revision.changedFiles))];
			record.cumulativeDiffPreview = todo.revisions.map((revision) => revision.diffPreview).filter(Boolean).join("\n\n");
		}
		this.changed(ctx);
	}

	private async runTodo(ctx: ExtensionContext, todo: WorkflowTodo, models: CompleteWorkflowModelConfig, store: WorkflowSessionStore, lease: WorkflowLease, signal: AbortSignal): Promise<void> {
		try {
			while (true) {
				signal.throwIfAborted();
				const interrupted = todo.checkpoint !== undefined;
				let record = todo.checkpoint ? todo.revisions[todo.checkpoint.revisionIndex] : undefined;
				if (!record) {
					const pending = latestRevision(todo);
					record = pending?.humanFeedback && !pending.implementation && !pending.baselineTree && !pending.resultTree ? pending : { changedFiles: [] };
					if (record !== pending) todo.revisions.push(record);
					todo.automaticReviewCycles++;
					todo.checkpoint = { role: "implementer", revisionIndex: todo.revisions.length - 1 };
				}
				todo.error = undefined;
				const content = this.hooks.content();
				if (!record.implementation) {
					todo.status = todo.attempts ? "revising" : "implementing";
					todo.attempts++;
					// Persist the original baseline before any subprocess can change files.
					record.baselineTree ??= await snapshotWorktree(ctx.cwd);
					const prepared = store.prepare(this.state, todo, "implementer");
					this.changed(ctx);
					signal.throwIfAborted();
					try {
						const run = await (this.hooks.runAgent ?? runAgent)({
							cwd: ctx.cwd, roleName: "workflow-implementer", sessionFile: prepared.session.file,
							...implementerInvocation(this.state, todo, content, { continuing: prepared.hasHistory, interrupted }),
							tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
							model: models.implementer.model, thinkingLevel: models.implementer.thinkingLevel,
							contextFileDiscovery: models.implementer["context-file-discovery"],
							signal, onProcess: lease.setChildPid,
						});
						signal.throwIfAborted();
						record.implementation = { ...validateImplementation(extractProtocolJson<ImplementationResult>(run.output, "workflow-implementation")), model: models.implementer.model, thinkingLevel: models.implementer.thinkingLevel ?? "off" };
						todo.checkpoint!.role = "reviewer";
						this.changed(ctx);
					} finally {
						// Failed and cancelled implementers can leave edits; retain them in the review boundary.
						await this.captureDiffs(ctx, todo, record);
					}
				} else if (interrupted) {
					await this.captureDiffs(ctx, todo, record, true);
				}
				signal.throwIfAborted();
				if (record.implementation?.status === "blocked") {
					record.review = { verdict: "escalate", summary: "The implementer reported that the task is blocked.", findings: [record.implementation.notes ?? "No blocker details supplied."] };
				} else if (!record.review) {
					todo.status = "reviewing";
					todo.checkpoint!.role = "reviewer";
					const prepared = store.prepare(this.state, todo, "reviewer");
					this.changed(ctx);
					const run = await (this.hooks.runAgent ?? runAgent)({
						cwd: ctx.cwd, roleName: "workflow-reviewer", sessionFile: prepared.session.file,
						...reviewerInvocation(this.state, todo, content, { continuing: prepared.hasHistory, interrupted }),
						tools: ["read", "grep", "find", "ls"],
						model: models.reviewer.model, thinkingLevel: models.reviewer.thinkingLevel,
						contextFileDiscovery: models.reviewer["context-file-discovery"],
						signal, onProcess: lease.setChildPid,
					});
					signal.throwIfAborted();
					record.review = { ...validateReview(extractProtocolJson<ReviewResult>(run.output, "workflow-review")), model: models.reviewer.model, thinkingLevel: models.reviewer.thinkingLevel ?? "off" };
					this.changed(ctx);
				}
				if (shouldAutomaticallyRevise(todo, models["max-review-cycles"])) {
					// The completed checkpoint remains durable until the next revision is allocated.
					todo.checkpoint = undefined;
					continue;
				}
				todo.checkpoint = undefined;
				todo.status = "awaiting-user";
				this.state.executing = false;
				this.changed(ctx);
				const approved = record.review?.verdict === "approve";
				ctx.ui.notify(`${approved ? "Reviewer approved; your approval is required." : "Workflow escalated for your decision."}\n\n${todoSummary(todo)}\n\nUse /workflow review.`, approved ? "info" : "warning");
				return;
			}
		} catch (error) {
			todo.status = signal.aborted ? "interrupted" : "failed";
			todo.error = signal.aborted ? "Execution was interrupted. Use /workflow execute or /workflow resume to continue." : error instanceof Error ? error.message : String(error);
			this.state.executing = false;
			this.changed(ctx);
			if (!signal.aborted) ctx.ui.notify(`Workflow todo ${todo.step} failed: ${todo.error}`, "error");
		}
	}
}
