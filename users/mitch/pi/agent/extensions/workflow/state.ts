import { randomUUID } from "node:crypto";

export const WORKFLOW_ENTRY_TYPE = "workflow-state-v9";
export const LEGACY_WORKFLOW_ENTRY_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((version) => `workflow-state-v${version}`));
export const WORKFLOW_ROLES = ["implementer", "design-reviewer", "code-reviewer"] as const;
export type WorkflowRole = typeof WORKFLOW_ROLES[number];

export type WorkflowSkillSource = "plan" | "user";

export type WorkflowTodoStatus =
	| "pending"
	| "design-editing"
	| "design-reviewing"
	| "awaiting-design"
	| "awaiting-change"
	| "implementing"
	| "reviewing"
	| "revising"
	| "awaiting-user"
	| "approved"
	| "completed-manually"
	| "failed"
	| "interrupted"
	| "aborted";

export interface WorkflowBlocker {
	kind: "design" | "plan";
	reason: string;
}

export interface ImplementationResult {
	status: "completed" | "blocked";
	summary: string;
	filesChanged: string[];
	tests: string[];
	notes?: string;
	blocker?: WorkflowBlocker;
	model?: string;
	thinkingLevel?: string;
}

export interface ReviewResult {
	verdict: "approve" | "request_changes" | "escalate";
	summary: string;
	findings: string[];
	blocker?: WorkflowBlocker;
	model?: string;
	thinkingLevel?: string;
}

/**
 * A todo's implementation/review pair and the tree snapshots used to scope its
 * diff. Keeping these records ordered preserves the conversation across rounds.
 */
