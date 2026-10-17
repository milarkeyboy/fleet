// Read-only conversation data shared by the service and TUI; handles reveal no storage paths.
export type ConversationStatus = "idle" | "running" | "failed" | "interrupted";

export interface ConversationInfo {
	handle: string;
	parentSessionId: string;
	creator: string;
	cwd: string;
	label: string;
	status: ConversationStatus;
	agent?: string;
	model?: string;
	thinkingLevel?: string;
	createdAt: number;
	updatedAt: number;
	error?: string;
}

export interface TranscriptMessage {
	key: string;
	message: Record<string, any>;
	pending?: boolean;
}

export interface ConversationSnapshot {
	info: ConversationInfo;
	messages: TranscriptMessage[];
	instructions?: string;
	diagnostics: string;
}

export interface TranscriptSource {
	list(): ConversationInfo[];
	inspect(handle: string): ConversationSnapshot;
	subscribe(listener: () => void): () => void;
}
