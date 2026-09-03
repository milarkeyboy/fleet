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
	/** Cached first-baseline-to-this-result values for todo-level review. */
	cumulativeChangedFiles?: string[];
	cumulativeDiffPreview?: string;
}

export interface WorkflowTodo {
	step: number;
	text: string;
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
	version: 4;
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
		version: 4,
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

function migrateRevision(value: unknown): WorkflowRevision | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Record<string, unknown>;
	const revision = { ...candidate } as unknown as WorkflowRevision;
	if (!Array.isArray(revision.changedFiles)) revision.changedFiles = [];
	return revision;
}

function migrateTodo(value: unknown, legacy: boolean): WorkflowTodo | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.step !== "number" || typeof candidate.text !== "string" || typeof candidate.status !== "string") return undefined;

	const {
		language: _language,
		languageSource: _languageSource,
		implementation,
		review,
		humanFeedback,
		baselineTree,
		resultTree,
		changedFiles,
		diffPreview,
		revisions: persistedRevisions,
		...rest
	} = candidate;
	const todo = { ...rest, revisions: [] } as unknown as WorkflowTodo;
	if (typeof todo.attempts !== "number") todo.attempts = 0;
	if (typeof todo.automaticReviewCycles !== "number") todo.automaticReviewCycles = 0;

	if (Array.isArray(persistedRevisions)) {
		todo.revisions = persistedRevisions.map(migrateRevision).filter((revision): revision is WorkflowRevision => Boolean(revision));
	} else if (implementation !== undefined || review !== undefined || humanFeedback !== undefined || baselineTree !== undefined || resultTree !== undefined || diffPreview !== undefined || (Array.isArray(changedFiles) && changedFiles.length > 0)) {
		// Older sessions kept only the latest result on the todo. Preserve it as
		// the first revision so a resumed workflow does not lose its review context.
		const oldResult = implementation !== undefined || review !== undefined || baselineTree !== undefined || resultTree !== undefined || diffPreview !== undefined || (Array.isArray(changedFiles) && changedFiles.length > 0);
		if (oldResult) todo.revisions.push({
			...(implementation ? { implementation } : {}),
			...(review ? { review } : {}),
			...(typeof baselineTree === "string" ? { baselineTree } : {}),
			...(typeof resultTree === "string" ? { resultTree } : {}),
			...(typeof diffPreview === "string" ? { diffPreview } : {}),
			changedFiles: Array.isArray(changedFiles) ? changedFiles : [],
		});
		if (humanFeedback !== undefined) todo.revisions.push({ humanFeedback: String(humanFeedback), changedFiles: [] });
	}

	if (legacy && typeof candidate.language === "string" && candidate.languageSource !== "inferred") {
		todo.primarySkill = candidate.language;
		if (candidate.languageSource === "plan" || candidate.languageSource === "user") todo.skillSource = candidate.languageSource;
	}
	return todo;
}

export function restoreState(value: unknown): WorkflowState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Record<string, unknown>;
	if ((candidate.version !== 1 && candidate.version !== 2 && candidate.version !== 3 && candidate.version !== 4) || !Array.isArray(candidate.todos)) return undefined;
	const todos = candidate.todos.map((todo) => migrateTodo(todo, candidate.version === 1)).filter((todo): todo is WorkflowTodo => Boolean(todo));
	return {
		...createWorkflowState(),
		...candidate,
		version: 4,
		todos,
	} as WorkflowState;
}
