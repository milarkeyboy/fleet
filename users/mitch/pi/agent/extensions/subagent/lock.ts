import { randomUUID } from "node:crypto";
import { mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import type { ConversationLease } from "./api.ts";
import { atomicJson, readJson, stat } from "./storage.ts";

export interface LockRecord { token: string; pid: number; childPid?: number }
export function alive(pid: unknown, group = false): boolean {
	if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
	try { process.kill(group ? -Number(pid) : Number(pid), 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export function workerAlive(lock: LockRecord): boolean {
	return alive(lock.childPid) || (process.platform !== "win32" && alive(lock.childPid, true));
}
export function readLock(file: string): LockRecord | undefined {
	if (!stat(file)) return undefined;
	const lock = readJson(file);
	if (!lock || typeof lock.token !== "string" || !lock.token || !Number.isInteger(lock.pid) || lock.pid <= 0 ||
		(lock.childPid !== undefined && (!Number.isInteger(lock.childPid) || lock.childPid < 0))) {
		throw new Error(`Corrupt conversation lease; inspect ${file}`);
	}
	return lock;
}
export function assertReclaimable(file: string, lock = readLock(file)): void {
	if (!lock) return;
	if (alive(lock.pid) || workerAlive(lock)) throw new Error(`An active process owns the conversation lease: ${file}`);
	if (lock.childPid === 0) throw new Error(`Conversation stopped during child launch; inspect surviving workers before removing ${file}`);
}

// The short guard serialises recovery as well as acquisition, including across processes.
export function guarded<T>(file: string, operation: () => T): T {
	const guard = `${file}.guard`;
	try { mkdirSync(guard, { mode: 0o700 }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Conversation lease recovery is in progress; inspect ${guard} if its owner exited.`);
		throw error;
	}
	try { return operation(); } finally { rmdirSync(guard); }
}

export function acquireLock(file: string): ConversationLease & { token: string } {
	return guarded(file, () => {
		const previous = readLock(file);
		assertReclaimable(file, previous);
		if (previous) unlinkSync(file);
		const lock: LockRecord = { token: randomUUID(), pid: process.pid };
		writeFileSync(file, JSON.stringify(lock), { flag: "wx", mode: 0o600 });
		let released = false;
		const owned = () => {
			if (released || readLock(file)?.token !== lock.token) throw new Error("Conversation lease ownership changed or was released.");
		};
		return {
			token: lock.token,
			setChildPid(pid) {
				owned();
				if (pid !== undefined && (!Number.isInteger(pid) || pid < 0)) throw new Error("Invalid child PID.");
				if (pid !== lock.childPid && workerAlive(lock)) throw new Error(`An active subprocess still owns the conversation lease: ${file}`);
				lock.childPid = pid;
				atomicJson(file, lock);
			},
			release() {
				if (released) return;
				owned();
				if (workerAlive(lock)) throw new Error(`An active subprocess owns the conversation lease: ${file}`);
				if (lock.childPid === 0) throw new Error(`Conversation child launch is unresolved; inspect ${file}`);
				unlinkSync(file);
				released = true;
			},
		};
	});
}
