import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentDefinition } from "./agents.ts";
import type { ConversationInvocation, ConversationLease, ConversationOwner, ConversationService } from "./api.ts";
import { acquireLock, alive, assertReclaimable, guarded, readLock, workerAlive } from "./lock.ts";
import { AgentRunError, runAgent, type AgentRunResult } from "./runner.ts";
import { atomicJson, directory, readJson, regular, resolveRoot, stat, UUID } from "./storage.ts";
import { LiveTranscript, nativeTranscript, reconcile, unpersisted } from "./transcript.ts";
import type { ConversationInfo, ConversationSnapshot, TranscriptMessage } from "./viewer-types.ts";

interface Metadata { version: 1; info: ConversationInfo; instructions?: string; diagnostics: string }
interface Active { owner: ConversationOwner; controller: AbortController; done: Promise<AgentRunResult>; transcript: LiveTranscript }
interface Hub {
	active: Map<string, Active>;
	groups: Map<string, ConversationLease & { token: string }>;
	listeners: Map<string, Set<() => void>>;
	notifications: Set<string>;
}
const symbol = Symbol.for("fleet.pi.subagent.conversations.v1");
const hubs: Map<string, Hub> = (globalThis as any)[symbol] ??= new Map();

function ownerValue(owner: ConversationOwner): ConversationOwner {
	if (!owner || typeof owner.parentSessionId !== "string" || !owner.parentSessionId || typeof owner.creator !== "string" || !owner.creator || typeof owner.cwd !== "string" || !path.isAbsolute(owner.cwd)) {
		throw new Error("Invalid conversation owner.");
	}
	return { parentSessionId: owner.parentSessionId, creator: owner.creator, cwd: path.resolve(owner.cwd) };
}
function owns(info: ConversationOwner, owner: ConversationOwner): boolean {
	return !!info && info.parentSessionId === owner.parentSessionId && info.creator === owner.creator && info.cwd === owner.cwd;
}
function observe(callback: (() => unknown) | undefined): void {
	try {
		const value = callback?.();
		if (value && typeof (value as PromiseLike<unknown>).then === "function") void Promise.resolve(value).catch(() => {});
	} catch { /* Observer failures are isolated from worker execution. */ }
}
function failure(result: AgentRunResult): boolean {
	return result.exitCode !== 0 || ["error", "aborted", "length"].includes(result.stopReason ?? "") || !result.output.trim();
}

/** The process-global hub survives independent Jiti module loads without starting resources. */
export function getConversationService(root: string): ConversationService {
	root = resolveRoot(root);
	let hub = hubs.get(root);
	if (!hub) { hub = { active: new Map(), groups: new Map(), listeners: new Map(), notifications: new Set() }; hubs.set(root, hub); }
	return new Service(root, hub);
}

