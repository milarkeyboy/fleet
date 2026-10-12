import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_REVIEW_CYCLES, type CompleteWorkflowConfig } from "./config.ts";
import type { WorkflowContent } from "./content.ts";
import { extractProtocolJson, implementerInvocation, codeReviewerInvocation, designReviewerInvocation, validateImplementation, validateReview } from "./context.ts";
import { diffForHumanCheckpoint, diffTrees, requireWorktreeSnapshot } from "./git.ts";
import type { runAgent } from "../subagent/runner.ts";
import { WorkflowSessionStore, type WorkflowLease } from "./sessions.ts";
import { completeTodosManuallyBefore, currentTodo, isWorkflowComplete, latestRevision, nextPendingTodo, type ImplementationResult, type ReviewResult, type WorkflowRevision, type WorkflowState, type WorkflowTodo } from "./state.ts";
import { todoSummary } from "./ui.ts";

export interface OrchestratorHooks {
	persist: () => void;
	updateUi: (ctx: ExtensionContext) => void;
	content: () => WorkflowContent;
	models: (ctx: ExtensionContext, signal?: AbortSignal) => Promise<CompleteWorkflowConfig>;
	sessions: (ctx: ExtensionContext) => WorkflowSessionStore;
	runAgent?: typeof runAgent;
}