export interface WorkflowRevision {
	planRevision?: number;
	designIndex?: number;
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

/** The revision and stage to reconcile before retrying an interrupted invocation. */
export interface WorkflowCheckpoint {
	role: WorkflowRole;
	revisionIndex: number;
}

/** Human edits and read-only reviews remain separate from implementation history. */
export interface WorkflowDesignRevision {
	planRevision: number;
	baselineTree: string;
	resultTree?: string;
	changedFiles: string[];
	diffPreview?: string;
	reviews: Array<{ tree: string; feedback?: string; review: ReviewResult }>;
	pendingFeedback?: string;
	accepted?: boolean;
}

export interface WorkflowPlanTodo {
	id: string;
	title: string;
	instructions: string[];
	primarySkill?: string;
}

export interface WorkflowPlanAmendment {
	baseRevision: number;
	todos: WorkflowPlanTodo[];
	affectedIds: string[];
}

export interface WorkflowTodo {
	id: string;
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
	designs: WorkflowDesignRevision[];
	/** Cleared explicitly when design or scope needs renewed acceptance. */
	designAccepted?: number;
	/** Earlier feedback remains historical after an affected plan amendment. */
	feedbackStart: number;
	sessions?: Partial<Record<WorkflowRole, string>>;
	checkpoint?: WorkflowCheckpoint;
	error?: string;
}

export interface WorkflowState {
	version: 9;
	id: string;
	planRevision: number;
	planHistory: Array<{ revision: number; todos: WorkflowPlanTodo[]; affectedIds: string[] }>;
	amending: boolean;
	pendingAmendment?: WorkflowPlanAmendment;
	ownerSessionId?: string;
	/** Persisted before destructive cleanup so a restart cannot resume discarded work. */
	discarding?: boolean;
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
		version: 9,
		id: randomUUID(),
		planRevision: 1,
		planHistory: [],
		amending: false,
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
	const revisions = todo.revisions.slice(0, latestIndex + 1).filter((revision) => revision.designIndex === latest.designIndex);
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
	const candidate = value as WorkflowState;
	const uuid = (id: unknown) => typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
	if (candidate.version !== 9 || !uuid(candidate.id) || !Array.isArray(candidate.todos)) return undefined;
	if (!Number.isSafeInteger(candidate.planRevision) || candidate.planRevision < 1 || !Array.isArray(candidate.planHistory) || typeof candidate.amending !== "boolean") return undefined;
	if (candidate.ownerSessionId !== undefined && typeof candidate.ownerSessionId !== "string") return undefined;
	const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
	const planTodos = (value: unknown): value is WorkflowPlanTodo[] => Array.isArray(value) && value.every((item) => item && uuid(item.id) && typeof item.title === "string" && strings(item.instructions));
	if (candidate.planHistory.some((entry) => !entry || !Number.isInteger(entry.revision) || !planTodos(entry.todos) || !strings(entry.affectedIds))) return undefined;
	const validTodos = candidate.todos.every((item, index) => {
		if (!item || !uuid(item.id) || item.step !== index + 1 || typeof item.title !== "string"
			|| !Array.isArray(item.instructions) || !item.instructions.every((instruction) => typeof instruction === "string")
			|| !Array.isArray(item.revisions) || !Array.isArray(item.designs) || !Number.isInteger(item.feedbackStart)
			|| item.feedbackStart < 0 || item.feedbackStart > item.revisions.length) return false;
		if (item.revisions.some((revision) => !revision || !strings(revision.changedFiles))) return false;
		if (item.designs.some((design) => !design || !Number.isInteger(design.planRevision) || typeof design.baselineTree !== "string"
			|| !Array.isArray(design.reviews) || !strings(design.changedFiles)
			|| design.reviews.some((entry) => !entry || typeof entry.tree !== "string" || !entry.review || !strings(entry.review.findings)))) return false;
		if (item.designAccepted !== undefined && (!Number.isInteger(item.designAccepted) || !item.designs[item.designAccepted]?.accepted)) return false;
		if (item.sessions !== undefined) {
			if (!item.sessions || typeof item.sessions !== "object" || Array.isArray(item.sessions)) return false;
			for (const [role, session] of Object.entries(item.sessions)) {
				if (!WORKFLOW_ROLES.includes(role as WorkflowRole) || !uuid(session)) return false;
			}
		}
		if (item.checkpoint !== undefined) {
			const checkpoint = item.checkpoint;
			const records = checkpoint?.role === "design-reviewer" ? item.designs : item.revisions;
			if (!checkpoint || !WORKFLOW_ROLES.includes(checkpoint.role) || !Number.isInteger(checkpoint.revisionIndex)
				|| checkpoint.revisionIndex < 0 || checkpoint.revisionIndex >= records.length) return false;
		}
		return true;
	});
	if (!validTodos || new Set(candidate.todos.map((todo) => todo.id)).size !== candidate.todos.length) return undefined;
	if (candidate.pendingAmendment !== undefined && (!candidate.pendingAmendment || !candidate.amending || !planTodos(candidate.pendingAmendment.todos)
		|| !strings(candidate.pendingAmendment.affectedIds) || !candidate.pendingAmendment.todos.length || candidate.pendingAmendment.todos.length > 40
		|| candidate.pendingAmendment.baseRevision !== candidate.planRevision)) return undefined;
	return cloneState(candidate);
}

interface WorkflowSessionEntry {
	id: string;
	type: string;
	customType?: string;
	data?: unknown;
}

/** Role transcripts are linear: historical parent branches must start a new workflow. */
export function restoreWorkflowBranch(entries: WorkflowSessionEntry[], branch: WorkflowSessionEntry[], ownerSessionId: string): { state: WorkflowState; replanReason?: string } {
	const isWorkflowEntry = (entry: WorkflowSessionEntry) => entry.type === "custom"
		&& (entry.customType === WORKFLOW_ENTRY_TYPE || LEGACY_WORKFLOW_ENTRY_TYPES.has(entry.customType ?? ""));
	const selected = branch.filter(isWorkflowEntry).at(-1);
	const latest = entries.filter(isWorkflowEntry).at(-1);
	const fresh = () => ({ ...createWorkflowState(), ownerSessionId });
	if (!selected) return latest ? { state: fresh(), replanReason: "Workflow history diverged. Submit a new plan; other histories' role sessions are unchanged." } : { state: fresh() };
	if (selected.id !== latest?.id) return { state: fresh(), replanReason: "Workflow history diverged. Submit a new plan; other histories' role sessions are unchanged." };
	if (selected.customType !== WORKFLOW_ENTRY_TYPE) return { state: fresh(), replanReason: "This workflow uses an older state format. Submit a new plan to use design checkpoints and conversation handles. Historical artefacts have been retained." };
	const state = restoreState(selected.data);
	if (!state) return { state: fresh(), replanReason: "Workflow state is invalid. Submit a new plan." };
	if (state.ownerSessionId && state.ownerSessionId !== ownerSessionId) return { state: fresh(), replanReason: "This workflow belongs to another parent session. Submit a new plan; its role sessions are unchanged." };
	state.ownerSessionId = ownerSessionId;
	return { state };
}

/** Restoring a checkpoint never starts a worker implicitly. */
export function markWorkflowInterrupted(state: WorkflowState): void {
	state.executing = false;
	for (const todo of state.todos) {
		if (["implementing", "reviewing", "revising", "design-reviewing"].includes(todo.status)) {
			todo.status = "interrupted";
			todo.error = "Execution was interrupted. Use /workflow execute or /workflow resume to continue.";
		}
	}
}
