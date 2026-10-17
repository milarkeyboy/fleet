import { randomUUID } from "node:crypto";
import type { TranscriptMessage } from "./viewer-types.ts";
import { readText } from "./storage.ts";

export function nativeTranscript(file: string, id: string, cwd: string, writing = false): TranscriptMessage[] {
	let entries: any[];
	try {
		const text = readText(file);
		const lines = text.trimEnd().split("\n");
		entries = lines.flatMap((line, index) => {
			try { return [JSON.parse(line)]; }
			catch (error) {
				if (writing && index === lines.length - 1 && !text.endsWith("\n")) return [];
				throw error;
			}
		});
	}
	catch (error) { throw new Error("Native conversation session is missing, unsafe or corrupt.", { cause: error }); }
	const header = entries[0];
	if (header?.type !== "session" || header.version !== 3 || header.id !== id || header.cwd !== cwd) {
		throw new Error("Native conversation session identity is corrupt.");
	}
	return entries.slice(1).flatMap((entry, index) => {
		if (!entry || typeof entry.type !== "string") throw new Error("Native conversation session entry is corrupt.");
		if (entry.type === "compaction") return [{ key: `native:${entry.id ?? index}`, message: { role: "notice", content: `Context compacted: ${entry.summary ?? ""}` } }];
		if (entry.type !== "message") return [];
		if (!entry.message || typeof entry.message.role !== "string") throw new Error("Native conversation message is corrupt.");
		return [{ key: `native:${entry.id ?? index}`, message: entry.message }];
	});
}

function sameMessage(a: Record<string, any>, b: Record<string, any>): boolean {
	if (a.role !== b.role) return false;
	if (a.role === "toolResult" && a.toolCallId && b.toolCallId) return a.toolCallId === b.toolCallId;
	if (a.timestamp !== undefined && b.timestamp !== undefined) return a.timestamp === b.timestamp;
	return JSON.stringify(a) === JSON.stringify(b);
}

// Persisted messages win over their live equivalents; recovery keeps unfinished responses visible.
type RecoveryMessage = TranscriptMessage & { after?: string | null };
export function unpersisted(native: TranscriptMessage[], recovery: RecoveryMessage[]): RecoveryMessage[] {
	const remaining = [...native];
	return recovery.filter((item) => {
		const index = remaining.findIndex((saved) => sameMessage(saved.message, item.message));
		if (index < 0) return true;
		remaining.splice(index, 1);
		return false;
	});
}
export function reconcile(native: TranscriptMessage[], recovery: RecoveryMessage[]): TranscriptMessage[] {
	const extra = unpersisted(native, recovery);
	const result: TranscriptMessage[] = [];
	const append = (anchor: string | null | undefined) => {
		for (const { after, ...item } of extra) if (after === anchor) result.push(item);
	};
	append(null);
	for (const item of native) { result.push(item); append(item.key); }
	append(undefined);
	for (const { after, ...item } of extra) if (after && !native.some((saved) => saved.key === after)) result.push(item);
	return result;
}

export function updateAssistant(message: Record<string, any>, event: Record<string, any>): void {
	const delta = event.assistantMessageEvent;
	if (!delta || typeof delta.type !== "string") return;
	if (event.usage) message.usage = event.usage;
	if (!Number.isInteger(delta.contentIndex)) return;
	const blocks = message.content ??= [];
	const i = delta.contentIndex;
	if (delta.type.startsWith("text_")) {
		const block = blocks[i] ??= { type: "text", text: "" };
		if (delta.type === "text_delta") block.text += delta.delta;
		if (delta.type === "text_end") block.text = delta.content;
	} else if (delta.type.startsWith("thinking_")) {
		const block = blocks[i] ??= { type: "thinking", thinking: "" };
		if (delta.type === "thinking_delta") block.thinking += delta.delta;
		if (delta.type === "thinking_end") block.thinking = delta.content;
	} else if (delta.type.startsWith("toolcall_")) {
		const block = blocks[i] ??= { type: "toolCall", id: delta.id, name: delta.toolName, arguments: {} };
		if (delta.type === "toolcall_delta") {
			block.argumentsText = (block.argumentsText ?? "") + delta.delta;
			try { block.arguments = JSON.parse(block.argumentsText); } catch { /* Keep incomplete arguments available to the viewer. */ }
		}
		if (delta.type === "toolcall_end") blocks[i] = delta.toolCall;
	}
}

/** Live state contains only the overlay; native session files retain canonical history. */
export class LiveTranscript {
	messages: RecoveryMessage[];
	anchor: string | null;
	private current?: RecoveryMessage;
	constructor(messages: RecoveryMessage[] = [], anchor: string | null = null) { this.messages = structuredClone(messages); this.anchor = anchor; }
	observe(event: Record<string, any>): void {
		if (event.type === "message_start") {
			const existing = event.message?.role === "toolResult" ? this.messages.findLast((item) => sameMessage(item.message, event.message)) : undefined;
			const item = existing ?? { key: `live:${randomUUID()}`, message: structuredClone(event.message), pending: true, after: this.anchor };
			if (!existing) this.messages.push(item);
			this.current = item;
		} else if (event.type === "message_update") {
			if (!this.current || this.current.message.role !== "assistant") {
				this.current = { key: `live:${randomUUID()}`, message: { role: "assistant", content: [], stopReason: "pending" }, pending: true, after: this.anchor };
				this.messages.push(this.current);
			}
			updateAssistant(this.current.message, event);
		} else if (event.type === "message_end" && event.message) {
			const prior = this.current?.message.role === event.message.role && (event.message.role !== "toolResult" || sameMessage(this.current.message, event.message)) ? this.current :
				this.messages.findLast((item) => sameMessage(item.message, event.message));
			if (prior) {
				prior.message = structuredClone(event.message);
				if (event.message.stopReason === "pending") prior.pending = true; else delete prior.pending;
			} else this.messages.push({ key: `live:${randomUUID()}`, message: structuredClone(event.message), after: this.anchor, ...(event.message.stopReason === "pending" ? { pending: true } : {}) });
			this.current = undefined;
		} else if (event.type.startsWith("tool_execution_")) {
			const key = `tool:${event.toolCallId}`;
			let item = this.messages.find((item) => item.key === key);
			if (!item) {
				item = { key, message: { role: "toolResult", toolCallId: event.toolCallId, toolName: event.toolName, content: [] }, pending: true, after: this.anchor };
				this.messages.push(item);
			}
			const result = event.result ?? event.partialResult;
			if (result) Object.assign(item.message, structuredClone(result));
			if (event.args) item.message.arguments = structuredClone(event.args);
			if (event.type === "tool_execution_end") { item.message.isError = event.isError; delete item.pending; }
		}
	}
}
