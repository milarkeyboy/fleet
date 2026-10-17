import type { AgentDefinition } from "./agents.ts";
import type { AgentRunResult, runAgent } from "./runner.ts";
import type { ConversationInfo, ConversationSnapshot } from "./viewer-types.ts";

export interface ConversationOwner { parentSessionId: string; creator: string; cwd: string }
export interface ConversationInvocation {
	task: string;
	instructions?: string;
	skillPaths?: string[];
	signal?: AbortSignal;
	onUpdate?: (text: string) => void;
	onProcess?: (pid: number | undefined) => void;
}
export interface ConversationLease { setChildPid(pid: number | undefined): void; release(): void }
export interface ConversationService {
	create(owner: ConversationOwner, label: string): string;
	get(owner: ConversationOwner, handle: string): ConversationInfo;
	hasHistory(owner: ConversationOwner, handle: string): boolean;
	list(owner: ConversationOwner): ConversationInfo[];
	listParent(parentSessionId: string): ConversationInfo[];
	inspect(parentSessionId: string, handle: string): ConversationSnapshot;
	subscribe(parentSessionId: string, listener: () => void): () => void;
	acquire(owner: ConversationOwner): ConversationLease;
	run(owner: ConversationOwner, handle: string, agent: AgentDefinition, invocation: ConversationInvocation, run?: typeof runAgent): Promise<AgentRunResult>;
	delete(owner: ConversationOwner, handle: string): boolean;
	deleteOwned(owner: ConversationOwner): void;
	stop(parentSessionId: string): Promise<void>;
}
export { getConversationService } from "./service.ts";
