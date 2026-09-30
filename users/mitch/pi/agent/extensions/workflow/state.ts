import { randomUUID } from "node:crypto";

export const WORKFLOW_ENTRY_TYPE = "workflow-state-v6";
export const LEGACY_WORKFLOW_ENTRY_TYPES = new Set([1, 2, 3, 4, 5].map((version) => `workflow-state-v${version}`));
export type WorkflowRole = "implementer" | "reviewer";

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
	| "interrupted"
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

/** Each role owns a distinct persisted Pi conversation for the lifetime of a todo. */
export interface WorkflowRoleSession {
	id: string;
	file: string;
}

/** The revision and stage to reconcile before retrying an interrupted invocation. */
export interface WorkflowCheckpoint {
	role: WorkflowRole;
	revisionIndex: number;
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
	sessions?: Partial<Record<WorkflowRole, WorkflowRoleSession>>;
	checkpoint?: WorkflowCheckpoint;
	error?: string;
}

export interface WorkflowState {
	version: 6;
	id: string;
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
		version: 6,
		id: randomUUID(),
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
	if (candidate.version !== 6 || typeof candidate.id !== "string" || !/^[a-f0-9-]{36}$/.test(candidate.id) || !Array.isArray(candidate.todos)) return undefined;
	if (candidate.ownerSessionId !== undefined && typeof candidate.ownerSessionId !== "string") return undefined;
	const validTodos = candidate.todos.every((todo) => {
		if (!todo || typeof todo !== "object") return false;
		const item = todo as Record<string, unknown>;
		if (item.sessions !== undefined) {
			if (!item.sessions || typeof item.sessions !== "object" || Array.isArray(item.sessions)) return false;
			for (const [role, session] of Object.entries(item.sessions)) {
				if (!["implementer", "reviewer"].includes(role) || !session || typeof session !== "object") return false;
				const ref = session as Record<string, unknown>;
				if (typeof ref.id !== "string" || typeof ref.file !== "string") return false;
			}
		}
		if (item.checkpoint !== undefined) {
			const checkpoint = item.checkpoint as WorkflowCheckpoint;
			if (!checkpoint || !["implementer", "reviewer"].includes(checkpoint.role)
				|| !Number.isInteger(checkpoint.revisionIndex) || checkpoint.revisionIndex < 0
				|| !Array.isArray(item.revisions) || checkpoint.revisionIndex >= item.revisions.length) return false;
		}
		return Number.isInteger(item.step) && Number(item.step) > 0
			&& typeof item.title === "string"
			&& Array.isArray(item.instructions)
			&& item.instructions.every((instruction) => typeof instruction === "string")
			&& Array.isArray(item.revisions);
	});
	if (!validTodos) return undefined;
	return cloneState({ ...createWorkflowState(), ...candidate, version: 6 } as WorkflowState);
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
	if (selected.customType !== WORKFLOW_ENTRY_TYPE) return { state: fresh(), replanReason: "This workflow uses an older state format. Submit a new plan to create persistent per-todo role sessions." };
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
		if (["implementing", "reviewing", "revising"].includes(todo.status)) {
			todo.status = "interrupted";
			todo.error = "Execution was interrupted. Use /workflow execute or /workflow resume to continue.";
		}
	}
}