export function shouldAutomaticallyRevise(todo: WorkflowTodo, maxReviewCycles = DEFAULT_MAX_REVIEW_CYCLES): boolean {
	return latestRevision(todo)?.review?.verdict === "request_changes" && !latestRevision(todo)?.review?.blocker && todo.automaticReviewCycles < maxReviewCycles;
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
		run: (signal: AbortSignal, models: CompleteWorkflowConfig, store: WorkflowSessionStore, lease: WorkflowLease) => Promise<void>,
	): Promise<void> {
		if (this.running || this.stopping) throw new Error("A workflow subagent is already running or stopping.");
		this.running = true;
		const controller = new AbortController();
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
		const promise = (async () => {
			await requireWorktreeSnapshot(ctx.cwd);
			signal.throwIfAborted();
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

	/** Check the persisted lease as well as the in-memory worker before human changes. */
	checkIdle(ctx: ExtensionContext): void {
		if (this.running) throw new Error("Stop execution before entering planning.");
		this.store(ctx).acquire(this.state).release();
	}

	/** Terminal transitions keep summary artefacts but release the role conversations. */
	cleanupTodos(ctx: ExtensionContext, todos: WorkflowTodo[]): void {
		if (this.running) throw new Error("Stop the workflow before deleting its sessions.");
		if (!todos.some((todo) => Object.keys(todo.sessions ?? {}).length)) {
			for (const todo of todos) todo.checkpoint = undefined;
			return;
		}
		const store = this.store(ctx);
		const lease = store.acquire(this.state);
		try { for (const todo of todos) store.deleteTodo(this.state, todo); }
		finally { lease.release(); }
	}

	cleanupWorkflow(ctx: ExtensionContext): void {
		if (this.running) throw new Error("Stop the workflow before deleting its sessions.");
		if (!this.state.ownerSessionId) return;
		const store = this.store(ctx);
		const lease = store.acquire(this.state);
		try { store.deleteWorkflow(this.state); }
		finally { lease.release(); }
	}

	/** Preserve crash-left edits before their launch checkpoints are invalidated. */
	private async reconcileCheckpoint(ctx: ExtensionContext, todo: WorkflowTodo): Promise<void> {
		const checkpoint = todo.checkpoint;
		if (!checkpoint || checkpoint.role === "design-reviewer") return;
		const record = todo.revisions[checkpoint.revisionIndex];
		if (record?.baselineTree) await this.captureDiffs(ctx, todo, record, true);
	}

	async reconcileCheckpoints(ctx: ExtensionContext, todos: WorkflowTodo[]): Promise<void> {
		const interrupted = todos.filter((todo) => todo.checkpoint && todo.checkpoint.role !== "design-reviewer");
		if (!interrupted.length) return;
		await this.runExclusive(ctx, async (signal) => {
			for (const todo of interrupted) {
				signal.throwIfAborted();
				await this.reconcileCheckpoint(ctx, todo);
			}
			signal.throwIfAborted();
		});
	}

	/** Capture human edits separately, before allowing another implementation run. */
	async enterDesign(ctx: ExtensionContext): Promise<void> {
		const todo = currentTodo(this.state);
		if (!todo) throw new Error("There is no current todo.");
		if (this.state.amending) throw new Error("Accept or reject the plan amendment first.");
		await this.runExclusive(ctx, async (signal) => {
			await this.reconcileCheckpoint(ctx, todo);
			signal.throwIfAborted();
			if (!todo.designs.length || todo.designs.at(-1)!.accepted) {
				const baselineTree = await requireWorktreeSnapshot(ctx.cwd);
				signal.throwIfAborted();
				todo.designs.push({ planRevision: this.state.planRevision, baselineTree, changedFiles: [], reviews: [] });
			}
			todo.designAccepted = undefined;
			todo.checkpoint = undefined;
			todo.status = "design-editing";
			todo.error = undefined;
			todo.automaticReviewCycles = 0;
			this.state.currentStep = todo.step;
			this.state.executing = false;
			this.state.paused = false;
			this.changed(ctx);
		});
		ctx.ui.notify(`Todo ${todo.step}: edit design, then use /workflow design-review.`, "info");
	}

	async reviewDesign(ctx: ExtensionContext, feedback?: string): Promise<void> {
		const todo = currentTodo(this.state);
		if (!todo || !todo.designs.length || todo.designAccepted !== undefined) throw new Error("No design is available for review. Use /workflow design first.");
		if (this.state.amending || this.state.paused) throw new Error("Finish planning or resume the workflow first.");
		await this.runExclusive(ctx, async (signal, models, store, lease) => {
			const design = todo.designs.at(-1)!;
			if (feedback !== undefined) design.pendingFeedback = feedback;
			try {
				design.resultTree = await requireWorktreeSnapshot(ctx.cwd);
				const diff = await diffTrees(ctx.cwd, design.baselineTree, design.resultTree);
				design.changedFiles = diff.changedFiles;
				design.diffPreview = diff.preview;
				todo.error = undefined;
				if (design.changedFiles.length) {
					todo.status = "design-reviewing";
					todo.checkpoint = { role: "design-reviewer", revisionIndex: todo.designs.length - 1 };
					this.state.executing = true;
					const prepared = store.prepare(this.state, todo, "design-reviewer");
					this.changed(ctx);
					signal.throwIfAborted();
					const assignment = models["design-reviewer"];
					const { systemPrompt, ...invocation } = designReviewerInvocation(this.state, todo, this.hooks.content(), design.pendingFeedback);
					const run = await store.run(this.state, prepared.handle, assignment, {
						...invocation, instructions: systemPrompt, signal, onProcess: lease.setChildPid,
					}, this.hooks.runAgent);
					signal.throwIfAborted();
					const review = { ...validateReview(extractProtocolJson<ReviewResult>(run.output, "workflow-review")), model: assignment.model, thinkingLevel: assignment.thinkingLevel ?? "off" };
					design.reviews.push({ tree: design.resultTree, feedback: design.pendingFeedback, review });
					design.pendingFeedback = undefined;
				}
				todo.checkpoint = undefined;
				todo.status = await requireWorktreeSnapshot(ctx.cwd) === design.resultTree ? "awaiting-design" : "design-editing";
				this.state.executing = false;
				this.changed(ctx);
				ctx.ui.notify(`${todoSummary(todo)}\n\n${todo.status === "awaiting-design" ? "Design checkpoint ready. Use /workflow design-approve or edit and review again." : "Files changed during review. Request another design review."}`, "info");
			} catch (error) { this.failed(ctx, todo, signal, error); }
		});
	}

	async approveDesign(ctx: ExtensionContext): Promise<void> {
		const todo = currentTodo(this.state);
		if (!todo || todo.status !== "awaiting-design") throw new Error("No design is awaiting human acceptance.");
		if (this.state.amending || this.state.paused) throw new Error("Finish planning or resume the workflow first.");
		await this.runExclusive(ctx, async (signal, models, store, lease) => {
			const design = todo.designs.at(-1)!;
			if (await requireWorktreeSnapshot(ctx.cwd) !== design.resultTree) {
				todo.status = "design-editing";
				this.changed(ctx);
				throw new Error("Files changed after design review. Use /workflow design-review again.");
			}
			signal.throwIfAborted();
			design.accepted = true;
			todo.designAccepted = todo.designs.length - 1;
			todo.checkpoint = undefined;
			todo.automaticReviewCycles = 0;
			this.state.executing = true;
			this.changed(ctx);
			await this.runTodo(ctx, todo, models, store, lease, signal);
		});
	}

	async checkCodeAcceptance(ctx: ExtensionContext): Promise<void> {
		const todo = currentTodo(this.state);
		if (!todo || todo.status !== "awaiting-user" || todo.designAccepted === undefined || this.state.amending) throw new Error("No code is awaiting human acceptance.");
		await this.runExclusive(ctx, async (signal) => {
			const record = latestRevision(todo);
			const tree = await requireWorktreeSnapshot(ctx.cwd);
			signal.throwIfAborted();
			if (!record?.resultTree || tree !== record.resultTree) {
				if (record) record.review = undefined;
				todo.checkpoint = { role: "code-reviewer", revisionIndex: todo.revisions.length - 1 };
				todo.status = "interrupted";
				this.changed(ctx);
				throw new Error("Files changed after code review. Use /workflow execute to review again.");
			}
		});
	}

	private failed(ctx: ExtensionContext, todo: WorkflowTodo, signal: AbortSignal, error: unknown): void {
		todo.status = signal.aborted ? "interrupted" : "failed";
		todo.error = signal.aborted ? "Execution was interrupted. Use /workflow execute or /workflow resume to continue." : error instanceof Error ? error.message : String(error);
		this.state.executing = false;
		this.changed(ctx);
		if (!signal.aborted) ctx.ui.notify(`Workflow todo ${todo.step} failed: ${todo.error}`, "error");
	}

	async execute(ctx: ExtensionContext): Promise<void> {
		if (this.running || this.stopping) throw new Error("A workflow subagent is already running or stopping.");
		if (this.state.paused) throw new Error("Workflow is paused. Run /workflow resume first.");
		if (this.state.amending) throw new Error("Accept or reject the plan amendment first.");
		const todo = currentTodo(this.state) ?? nextPendingTodo(this.state);
		if (!todo) {
			ctx.ui.notify(isWorkflowComplete(this.state) ? "Workflow is complete." : "There are no workflow todos to execute.", "info");
			return;
		}
		if (todo.status === "pending") return await this.enterDesign(ctx);
		if (todo.checkpoint?.role === "design-reviewer") return await this.reviewDesign(ctx);
		if (["design-editing", "awaiting-design", "awaiting-change"].includes(todo.status)) {
			const guidance = todo.status === "awaiting-change"
				? "Use /workflow feedback <text> to clarify implementation, /workflow design to revise the contract, or /workflow replan to change scope."
				: "Use /workflow design-review, design-approve, design, or replan.";
			ctx.ui.notify(`${todoSummary(todo)}\n\n${guidance}`, "info");
			return;
		}
		if (todo.designAccepted === undefined) throw new Error("Accept the design before implementation.");
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

	async prepareFrom(ctx: ExtensionContext, targetStep: number): Promise<void> {
		const selected = currentTodo(this.state) ?? nextPendingTodo(this.state);
		const target = this.state.todos.find((todo) => todo.step === targetStep);
		if (!selected) throw new Error("There is no current workflow todo to bypass.");
		if (!target) throw new Error(`Todo ${targetStep} does not exist.`);
		if (target.step <= selected.step) throw new Error(`Todo ${targetStep} is not later than the current todo ${selected.step}.`);
		if (target.status !== "pending") throw new Error(`Todo ${targetStep} is ${target.status}, not pending.`);
		if (target.skillRequest) throw new Error(`Todo ${target.step} requests unknown Agent Skill "${target.skillRequest}".`);
		await requireWorktreeSnapshot(ctx.cwd);
		await this.hooks.models(ctx, ctx.signal);
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
	}

	async reviseFromHuman(ctx: ExtensionContext, todo: WorkflowTodo, feedback: string): Promise<void> {
		if (todo.designAccepted === undefined || this.state.amending) throw new Error("Code feedback requires an accepted design and plan.");
		await this.runExclusive(ctx, async (signal, models, store, lease) => {
			todo.revisions.push({ humanFeedback: feedback, changedFiles: [], planRevision: this.state.planRevision, designIndex: todo.designAccepted });
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
		const resultTree = await requireWorktreeSnapshot(ctx.cwd);
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

	private async runTodo(ctx: ExtensionContext, todo: WorkflowTodo, models: CompleteWorkflowConfig, store: WorkflowSessionStore, lease: WorkflowLease, signal: AbortSignal): Promise<void> {
		try {
			while (true) {
				signal.throwIfAborted();
				const interrupted = todo.checkpoint !== undefined;
				let record = todo.checkpoint ? todo.revisions[todo.checkpoint.revisionIndex] : undefined;
				if (!record) {
					const pending = latestRevision(todo);
					record = pending?.humanFeedback && !pending.implementation && !pending.baselineTree && !pending.resultTree ? pending : { changedFiles: [], planRevision: this.state.planRevision, designIndex: todo.designAccepted };
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
					record.baselineTree ??= await requireWorktreeSnapshot(ctx.cwd);
					const prepared = store.prepare(this.state, todo, "implementer");
					this.changed(ctx);
					signal.throwIfAborted();
					try {
						const { systemPrompt, ...invocation } = implementerInvocation(this.state, todo, content, { continuing: prepared.hasHistory, interrupted });
						const run = await store.run(this.state, prepared.handle, models.implementer, {
							...invocation, instructions: systemPrompt, signal, onProcess: lease.setChildPid,
						}, this.hooks.runAgent);
						signal.throwIfAborted();
						record.implementation = { ...validateImplementation(extractProtocolJson<ImplementationResult>(run.output, "workflow-implementation")), model: models.implementer.model, thinkingLevel: models.implementer.thinkingLevel ?? "off" };
						todo.checkpoint!.role = "code-reviewer";
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
					record.review = { verdict: "escalate", summary: "The implementer reported that the task is blocked.", findings: [record.implementation.blocker?.reason ?? record.implementation.notes ?? "No blocker details supplied."], blocker: record.implementation.blocker };
				} else if (!record.review) {
					todo.status = "reviewing";
					todo.checkpoint!.role = "code-reviewer";
					const prepared = store.prepare(this.state, todo, "code-reviewer");
					this.changed(ctx);
					const { systemPrompt, ...invocation } = codeReviewerInvocation(this.state, todo, content, { continuing: prepared.hasHistory, interrupted });
					const run = await store.run(this.state, prepared.handle, models["code-reviewer"], {
						...invocation, instructions: systemPrompt, signal, onProcess: lease.setChildPid,
					}, this.hooks.runAgent);
					signal.throwIfAborted();
					record.review = { ...validateReview(extractProtocolJson<ReviewResult>(run.output, "workflow-review")), model: models["code-reviewer"].model, thinkingLevel: models["code-reviewer"].thinkingLevel ?? "off" };
					this.changed(ctx);
				}
				if (shouldAutomaticallyRevise(todo, models["max-review-cycles"])) {
					// The completed checkpoint remains durable until the next revision is allocated.
					todo.checkpoint = undefined;
					continue;
				}
				todo.checkpoint = undefined;
				todo.status = record.implementation?.blocker || record.review?.blocker ? "awaiting-change" : "awaiting-user";
				this.state.executing = false;
				this.changed(ctx);
				const approved = record.review?.verdict === "approve";
				ctx.ui.notify(`${approved ? "Reviewer approved; your approval is required." : "Workflow escalated for your decision."}\n\n${todoSummary(todo)}\n\nUse ${todo.status === "awaiting-change" ? "/workflow feedback <text> to clarify implementation, /workflow design to revise the contract, or /workflow replan to change scope" : "/workflow review"}.`, approved ? "info" : "warning");
				return;
			}
		} catch (error) {
			this.failed(ctx, todo, signal, error);
		}
	}
}
