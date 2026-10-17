// Lease fencing, stale recovery and process-group ownership.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireLock, assertReclaimable, workerAlive } from "../lock.ts";

function fixture() {
	const root = mkdtempSync(path.join(os.tmpdir(), "subagent-lock-"));
	return { file: path.join(root, "run.lock"), close: () => rmSync(root, { recursive: true, force: true }) };
}
function deadPid(): number { return Number(execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).trim()); }

test("live parents exclude a second writer", () => {
	const f = fixture();
	try { const lease = acquireLock(f.file); assert.throws(() => acquireLock(f.file), /active/); lease.release(); lease.release(); }
	finally { f.close(); }
});

test("both dead processes allow stale lease recovery", () => {
	const f = fixture();
	try {
		const dead = deadPid(); writeFileSync(f.file, JSON.stringify({ token: "old", pid: dead, childPid: dead }));
		const lease = acquireLock(f.file);
		assert.notEqual(JSON.parse(readFileSync(f.file, "utf8")).token, "old"); lease.release();
	} finally { f.close(); }
});

test("child launch fences survive parent failure", () => {
	const f = fixture();
	try { writeFileSync(f.file, JSON.stringify({ token: "old", pid: deadPid(), childPid: 0 })); assert.throws(() => acquireLock(f.file), /child launch/); }
	finally { f.close(); }
});

test("a live child cannot be hidden by clearing its recorded PID", () => {
	const f = fixture();
	try {
		const lease = acquireLock(f.file); lease.setChildPid(process.pid);
		assert.throws(() => lease.setChildPid(undefined), /active subprocess/);
		assert.throws(() => lease.release(), /active subprocess/);
		assert.equal(JSON.parse(readFileSync(f.file, "utf8")).childPid, process.pid);
	} finally { f.close(); }
});

test("surviving process groups exclude recovery after their leader exits", { skip: process.platform === "win32" }, () => {
	const f = fixture();
	let group = 0;
	try {
		group = Number(execFileSync(process.execPath, ["-e", 'const {spawn}=require("node:child_process");spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}).unref();console.log(process.pid);'], { encoding: "utf8", detached: true }).trim());
		const lock = { token: "old", pid: deadPid(), childPid: group };
		assert.equal(workerAlive(lock), true);
		writeFileSync(f.file, JSON.stringify(lock));
		assert.throws(() => assertReclaimable(f.file), /active/);
	} finally { if (group) process.kill(-group, "SIGKILL"); f.close(); }
});

test("corrupt lease records require explicit recovery", () => {
	const f = fixture();
	try { writeFileSync(f.file, '{"token":"bad"}'); assert.throws(() => acquireLock(f.file), /Corrupt/); }
	finally { f.close(); }
});

test("ownership replacement prevents a stale lease from unlinking its successor", () => {
	const f = fixture();
	try {
		const lease = acquireLock(f.file);
		writeFileSync(f.file, JSON.stringify({ token: "successor", pid: process.pid }));
		assert.throws(() => lease.release(), /ownership changed/);
		assert.equal(JSON.parse(readFileSync(f.file, "utf8")).token, "successor");
	} finally { f.close(); }
});
