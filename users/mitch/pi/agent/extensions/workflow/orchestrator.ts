import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompleteWorkflowModelConfig } from "./config.ts";
import type { WorkflowContent } from "./content.ts";
import { implementerInvocation, reviewerInvocation, validateImplementation, validateReview } from "./context.ts";
import { diffTrees, snapshotWorktree } from "./git.ts";
import { extractProtocolJson, runAgent } from "./runner.ts";
import { currentTodo, isWorkflowComplete, latestRevision, nextPendingTodo, type ImplementationResult, type ReviewResult, type WorkflowRevision, type WorkflowState, type WorkflowTodo } from "./state.ts";
import { todoSummary } from "./ui.ts";

export interface OrchestratorHooks {
	persist: () => void;
	updateUi: (ctx: ExtensionContext) => void;
	content: () => WorkflowContent;
	models: (ctx: ExtensionContext) => Promise<CompleteWorkflowModelConfig>;
}

export function shouldAutomaticallyRevise(todo: WorkflowTodo): boolean {
	return latestRevision(todo)?.review?.verdict === "request_changes" && todo.automaticReviewCycles < 2;
}

export class WorkflowOrchestrator {
	private running = false;
	private readonly state: WorkflowState;
	private readonly hooks: OrchestratorHooks;

	constructor(state: WorkflowState, hooks: OrchestratorHooks) {
		this.state = state;
		this.hooks = hooks;
	}

	isRunning(): boolean {
		return this.running;
	}

	private changed(ctx: ExtensionContext): void {
		this.state.updatedAt = Date.now();
		this.hooks.persist();
		this.hooks.updateUi(ctx);
	}

	async execute(ctx: ExtensionContext): Promise<void> {
		if (this.running) throw new Error("A workflow subagent is already running.");
		if (this.state.paused) throw new Error("Workflow is paused. Run /workflow resume first.");
		const todo = currentTodo(this.state) ?? nextPendingTodo(this.state);
		if (!todo) {
			if (isWorkflowComplete(this.state)) ctx.ui.notify("Workflow is complete.", "info");
			else ctx.ui.notify("There are no workflow todos to execute.", "warning");
			return;
		}
		if (todo.status === "awaiting-user") {
			ctx.ui.notify(`${todoSummary(todo)}\n\nUse /workflow review, approve, or feedback.`, "info");
			return;
		}
		if (todo.skillRequest) throw new Error(`Todo ${todo.step} requests unknown Agent Skill "${todo.skillRequest}". Use /workflow skill ${todo.step} <name|none>.`);
		const models = await this.hooks.models(ctx);
		this.state.executing = true;
		this.state.currentStep = todo.step;
		await this.runTodo(ctx, todo, false, models);
	}

	async reviseFromHuman(ctx: ExtensionContext, todo: WorkflowTodo, feedback: string): Promise<void> {
		if (this.running) throw new Error("A workflow subagent is already running.");
		const models = await this.hooks.models(ctx);
		todo.revisions.push({ humanFeedback: feedback, changedFiles: [] });
		todo.automaticReviewCycles = 0;
		todo.status = "revising";
		todo.error = undefined;
		this.state.paused = false;
		this.state.executing = true;
		this.state.currentStep = todo.step;
		this.changed(ctx);
		await this.runTodo(ctx, todo, true, models, latestRevision(todo));
	}

