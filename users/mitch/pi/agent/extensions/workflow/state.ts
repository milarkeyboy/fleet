export type WorkflowSkillSource = "plan" | "user";

export type WorkflowTodoStatus =
	| "pending"
	| "implementing"
	| "reviewing"
	| "revising"
	| "awaiting-user"
	| "approved"
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
	implementation?: ImplementationResult;
	review?: ReviewResult;
	humanFeedback?: string;
	baselineTree?: string;
	resultTree?: string;
	changedFiles: string[];
	diffPreview?: string;
	error?: string;
}

export interface WorkflowState {
	version: 2;
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
		version: 2,
		planning: false,
		executing: false,
		paused: false,
		createdAt: now,
		updatedAt: now,
		todos: [],
	};
}

export function currentTodo(state: WorkflowState): WorkflowTodo | undefined {
	if (state.currentStep != null) {
		const selected = state.todos.find((todo) => todo.step === state.currentStep);
		if (selected && selected.status !== "approved" && selected.status !== "aborted") return selected;
	}
	return state.todos.find((todo) => todo.status !== "approved" && todo.status !== "aborted");
}

export function nextPendingTodo(state: WorkflowState): WorkflowTodo | undefined {
	return state.todos.find((todo) => todo.status === "pending");
}

export function isWorkflowComplete(state: WorkflowState): boolean {
	return state.todos.length > 0 && state.todos.every((todo) => todo.status === "approved");
}

export function cloneState(state: WorkflowState): WorkflowState {
	return JSON.parse(JSON.stringify(state)) as WorkflowState;
}

function migrateTodo(value: unknown, legacy: boolean): WorkflowTodo | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.step !== "number" || typeof candidate.text !== "string" || typeof candidate.status !== "string") return undefined;

	const { language: _language, languageSource: _languageSource, ...rest } = candidate;
	const todo = rest as unknown as WorkflowTodo;
	if (!Array.isArray(todo.changedFiles)) todo.changedFiles = [];
	if (typeof todo.attempts !== "number") todo.attempts = 0;
	if (typeof todo.automaticReviewCycles !== "number") todo.automaticReviewCycles = 0;

	if (legacy && typeof candidate.language === "string" && candidate.languageSource !== "inferred") {
		todo.primarySkill = candidate.language;
		if (candidate.languageSource === "plan" || candidate.languageSource === "user") todo.skillSource = candidate.languageSource;
	}
	return todo;
}

export function restoreState(value: unknown): WorkflowState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Record<string, unknown>;
	if ((candidate.version !== 1 && candidate.version !== 2) || !Array.isArray(candidate.todos)) return undefined;
	const todos = candidate.todos.map((todo) => migrateTodo(todo, candidate.version === 1)).filter((todo): todo is WorkflowTodo => Boolean(todo));
	return {
		...createWorkflowState(),
		...candidate,
		version: 2,
		todos,
	} as WorkflowState;
}
