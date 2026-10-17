import type { AgentDefinition } from "../subagent/agents.ts";
import { getConversationService, type ConversationInvocation, type ConversationLease, type ConversationOwner } from "../subagent/api.ts";
import type { runAgent } from "../subagent/runner.ts";
import type { WorkflowRole, WorkflowState, WorkflowTodo } from "./state.ts";

export type WorkflowLease = ConversationLease;

/** Keep workflow state limited to handles while the shared service owns conversations. */
export class WorkflowSessionStore {
	readonly root: string;
	readonly ownerSessionId: string;
	readonly cwd: string;

	constructor(root: string, ownerSessionId: string, cwd: string) {
		this.root = root;
		this.ownerSessionId = ownerSessionId;
		this.cwd = cwd;
	}

	private owner(state: WorkflowState): ConversationOwner {
		if (state.ownerSessionId !== this.ownerSessionId) throw new Error("Workflow session ownership changed. Submit a new plan.");
		return { parentSessionId: this.ownerSessionId, creator: `workflow:${state.id}`, cwd: this.cwd };
	}

	acquire(state: WorkflowState): WorkflowLease {
		return getConversationService(this.root).acquire(this.owner(state));
	}

	prepare(state: WorkflowState, todo: WorkflowTodo, role: WorkflowRole): { handle: string; hasHistory: boolean } {
		const service = getConversationService(this.root);
		const owner = this.owner(state);
		const handle = todo.sessions?.[role] ?? service.create(owner, `Todo ${todo.step}: ${role}`);
		(todo.sessions ??= {})[role] = handle;
		return { handle, hasHistory: service.hasHistory(owner, handle) };
	}

	run(state: WorkflowState, handle: string, agent: AgentDefinition, invocation: ConversationInvocation, run?: typeof runAgent) {
		return getConversationService(this.root).run(this.owner(state), handle, agent, invocation, run);
	}

	deleteTodo(state: WorkflowState, todo: WorkflowTodo): void {
		const service = getConversationService(this.root);
		const owner = this.owner(state);
		for (const handle of Object.values(todo.sessions ?? {})) service.delete(owner, handle);
		todo.sessions = undefined;
		todo.checkpoint = undefined;
	}

	/** Include allocations interrupted before their handles reached persisted state. */
	deleteWorkflow(state: WorkflowState): void {
		getConversationService(this.root).deleteOwned(this.owner(state));
		for (const todo of state.todos) { todo.sessions = undefined; todo.checkpoint = undefined; }
	}
}