class Service implements ConversationService {
	private root: string;
	private hub: Hub;
	constructor(root: string, hub: Hub) { this.root = root; this.hub = hub; }
	private emit(parent: string): void {
		if (this.hub.notifications.has(parent)) return;
		this.hub.notifications.add(parent);
		queueMicrotask(() => {
			this.hub.notifications.delete(parent);
			for (const listener of [...(this.hub.listeners.get(parent) ?? [])]) observe(listener);
		});
	}
	private base(create = false): string {
		directory(this.root, create);
		const dir = path.join(this.root, "conversations");
		directory(dir, create);
		return dir;
	}
	private location(handle: string): string {
		if (typeof handle !== "string" || !UUID.test(handle)) throw new Error("Invalid conversation handle.");
		return path.join(this.root, "conversations", handle);
	}
	private metadata(handle: string, dir = this.location(handle)): Metadata {
		if (!stat(dir)) throw new Error(`Unknown conversation handle: ${handle}`);
		directory(dir);
		const meta = readJson(path.join(dir, "metadata.json"));
		const info = meta?.info;
		if (meta?.version !== 1 || !info || info.handle !== handle || typeof info.label !== "string" ||
			!["idle", "running", "failed", "interrupted"].includes(info.status) || !Number.isFinite(info.createdAt) || !Number.isFinite(info.updatedAt) || typeof meta.diagnostics !== "string" ||
			(meta.instructions !== undefined && typeof meta.instructions !== "string") || [info.agent, info.model, info.thinkingLevel, info.error].some((value) => value !== undefined && typeof value !== "string")) {
			throw new Error("Corrupt conversation metadata.");
		}
		const owner = ownerValue(info);
		if (owner.cwd !== info.cwd) throw new Error("Corrupt conversation working directory.");
		return meta;
	}
	private owned(owner: ConversationOwner, handle: string, dir = this.location(handle)): Metadata {
		const meta = this.metadata(handle, dir);
		if (!owns(meta.info, ownerValue(owner))) throw new Error("Conversation belongs to another owner or working directory.");
		return meta;
	}
	private info(meta: Metadata): ConversationInfo {
		const info = { ...meta.info };
		if (this.hub.active.has(info.handle)) info.status = "running";
		else if (info.status === "running") {
			const lock = readLock(path.join(this.location(info.handle), "run.lock"));
			if (!lock || !alive(lock.pid)) { info.status = "interrupted"; info.error = "The conversation worker's parent exited before completion."; }
		}
		return info;
	}
	private native(handle: string, cwd: string): TranscriptMessage[] {
		return nativeTranscript(path.join(this.location(handle), "session.jsonl"), handle, cwd, this.hub.active.has(handle));
	}
	private recovery(handle: string): TranscriptMessage[] {
		const file = path.join(this.location(handle), "recovery.json");
		if (!stat(file)) return [];
		const value = readJson(file);
		if (!Array.isArray(value) || value.some((item) => typeof item?.key !== "string" || typeof item.message?.role !== "string" ||
			(item.after !== undefined && item.after !== null && typeof item.after !== "string") || (item.pending !== undefined && typeof item.pending !== "boolean"))) throw new Error("Corrupt conversation recovery data.");
		return value;
	}
	private save(meta: Metadata): void { atomicJson(path.join(this.location(meta.info.handle), "metadata.json"), meta); }
	private group(owner: ConversationOwner): string {
		owner = ownerValue(owner);
		directory(this.root, true);
		const groups = path.join(this.root, "groups"); directory(groups, true);
		const id = createHash("sha256").update(JSON.stringify([owner.parentSessionId, owner.creator])).digest("hex");
		const dir = path.join(groups, id);
		if (!stat(dir)) {
			mkdirSync(dir, { mode: 0o700 });
			writeFileSync(path.join(dir, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
		}
		directory(dir);
		if (!owns(readJson(path.join(dir, "owner.json")), owner)) throw new Error("Conversation group belongs to another working directory.");
		return path.join(dir, "run.lock");
	}
	private checkGroup(file: string): void {
		const lock = readLock(file);
		if (lock && this.hub.groups.get(file)?.token === lock.token) {
			if (workerAlive(lock)) throw new Error(`An active subprocess owns the conversation group: ${file}`);
			if (lock.childPid === 0) throw new Error(`Conversation group stopped during child launch; inspect ${file}`);
			return;
		}
		assertReclaimable(file, lock);
	}
	private handles(): string[] {
		if (!stat(this.root)) return [];
		directory(this.root);
		const base = path.join(this.root, "conversations");
		if (!stat(base)) return [];
		directory(base);
		return readdirSync(base).map((handle) => {
			if (!UUID.test(handle)) throw new Error(`Unexpected conversation directory: ${handle}`);
			return handle;
		});
	}
	private records(): Metadata[] {
		return this.handles().flatMap((handle) => {
			try { return [this.metadata(handle)]; }
			catch (error) { if (!stat(this.location(handle))) return []; throw error; }
		});
	}
	create(owner: ConversationOwner, label: string): string {
		owner = ownerValue(owner);
		if (typeof label !== "string" || !label.trim()) throw new Error("Conversation label must be non-empty.");
		const group = this.group(owner);
		const handle = guarded(`${group}.coordination`, () => {
			this.checkGroup(group);
			const handle = randomUUID();
			const destination = path.join(this.base(true), handle);
			const staging = path.join(this.root, "staging"); directory(staging, true);
			const dir = path.join(staging, handle); mkdirSync(dir, { mode: 0o700 });
			const now = Date.now();
			// Publish only complete conversations; interrupted allocations remain outside discovery.
			try {
				writeFileSync(path.join(dir, "session.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: handle, cwd: owner.cwd, timestamp: new Date(now).toISOString() })}\n`, { flag: "wx", mode: 0o600 });
				atomicJson(path.join(dir, "metadata.json"), { version: 1, info: { ...owner, handle, label, status: "idle", createdAt: now, updatedAt: now }, diagnostics: "" });
				if (stat(destination)) throw new Error("Conversation handle collision.");
				renameSync(dir, destination);
			} catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
			return handle;
		});
		this.emit(owner.parentSessionId);
		return handle;
	}
	get(owner: ConversationOwner, handle: string): ConversationInfo {
		const meta = this.owned(owner, handle); this.native(handle, meta.info.cwd); return this.info(meta);
	}
	hasHistory(owner: ConversationOwner, handle: string): boolean {
		const meta = this.owned(owner, handle);
		return this.native(handle, meta.info.cwd).some((item) => item.message.role === "user");
	}
	list(owner: ConversationOwner): ConversationInfo[] {
		owner = ownerValue(owner);
		return this.records().filter((meta) => owns(meta.info, owner)).map((meta) => this.info(meta));
	}
	listParent(parent: string): ConversationInfo[] {
		return this.records().filter((meta) => meta.info.parentSessionId === parent).map((meta) => this.info(meta));
	}
	inspect(parent: string, handle: string): ConversationSnapshot {
		const meta = this.metadata(handle);
		if (meta.info.parentSessionId !== parent) throw new Error("Conversation belongs to another parent session.");
		const messages = reconcile(this.native(handle, meta.info.cwd), this.hub.active.get(handle)?.transcript.messages ?? this.recovery(handle));
		return structuredClone({ info: this.info(meta), messages, instructions: meta.instructions, diagnostics: meta.diagnostics });
	}
	subscribe(parent: string, listener: () => void): () => void {
		let listeners = this.hub.listeners.get(parent);
		if (!listeners) { listeners = new Set(); this.hub.listeners.set(parent, listeners); }
		listeners.add(listener);
		return () => { listeners.delete(listener); if (!listeners.size) this.hub.listeners.delete(parent); };
	}
	acquire(owner: ConversationOwner): ConversationLease {
		owner = ownerValue(owner);
		const group = this.group(owner);
		return guarded(`${group}.coordination`, () => {
			for (const meta of this.records()) {
				if (owns(meta.info, owner)) assertReclaimable(path.join(this.location(meta.info.handle), "run.lock"));
			}
			const lease = acquireLock(group); this.hub.groups.set(group, lease);
			return {
				setChildPid: (pid) => lease.setChildPid(pid),
				release: () => {
					if ([...this.hub.active.values()].some((active) => owns(active.owner, owner))) throw new Error("The conversation group still has an active invocation.");
					lease.release(); if (this.hub.groups.get(group) === lease) this.hub.groups.delete(group);
				},
			};
		});
	}
	run(owner: ConversationOwner, handle: string, agent: AgentDefinition, invocation: ConversationInvocation, run: typeof runAgent = runAgent): Promise<AgentRunResult> {
		owner = ownerValue(owner);
		const meta = this.owned(owner, handle);
		const native = this.native(handle, owner.cwd);
		const transcript = new LiveTranscript(unpersisted(native, this.recovery(handle)), native.at(-1)?.key ?? null);
		const group = this.group(owner);
		const lease = guarded(`${group}.coordination`, () => {
			this.checkGroup(group);
			if (this.hub.groups.has(group) && [...this.hub.active.values()].some((active) => owns(active.owner, owner))) throw new Error("A conversation in the leased group is already active.");
			return acquireLock(path.join(this.location(handle), "run.lock"));
		});
		const controller = new AbortController();
		const abort = () => controller.abort(invocation.signal?.reason);
		if (invocation.signal?.aborted) abort(); else invocation.signal?.addEventListener("abort", abort, { once: true });
		meta.info = { ...meta.info, status: "running", agent: agent.name, model: agent.model, thinkingLevel: agent.thinkingLevel ?? "off", updatedAt: Date.now(), error: undefined };
		meta.instructions = [agent.body.trim(), invocation.instructions?.trim()].filter(Boolean).join("\n\n---\n\n");
		const persist = () => { atomicJson(path.join(this.location(handle), "recovery.json"), transcript.messages); this.save(meta); };
		let finished = false;
		let scheduled = false;
		let lastResult: AgentRunResult | undefined;
		// Batch stdout deltas; synchronous snapshots still read the live accumulator.
		const schedule = () => {
			if (scheduled) return;
			scheduled = true;
			queueMicrotask(() => {
				scheduled = false;
				if (!finished) observe(() => { persist(); this.emit(owner.parentSessionId); });
			});
		};
		const done = Promise.resolve().then(async () => {
			try {
				persist(); this.emit(owner.parentSessionId);
				const result = await run({
					cwd: owner.cwd, sessionFile: path.join(this.location(handle), "session.jsonl"), roleName: agent.name,
					task: invocation.task, systemPrompt: meta.instructions!,
					skillPaths: invocation.skillPaths ?? [], tools: agent.tools, model: agent.model, thinkingLevel: agent.thinkingLevel,
					contextFileDiscovery: agent.contextFileDiscovery, signal: controller.signal,
					onUpdate: (text) => observe(() => invocation.onUpdate?.(text)),
					onProcess: (pid) => { lease.setChildPid(pid); this.hub.groups.get(group)?.setChildPid(pid); invocation.onProcess?.(pid); },
					onEvent: (event) => {
						if (["message_start", "message_end", "tool_execution_start"].includes(event.type)) transcript.anchor = this.native(handle, owner.cwd).at(-1)?.key ?? null;
						transcript.observe(event); schedule();
					},
					onStderr: (text) => { meta.diagnostics += text; schedule(); },
				});
				lastResult = result;
				for (const message of result.messages) transcript.observe({ type: "message_end", message });
				if (controller.signal.aborted) throw new AgentRunError("Conversation was cancelled.", { ...result, stopReason: "aborted" });
				if (failure(result)) throw new AgentRunError(result.errorMessage || result.stderr || `Conversation ended with ${result.stopReason ?? result.exitCode}.`, result);
				meta.info.status = "idle";
				return result;
			} catch (error) {
				// Failed runners can still supply billable usage, diagnostics and an unfinished response.
				const result = (error as { result?: AgentRunResult })?.result;
				lastResult = result;
				if (result) {
					for (const message of result.messages) transcript.observe({ type: "message_end", message });
					if (result.stderr && !meta.diagnostics.includes(result.stderr)) meta.diagnostics += result.stderr;
				}
				meta.info.status = controller.signal.aborted ? "interrupted" : "failed";
				meta.info.error = error instanceof Error ? error.message : String(error);
				meta.diagnostics += `${meta.diagnostics.endsWith("\n") || !meta.diagnostics ? "" : "\n"}${meta.info.error}\n`;
				throw error;
			} finally {
				finished = true;
				invocation.signal?.removeEventListener("abort", abort);
				let cleanupError: unknown;
				meta.info.updatedAt = Date.now();
				try { persist(); } catch (error) { cleanupError = error; }
				try { lease.release(); }
				catch (error) {
					cleanupError ??= error;
					meta.info.status = "interrupted"; meta.info.error = String(error); meta.diagnostics += `${String(error)}\n`;
					// A failed release retains its fence, so the diagnostic write remains protected.
					observe(persist);
				}
				this.hub.active.delete(handle); this.emit(owner.parentSessionId);
				if (cleanupError) {
					if (lastResult) throw new AgentRunError(String(cleanupError), lastResult);
					throw cleanupError;
				}
			}
		});
		this.hub.active.set(handle, { owner, controller, done, transcript });
		return done;
	}
	delete(owner: ConversationOwner, handle: string): boolean {
		owner = ownerValue(owner);
		const published = this.location(handle);
		const removing = path.join(this.root, "removing");
		const tombstone = path.join(removing, handle);
		let dir = stat(published) ? published : tombstone;
		if (!stat(dir)) return false;
		directory(dir);
		if (dir === tombstone && !readdirSync(dir).length) { rmdirSync(dir); return true; }
		this.owned(owner, handle, dir);
		const group = this.group(owner);
		guarded(`${group}.coordination`, () => {
			this.checkGroup(group);
			assertReclaimable(path.join(dir, "run.lock"));
			if (this.hub.active.has(handle)) throw new Error("Conversation is active.");
			const files = readdirSync(dir);
			for (const file of files) {
				if (!["metadata.json", "session.jsonl", "recovery.json", "run.lock"].includes(file) && !/^(metadata\.json|recovery\.json|run\.lock)\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(file)) throw new Error(`Unexpected conversation file: ${file}`);
				regular(path.join(dir, file));
			}
			// Unpublish atomically; interrupted removal stays outside conversation discovery.
			if (dir === published) {
				directory(removing, true);
				if (stat(tombstone)) throw new Error("Conversation removal is already in progress.");
				renameSync(dir, tombstone); dir = tombstone;
			}
			// Keep ownership until all other files are gone so interrupted cleanup can be retried.
			for (const file of files) if (file !== "metadata.json") unlinkSync(path.join(dir, file));
			unlinkSync(path.join(dir, "metadata.json")); rmdirSync(dir);
		});
		this.emit(owner.parentSessionId);
		return true;
	}
	deleteOwned(owner: ConversationOwner): void {
		owner = ownerValue(owner);
		for (const meta of this.records()) if (owns(meta.info, owner)) this.delete(owner, meta.info.handle);
		const removing = path.join(this.root, "removing");
		if (stat(removing)) {
			directory(removing);
			for (const handle of readdirSync(removing)) {
				if (!UUID.test(handle)) throw new Error("Unexpected removal directory.");
				const dir = path.join(removing, handle); directory(dir);
				if (readdirSync(dir).length && owns(this.metadata(handle, dir).info, owner)) this.delete(owner, handle);
			}
		}
	}
	async stop(parent: string): Promise<void> {
		const active = [...this.hub.active.values()].filter((active) => active.owner.parentSessionId === parent);
		for (const item of active) item.controller.abort();
		await Promise.allSettled(active.map((item) => item.done));
	}
}
