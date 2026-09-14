export type WorkflowSkillSource = "plan" | "user";

export type WorkflowTodoStatus =
	| "pending"
	| "implementing"
	| "reviewing"
	| "revising"
	| "awaiting-user"
	| "approved"
	| "completed-manually"
	| "failed"
	| "aborted";

export interface ImplementationResult {
	status: "completed" | "blocked";
	summary: string;
	filesChanged: string[];
	tests: string[];
	notes?: string;
	model?: string;
	thinkingLevel?: string;
}

export interface ReviewResult {
	verdict: "approve" | "request_changes" | "escalate";
	summary: string;
	findings: string[];
	model?: string;
	thinkingLevel?: string;
}

/**
 * A todo's implementation/review pair and the tree snapshots used to scope its
 * diff. Keeping these records ordered preserves the conversation across rounds.
 */
export interface WorkflowRevision {
	implementation?: ImplementationResult;
	review?: ReviewResult;
	humanFeedback?: string;
	baselineTree?: string;
	resultTree?: string;
	changedFiles: string[];
	diffPreview?: string;
	/** Cached first-baseline-to-this-result values for todo-level handoffs. */
	cumulativeChangedFiles?: string[];
	cumulativeDiffPreview?: string;
	/** Cached previous-human-checkpoint-to-this-result values for human review. */
	humanCheckpointChangedFiles?: string[];
	humanCheckpointDiffPreview?: string;
}

export interface WorkflowTodo {
	step: number;
	title: string;
	instructions: string[];
	primarySkill?: string;
	skillSource?: WorkflowSkillSource;
	/** An explicit plan tag that did not match a discovered skill. */
	skillRequest?: string;
	status: WorkflowTodoStatus;
	attempts: number;
	automaticReviewCycles: number;
	revisions: WorkflowRevision[];
	error?: string;
}

export interface WorkflowState {
	version: 5;
	planning: boolean;
	executing: boolean;
	paused: boolean;
	createdAt: number;
	updatedAt: number;
	goal?: string;
	currentStep?: number;
	todos: WorkflowTodo[];
	toolsBeforePlanning?: string[];
}

export function createWorkflowState(): WorkflowState {
	const now = Date.now();
	return {
		version: 5,
		planning: false,
		executing: false,
		paused: false,
		createdAt: now,
		updatedAt: now,
		todos: [],
	};
}

export function isTodoComplete(todo: WorkflowTodo): boolean {
	return todo.status === "approved" || todo.status === "completed-manually";
}

function isTodoTerminal(todo: WorkflowTodo): boolean {
	return isTodoComplete(todo) || todo.status === "aborted";
}

export function currentTodo(state: WorkflowState): WorkflowTodo | undefined {
	if (state.currentStep != null) {
		const selected = state.todos.find((todo) => todo.step === state.currentStep);
		if (selected && !isTodoTerminal(selected)) return selected;
	}
	return state.todos.find((todo) => !isTodoTerminal(todo));
}

export function nextPendingTodo(state: WorkflowState): WorkflowTodo | undefined {
	return state.todos.find((todo) => todo.status === "pending");
}

export function completeTodosManuallyBefore(state: WorkflowState, targetStep: number): WorkflowTodo[] {
	const completed = state.todos.filter((todo) => todo.step < targetStep && !isTodoTerminal(todo));
	for (const todo of completed) {
		todo.status = "completed-manually";
		todo.error = undefined;
	}
	return completed;
}

export function isWorkflowComplete(state: WorkflowState): boolean {
	return state.todos.length > 0 && state.todos.every(isTodoComplete);
}

export function latestRevision(todo: WorkflowTodo): WorkflowRevision | undefined {
	return todo.revisions[todo.revisions.length - 1];
}

export function latestResultRevision(todo: WorkflowTodo): WorkflowRevision | undefined {
	return [...todo.revisions].reverse().find((revision) => revision.implementation || revision.review || revision.resultTree);
}

/**
 * Return the latest result scoped from the most recent human feedback, or from
 * the todo's first baseline before its initial human checkpoint.
 */
export function humanCheckpointRevision(todo: WorkflowTodo): WorkflowRevision | undefined {
	const latest = latestResultRevision(todo);
	if (!latest) return undefined;
	const latestIndex = todo.revisions.lastIndexOf(latest);
	const revisions = todo.revisions.slice(0, latestIndex + 1);
	const checkpoint = [...revisions].reverse().find((revision) => revision.humanFeedback)
		?? revisions.find((revision) => revision.baselineTree);
	return {
		...latest,
		baselineTree: checkpoint?.baselineTree ?? latest.baselineTree,
		changedFiles: latest.humanCheckpointChangedFiles ?? latest.changedFiles,
		diffPreview: latest.humanCheckpointDiffPreview,
	};
}

/**
 * Return the latest result with the complete history of files and diffs for
 * downstream handoffs. Revision records remain available for round review.
 */
export function cumulativeRevision(todo: WorkflowTodo): WorkflowRevision | undefined {
	const latest = latestResultRevision(todo);
	if (!latest) return undefined;
	const changedFiles = [...new Set(todo.revisions.flatMap((revision) => revision.changedFiles))];
	const previews = todo.revisions.map((revision) => revision.diffPreview).filter((preview): preview is string => Boolean(preview));
	return {
		...latest,
		baselineTree: todo.revisions.find((revision) => revision.baselineTree)?.baselineTree ?? latest.baselineTree,
		changedFiles: latest.cumulativeChangedFiles ?? changedFiles,
		diffPreview: latest.cumulativeDiffPreview ?? (previews.join("\n\n") || latest.diffPreview),
	};
}

export function cloneState(state: WorkflowState): WorkflowState {
	return JSON.parse(JSON.stringify(state)) as WorkflowState;
}

export function restoreState(value: unknown): WorkflowState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Record<string, unknown>;
	if (candidate.version !== 5 || !Array.isArray(candidate.todos)) return undefined;
	const validTodos = candidate.todos.every((todo) => {
		if (!todo || typeof todo !== "object") return false;
		const item = todo as Record<string, unknown>;
		return typeof item.step === "number"
			&& typeof item.title === "string"
			&& Array.isArray(item.instructions)
			&& item.instructions.every((instruction) => typeof instruction === "string")
			&& Array.isArray(item.revisions);
	});
	if (!validTodos) return undefined;
	return { ...createWorkflowState(), ...candidate, version: 5 } as WorkflowState;
}
