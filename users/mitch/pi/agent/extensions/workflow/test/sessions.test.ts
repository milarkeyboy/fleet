// Managed workflow transcripts, ownership, and single-writer leases.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkflowTodos } from "../planner.ts";
import { WorkflowSessionStore } from "../sessions.ts";
import { createWorkflowState } from "../state.ts";

function fixture() {
	const root = mkdtempSync(path.join(os.tmpdir(), "workflow-sessions-"));
	const state = createWorkflowState();
	state.ownerSessionId = "parent";
	state.todos = createWorkflowTodos([{ title: "First", instructions: ["Implement first."] }, { title: "Second", instructions: ["Implement second."] }]);
	const store = new WorkflowSessionStore(root, "parent", "/workspace");
	return { root, state, store, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("sessions are private, reused by role, and isolated between todos", () => {
	const f = fixture();
	try {
		const lease = f.store.acquire(f.state);
		const first = f.store.prepare(f.state, f.state.todos[0], "implementer");
		assert.equal(first.hasHistory, false);
		appendFileSync(first.session.file, '{"type":"message","message":{"role":"user","content":"First assignment"}}\n');
		assert.deepEqual(f.store.prepare(f.state, f.state.todos[0], "implementer"), { session: first.session, hasHistory: true });
		assert.notEqual(f.store.prepare(f.state, f.state.todos[0], "reviewer").session.file, first.session.file);
		assert.notEqual(f.store.prepare(f.state, f.state.todos[1], "implementer").session.file, first.session.file);
		assert.equal(statSync(first.session.file).mode & 0o777, 0o600);
		lease.release();
	} finally { f.close(); }
});

test("missing established transcripts fail instead of creating fresh conversations", () => {
	const f = fixture();
	try {
		const lease = f.store.acquire(f.state);
		const { session } = f.store.prepare(f.state, f.state.todos[0], "implementer");
		rmSync(session.file);
		assert.throws(() => f.store.prepare(f.state, f.state.todos[0], "implementer"), /session is missing/);
		lease.release();
	} finally { f.close(); }
});

test("invalid transcripts are preserved for explicit recovery", () => {
	const f = fixture();
	try {
		const lease = f.store.acquire(f.state);
		const { session } = f.store.prepare(f.state, f.state.todos[0], "implementer");
		writeFileSync(session.file, "broken");
		assert.throws(() => f.store.prepare(f.state, f.state.todos[0], "implementer"), /session is invalid/);
		assert.equal(readFileSync(session.file, "utf8"), "broken");
		lease.release();
	} finally { f.close(); }
});

test("live leases prevent concurrent execution and cleanup", () => {
	const f = fixture();
	try {
		const lease = f.store.acquire(f.state);
		assert.throws(() => f.store.acquire(f.state), /process still owns/);
		lease.setChildPid(process.pid);
		lease.release();
		lease.release();
		f.store.acquire(f.state).release();
	} finally { f.close(); }
});

test("stale leases are reclaimed after both recorded processes exit", () => {
	const f = fixture();
	try {
		f.store.acquire(f.state).release();
		const dead = spawnSync(process.execPath, ["-e", ""]).pid;
		const file = path.join(f.root, f.state.id, "run.lock");
		writeFileSync(file, JSON.stringify({ token: "old", pid: dead, childPid: dead }));
		f.store.acquire(f.state).release();
		assert.equal(existsSync(file), false);
	} finally { f.close(); }
});

test("surviving children block recovery after their parent has exited", () => {
	const f = fixture();
	try {
		f.store.acquire(f.state).release();
		const dead = spawnSync(process.execPath, ["-e", ""]).pid;
		writeFileSync(path.join(f.root, f.state.id, "run.lock"), JSON.stringify({ token: "old", pid: dead, childPid: process.pid }));
		assert.throws(() => f.store.acquire(f.state), /process still owns/);
	} finally { f.close(); }
});

test("an ambiguous interrupted launch requires inspection rather than risking a second worker", () => {
	const f = fixture();
	try {
		f.store.acquire(f.state).release();
		const dead = spawnSync(process.execPath, ["-e", ""]).pid;
		writeFileSync(path.join(f.root, f.state.id, "run.lock"), JSON.stringify({ token: "old", pid: dead, childPid: 0 }));
		assert.throws(() => f.store.acquire(f.state), /stopped during child launch/);
	} finally { f.close(); }
});

test("foreign owners cannot acquire or delete workflow sessions", () => {
	const f = fixture();
	try {
		const lease = f.store.acquire(f.state);
		const { session } = f.store.prepare(f.state, f.state.todos[0], "implementer");
		lease.release();
		const other = new WorkflowSessionStore(f.root, "fork", "/workspace");
		assert.throws(() => other.acquire(f.state), /ownership changed/);
		assert.throws(() => other.deleteWorkflow(f.state), /ownership changed/);
		assert.equal(existsSync(session.file), true);
	} finally { f.close(); }
});

test("cleanup rejects references outside the owned role path", () => {
	const f = fixture();
	try {
		const lease = f.store.acquire(f.state);
		const { session } = f.store.prepare(f.state, f.state.todos[0], "implementer");
		const original = session.file;
		session.file = path.join(f.root, "unrelated.jsonl");
		writeFileSync(session.file, "keep");
		assert.throws(() => f.store.deleteTodo(f.state, f.state.todos[0]), /outside its owned path/);
		assert.equal(readFileSync(session.file, "utf8"), "keep");
		assert.equal(existsSync(original), true);
		lease.release();
	} finally { f.close(); }
});

test("cleanup refuses symlinked transcripts", () => {
	const f = fixture();
	try {
		const lease = f.store.acquire(f.state);
		const { session } = f.store.prepare(f.state, f.state.todos[0], "implementer");
		rmSync(session.file);
		const target = path.join(f.root, "keep.txt");
		writeFileSync(target, "keep");
		symlinkSync(target, session.file);
		assert.throws(() => f.store.deleteTodo(f.state, f.state.todos[0]), /regular file/);
		assert.equal(readFileSync(target, "utf8"), "keep");
		lease.release();
	} finally { f.close(); }
});

test("todo cleanup retains other todos and recorded revision summaries", () => {
	const f = fixture();
	try {
		const lease = f.store.acquire(f.state);
		const first = f.store.prepare(f.state, f.state.todos[0], "implementer").session.file;
		const second = f.store.prepare(f.state, f.state.todos[1], "reviewer").session.file;
		f.state.todos[0].revisions = [{ humanFeedback: "Keep the fix.", changedFiles: ["one.ts"] }];
		f.store.deleteTodo(f.state, f.state.todos[0]);
		assert.equal(existsSync(first), false);
		assert.equal(existsSync(second), true);
		assert.deepEqual(f.state.todos[0].revisions, [{ humanFeedback: "Keep the fix.", changedFiles: ["one.ts"] }]);
		f.store.deleteWorkflow(f.state);
		assert.equal(existsSync(second), false);
		lease.release();
	} finally { f.close(); }
});