	private async runTodo(
		ctx: ExtensionContext,
		todo: WorkflowTodo,
		revision: boolean,
		models: CompleteWorkflowModelConfig,
		revisionRecord?: WorkflowRevision,
	): Promise<void> {
		this.running = true;
		try {
			// A retry after a failed run must remain a distinct round. Human feedback
			// already owns a record; only an unstarted feedback record may be resumed
			// after a session restart, while automatic and command retries create one.
			const pending = latestRevision(todo);
			const resumableFeedback = pending !== undefined && Boolean(pending.humanFeedback) && !pending.implementation && !pending.review && !pending.baselineTree && !pending.resultTree && !pending.diffPreview;
			const record: WorkflowRevision = revisionRecord ?? (resumableFeedback ? pending! : { changedFiles: [] });
			if (record !== pending) todo.revisions.push(record);
			todo.status = revision ? "revising" : "implementing";
			todo.attempts++;
			todo.automaticReviewCycles++;
			todo.error = undefined;
			this.changed(ctx);

			const content = this.hooks.content();
			const invocation = implementerInvocation(this.state, todo, content);
			// Each round is measured from the worktree as it exists immediately before
			// the implementer runs, so review focuses on only that round's changes.
			record.baselineTree = await snapshotWorktree(ctx.cwd);
			// Keep snapshotting in a finally block: an implementer can modify the
			// worktree before its process fails or its structured response is rejected.
			// Those edits are still an attempted revision and must not become the next
			// round's invisible baseline.
			try {
				const run = await runAgent({
					cwd: ctx.cwd,
					roleName: "workflow-implementer",
					...invocation,
					tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
					model: models.implementer.model,
					thinkingLevel: models.implementer.thinkingLevel,
					signal: ctx.signal,
				});
				record.implementation = {
					...validateImplementation(extractProtocolJson<ImplementationResult>(run.output, "workflow-implementation")),
					model: models.implementer.model,
					...(models.implementer.thinkingLevel ? { thinkingLevel: models.implementer.thinkingLevel } : {}),
				};
			} finally {
				record.resultTree = await snapshotWorktree(ctx.cwd);
				const diff = await diffTrees(ctx.cwd, record.baselineTree, record.resultTree);
				record.changedFiles = diff.changedFiles.length ? diff.changedFiles : record.implementation?.filesChanged ?? [];
				record.diffPreview = diff.preview;

				// Keep the per-revision diff above for round-by-round review, while also
				// caching a todo-wide view for later approval and downstream handoffs.
				const firstBaseline = todo.revisions.find((revision) => revision.baselineTree)?.baselineTree;
				if (firstBaseline && record.resultTree) {
					const cumulative = await diffTrees(ctx.cwd, firstBaseline, record.resultTree);
					record.cumulativeChangedFiles = cumulative.changedFiles;
					record.cumulativeDiffPreview = cumulative.preview;
				} else {
					record.cumulativeChangedFiles = [...new Set(todo.revisions.flatMap((revision) => revision.changedFiles))];
					record.cumulativeDiffPreview = todo.revisions
						.map((revision) => revision.diffPreview)
						.filter((preview): preview is string => Boolean(preview))
						.join("\n\n");
				}
				this.changed(ctx);
			}

			if (record.implementation?.status === "blocked") {
				record.review = { verdict: "escalate", summary: "The implementer reported that the task is blocked.", findings: [record.implementation.notes ?? "No blocker details supplied."] };
				todo.status = "awaiting-user";
				this.state.executing = false;
				this.changed(ctx);
				ctx.ui.notify(`${todoSummary(todo)}\n\nUse /workflow feedback or /workflow abort.`, "warning");
				return;
			}

			todo.status = "reviewing";
			this.changed(ctx);
			const reviewInvocation = reviewerInvocation(this.state, todo, content);
			const reviewRun = await runAgent({
				cwd: ctx.cwd,
				roleName: "workflow-reviewer",
				...reviewInvocation,
				tools: ["read", "grep", "find", "ls"],
				model: models.reviewer.model,
				thinkingLevel: models.reviewer.thinkingLevel,
				signal: ctx.signal,
			});
			record.review = {
				...validateReview(extractProtocolJson<ReviewResult>(reviewRun.output, "workflow-review")),
				model: models.reviewer.model,
				...(models.reviewer.thinkingLevel ? { thinkingLevel: models.reviewer.thinkingLevel } : {}),
			};
			this.changed(ctx);

			if (shouldAutomaticallyRevise(todo)) {
				todo.status = "revising";
				this.changed(ctx);
				this.running = false;
				await this.runTodo(ctx, todo, true, models);
				return;
			}

			todo.status = "awaiting-user";
			this.state.executing = false;
			this.changed(ctx);
			const kind = record.review!.verdict === "approve" ? "Reviewer approved; your approval is required." : "Workflow escalated for your decision.";
			ctx.ui.notify(`${kind}\n\n${todoSummary(todo)}\n\nUse /workflow review.`, record.review!.verdict === "approve" ? "info" : "warning");
		} catch (error) {
			todo.status = "failed";
			todo.error = error instanceof Error ? error.message : String(error);
			this.state.executing = false;
			this.changed(ctx);
			ctx.ui.notify(`Workflow todo ${todo.step} failed: ${todo.error}`, "error");
		} finally {
			this.running = false;
		}
	}
}
