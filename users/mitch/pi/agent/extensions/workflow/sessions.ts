import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRole, WorkflowRoleSession, WorkflowState, WorkflowTodo } from "./state.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export interface WorkflowLease {
	setChildPid: (pid: number | undefined) => void;
	release: () => void;
}

function readJson(file: string): any {
	return JSON.parse(readFileSync(file, "utf8"));
}

function regularFile(file: string): void {
	if (!lstatSync(file).isFile()) throw new Error(`Workflow session path must be a regular file: ${file}`);
}

function directory(dir: string): void {
	if (!lstatSync(dir).isDirectory()) throw new Error(`Workflow session path must be a directory: ${dir}`);
}

function alive(pid: unknown, group = false): boolean {
	if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
	try { process.kill(group ? -Number(pid) : Number(pid), 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Managed paths and a workflow-wide lease keep role histories isolated and single-writer. */
export class WorkflowSessionStore {
	readonly root: string;
	readonly ownerSessionId: string;
	readonly cwd: string;

	constructor(root: string, ownerSessionId: string, cwd: string) {
		this.root = path.resolve(root);
		this.ownerSessionId = ownerSessionId;
		this.cwd = path.resolve(cwd);
	}

	private location(state: WorkflowState): string {
		if (!UUID.test(state.id) || state.ownerSessionId !== this.ownerSessionId) {
			throw new Error("Workflow session ownership changed. Submit a new plan.");
		}
		return path.join(this.root, state.id);
	}

	hasDirectory(state: WorkflowState): boolean { return existsSync(this.location(state)); }

	private ownedDirectory(state: WorkflowState, create = false, cleanup = false): string {
		const dir = this.location(state);
		if (create) mkdirSync(this.root, { recursive: true, mode: 0o700 });
		directory(this.root);
		const owner = { workflowId: state.id, parentSessionId: this.ownerSessionId, cwd: this.cwd };
		if (create && !existsSync(dir)) {
			if (!cleanup && state.todos.some((todo) => Object.keys(todo.sessions ?? {}).length)) {
				throw new Error("Saved workflow sessions are missing. Submit a new plan.");
			}
			mkdirSync(dir, { mode: 0o700 });
			writeFileSync(path.join(dir, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
		}
		directory(dir);
		const marker = path.join(dir, "owner.json");
		regularFile(marker);
		const saved = readJson(marker);
		if (saved.workflowId !== owner.workflowId || saved.parentSessionId !== owner.parentSessionId || saved.cwd !== owner.cwd) {
			throw new Error("Workflow session directory belongs to another workflow. Submit a new plan.");
		}
		return dir;
	}

	acquire(state: WorkflowState, cleanup = false): WorkflowLease {
		const dir = this.ownedDirectory(state, true, cleanup);
		const file = path.join(dir, "run.lock");
		const lock = { token: randomUUID(), pid: process.pid, childPid: undefined as number | undefined };
		// Serialise stale-lock reclamation so two resumed parents cannot unlink each other's lease.
		const guard = path.join(dir, "lock-guard");
		try { mkdirSync(guard, { mode: 0o700 }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Workflow lock recovery is already in progress. Inspect ${guard} if its owner has exited.`);
			throw error;
		}
		try {
			if (existsSync(file)) {
				regularFile(file);
				const previous = readJson(file);
				if (alive(previous.pid) || alive(previous.childPid) || (process.platform !== "win32" && alive(previous.childPid, true))) {
					throw new Error("A workflow process still owns these sessions. Wait for it to exit before resuming or clearing.");
				}
				if (previous.childPid === 0) throw new Error(`Workflow stopped during child launch. Check for surviving workers before removing ${file}.`);
				unlinkSync(file);
			}
			writeFileSync(file, JSON.stringify(lock), { flag: "wx", mode: 0o600 });
		} finally { rmdirSync(guard); }
		let released = false;
		return {
			setChildPid(pid) {
				if (released) throw new Error("Workflow session lease has been released.");
				lock.childPid = pid;
				const temporary = `${file}.${lock.token}.tmp`;
				writeFileSync(temporary, JSON.stringify(lock), { mode: 0o600 });
				renameSync(temporary, file);
			},
			release() {
				if (released) return;
				if (readJson(file).token !== lock.token) throw new Error("Workflow session lease ownership changed.");
				unlinkSync(file);
				released = true;
			},
		};
	}

	private sessionPath(state: WorkflowState, todo: WorkflowTodo, role: WorkflowRole, ref: WorkflowRoleSession): string {
		const dir = this.ownedDirectory(state);
		if (!Number.isInteger(todo.step) || todo.step < 1 || !UUID.test(ref.id)) throw new Error("Invalid workflow session reference.");
		const expected = path.join(dir, `todo-${todo.step}-${role}-${ref.id}.jsonl`);
		if (ref.file !== expected) throw new Error("Workflow session reference is outside its owned path.");
		return expected;
	}

	/** Allocate before spawning so even a failed first invocation has a stable session identity. */
	prepare(state: WorkflowState, todo: WorkflowTodo, role: WorkflowRole): { session: WorkflowRoleSession; hasHistory: boolean } {
		const dir = this.ownedDirectory(state);
		let ref = todo.sessions?.[role];
		if (!ref) {
			const id = randomUUID();
			ref = { id, file: path.join(dir, `todo-${todo.step}-${role}-${id}.jsonl`) };
			// Pi's documented session header lets --session open a private file with the correct cwd.
			writeFileSync(ref.file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: this.cwd })}\n`, { flag: "wx", mode: 0o600 });
			(todo.sessions ??= {})[role] = ref;
		}
		const file = this.sessionPath(state, todo, role, ref);
		if (!existsSync(file)) throw new Error(`Saved ${role} session is missing. Submit a new plan.`);
		regularFile(file);
		let entries: any[];
		try { entries = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)); }
		catch { throw new Error(`Saved ${role} session is invalid. Submit a new plan.`); }
		const header = entries[0];
		if (header?.type !== "session" || header.version !== 3 || header.id !== ref.id || header.cwd !== this.cwd) {
			throw new Error(`Saved ${role} session identity is invalid. Submit a new plan.`);
		}
		return { session: ref, hasHistory: entries.some((entry) => entry.type === "message" && entry.message?.role === "user") };
	}

	/** Call while holding the lease; summaries remain in workflow state after transcripts are deleted. */
	deleteTodo(state: WorkflowState, todo: WorkflowTodo): void {
		for (const role of ["implementer", "reviewer"] as const) {
			const ref = todo.sessions?.[role];
			if (!ref) continue;
			const file = this.sessionPath(state, todo, role, ref);
			if (existsSync(file)) { regularFile(file); unlinkSync(file); }
		}
		todo.sessions = undefined;
		todo.checkpoint = undefined;
	}

	/** The owning workflow's directory can also contain allocations interrupted before state persistence. */
	deleteWorkflow(state: WorkflowState): void {
		const dir = this.location(state);
		if (!existsSync(dir)) return;
		this.ownedDirectory(state);
		for (const file of readdirSync(dir)) {
			if (file === "owner.json" || file === "run.lock") continue;
			if (!/^todo-\d+-(implementer|reviewer)-[a-f0-9-]+\.jsonl$/.test(file) && !/^run\.lock\.[a-f0-9-]+\.tmp$/.test(file)) throw new Error(`Unexpected file in workflow session directory: ${file}`);
			regularFile(path.join(dir, file));
		}
		// Keep the marker and lease until the caller has finished persisting the transition.
		for (const file of readdirSync(dir)) if (file.endsWith(".jsonl") || file.endsWith(".tmp")) rmSync(path.join(dir, file));
		for (const todo of state.todos) { todo.sessions = undefined; todo.checkpoint = undefined; }
	}
}
