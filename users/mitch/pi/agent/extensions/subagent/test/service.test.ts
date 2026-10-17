// Native persistence, cross-runtime observation and safe conversation storage lifecycle.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getConversationService } from "../api.ts";
import { installedPi } from "./pi.ts";

const agent = { name: "reviewer", description: "Review", body: "Review carefully.", filePath: "/reviewer.md", model: "test/model", tools: ["read"] };
const success = { exitCode: 0, output: "Done", stderr: "", messages: [] };
function fixture() {
	const root = mkdtempSync(path.join(os.tmpdir(), "subagent-service-"));
	const owner = { parentSessionId: "parent", creator: "adhoc", cwd: process.cwd() };
	const service = getConversationService(root);
	const handle = service.create(owner, "Review");
	const dir = path.join(root, "conversations", handle);
	return { root, owner, service, handle, dir, close: () => rmSync(root, { recursive: true, force: true }) };
}
function deadPid(): number { return Number(execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).trim()); }

const peer = fileURLToPath(new URL("./fixtures/runner.ts", import.meta.url));
test("native history survives service and subprocess restarts", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "subagent-restart-"));
	try {
		const first = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", peer, "service", root, "new", "remember-this"], { encoding: "utf8" }));
		const second = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", peer, "service", root, first.handle, "recall"], { encoding: "utf8" }));
		assert.equal(first.output, "first run");
		assert.equal(second.output, "remembered");
		assert.equal(second.handle, first.handle);
		assert.equal(second.messages, 4);
		assert.equal(second.status, "idle");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed streamed responses survive a complete process restart", () => {
	const f = fixture();
	try {
		assert.throws(() => execFileSync(process.execPath, ["--experimental-strip-types", peer, "service", f.root, f.handle, "stream-partial"], { stdio: "pipe" }));
		const snapshot = f.service.inspect("parent", f.handle);
		assert.equal(snapshot.info.status, "failed");
		assert.equal(snapshot.messages[1].message.content[0].thinking, "Consider carefully.");
		assert.equal(snapshot.messages[1].message.content[1].text, "partial\u2028answer");
		assert.equal(snapshot.messages[1].pending, true);
		assert.match(snapshot.diagnostics, /fixture diagnostic/);
	} finally { f.close(); }
});

test("group leases fence workers loaded by another process", () => {
	const f = fixture();
	try {
		const lease = f.service.acquire(f.owner);
		const file = path.join(f.dir, "session.jsonl");
		const before = readFileSync(file, "utf8");
		assert.throws(() => execFileSync(process.execPath, ["--experimental-strip-types", peer, "service", f.root, f.handle, "review"], { stdio: "pipe" }));
		assert.equal(readFileSync(file, "utf8"), before);
		lease.release();
	} finally { f.close(); }
});

test("inspect reads Pi's native session without modifying its bytes or mode", { skip: !installedPi() }, async () => {
	const f = fixture();
	try {
		const { SessionManager } = await import(installedPi()!.api);
		const file = path.join(f.dir, "session.jsonl");
		const manager = SessionManager.open(file, f.owner.cwd);
		manager.appendMessage({ role: "system", content: "System instructions", timestamp: 1 });
		manager.appendMessage({ role: "user", content: "Native question", timestamp: 2 });
		manager.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "Native thought" }, { type: "text", text: "Native answer" }], api: "test", provider: "test", model: "test", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 3 });
		const before = readFileSync(file, "utf8"); chmodSync(file, 0o400);
		const snapshot = f.service.inspect("parent", f.handle);
		assert.deepEqual(snapshot.messages.map((item) => item.message.role), ["system", "user", "assistant"]);
		assert.equal(snapshot.messages[2].message.content[0].thinking, "Native thought");
		assert.equal(readFileSync(file, "utf8"), before);
		assert.equal(lstatSync(file).mode & 0o777, 0o400);
	} finally { f.close(); }
});

test("listeners are isolated and snapshots are detached from live state", async () => {
	const f = fixture();
	try {
		let notified = 0;
		const remove = f.service.subscribe("parent", () => { throw new Error("viewer failure"); });
		const removeSecond = getConversationService(f.root).subscribe("parent", () => { notified++; });
		await f.service.run(f.owner, f.handle, agent, { task: "Review" }, async (options) => {
			options.onEvent!({ type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } });
			options.onEvent!({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Think" } });
			const snapshot = getConversationService(f.root).inspect("parent", f.handle);
			assert.equal(snapshot.messages[0].message.content[0].thinking, "Think");
			snapshot.messages[0].message.content[0].thinking = "Changed";
			assert.equal(f.service.inspect("parent", f.handle).messages[0].message.content[0].thinking, "Think");
			return success;
		});
		assert.ok(notified > 0);
		remove(); removeSecond();
	} finally { f.close(); }
});

test("independent Jiti loads share the live registry and listeners", { skip: !installedPi() }, async () => {
	const f = fixture();
	try {
		const require = createRequire(installedPi()!.api);
		const { createJiti } = require("jiti");
		const file = fileURLToPath(new URL("../api.ts", import.meta.url));
		const first = await createJiti(import.meta.url, { moduleCache: false }).import(file);
		const second = await createJiti(import.meta.url, { moduleCache: false }).import(file);
		let notified = 0;
		const remove = second.getConversationService(f.root).subscribe("parent", () => notified++);
		await first.getConversationService(f.root).run(f.owner, f.handle, agent, { task: "Review" }, async (options: any) => {
			options.onEvent({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Visible" }], timestamp: 1 } });
			assert.equal(second.getConversationService(f.root).inspect("parent", f.handle).messages[0].message.content[0].text, "Visible");
			assert.throws(() => second.getConversationService(f.root).delete(f.owner, f.handle), /active/);
			return success;
		});
		assert.ok(notified > 0); remove();
	} finally { f.close(); }
});

test("stale running leases report interruption without writing or starting a worker", () => {
	const f = fixture();
	try {
		const file = path.join(f.dir, "metadata.json");
		const metadata = JSON.parse(readFileSync(file, "utf8")); metadata.info.status = "running";
		writeFileSync(file, JSON.stringify(metadata));
		writeFileSync(path.join(f.dir, "run.lock"), JSON.stringify({ token: "old", pid: deadPid() }));
		const before = readFileSync(file, "utf8");
		assert.equal(f.service.get(f.owner, f.handle).status, "interrupted");
		assert.equal(f.service.listParent("parent")[0].status, "interrupted");
		assert.equal(f.service.inspect("parent", f.handle).info.status, "interrupted");
		assert.equal(readFileSync(file, "utf8"), before);
	} finally { f.close(); }
});

test("stale leases can be reclaimed for a later invocation", async () => {
	const f = fixture();
	try {
		const dead = deadPid(); writeFileSync(path.join(f.dir, "run.lock"), JSON.stringify({ token: "old", pid: dead, childPid: dead }));
		await f.service.run(f.owner, f.handle, agent, { task: "Retry" }, async () => success);
		assert.equal(f.service.get(f.owner, f.handle).status, "idle");
	} finally { f.close(); }
});

test("unresolved child launches fence resumption and deletion", async () => {
	const f = fixture();
	try {
		writeFileSync(path.join(f.dir, "run.lock"), JSON.stringify({ token: "old", pid: deadPid(), childPid: 0 }));
		await assert.rejects(async () => f.service.run(f.owner, f.handle, agent, { task: "Retry" }, async () => success), /child launch/);
		assert.throws(() => f.service.delete(f.owner, f.handle), /child launch/);
	} finally { f.close(); }
});

test("surviving subprocesses block deletion after their parent exits", async () => {
	const f = fixture();
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: process.platform !== "win32" });
	try {
		await once(child, "spawn");
		writeFileSync(path.join(f.dir, "run.lock"), JSON.stringify({ token: "old", pid: deadPid(), childPid: child.pid }));
		assert.throws(() => f.service.delete(f.owner, f.handle), /active/);
	} finally { child.kill("SIGKILL"); await once(child, "exit"); f.close(); }
});

test("explicit group leases permit sequential invocations and fence other acquisitions", async () => {
	const f = fixture();
	try {
		const lease = f.service.acquire(f.owner);
		assert.throws(() => getConversationService(f.root).acquire(f.owner), /active/);
		await f.service.run(f.owner, f.handle, agent, { task: "Review" }, async () => {
			assert.throws(() => lease.release(), /active/); return success;
		});
		assert.equal(f.service.delete(f.owner, f.handle), true);
		lease.release(); lease.release();
	} finally { f.close(); }
});

for (const childPid of [0, process.pid]) {
	test(`owned group leases fence cleanup while child PID ${childPid === 0 ? "is unresolved" : "is live"}`, () => {
		const f = fixture();
		try {
			const lease = f.service.acquire(f.owner); lease.setChildPid(childPid);
			assert.throws(() => f.service.delete(f.owner, f.handle), /child launch|active subprocess/);
		} finally { f.close(); }
	});
}

test("deletion is idempotent when native files disappeared during earlier cleanup", () => {
	const f = fixture();
	try {
		unlinkSync(path.join(f.dir, "session.jsonl"));
		assert.equal(f.service.delete(f.owner, f.handle), true);
		assert.equal(f.service.delete(f.owner, f.handle), false);
	} finally { f.close(); }
});

test("deleteOwned removes only the creator's conversations", () => {
	const f = fixture();
	try {
		const other = { ...f.owner, creator: "workflow:one" };
		const handle = f.service.create(other, "Workflow");
		f.service.deleteOwned(f.owner);
		assert.deepEqual(f.service.listParent("parent").map((info) => info.handle), [handle]);
	} finally { f.close(); }
});

for (const kind of ["unknown file", "symlink"]) {
	test(`deletion rejects unexpected ${kind} entries before removing history`, () => {
		const f = fixture();
		try {
			if (kind === "unknown file") writeFileSync(path.join(f.dir, "unowned.txt"), "keep");
			else { unlinkSync(path.join(f.dir, "session.jsonl")); symlinkSync(path.join(f.dir, "metadata.json"), path.join(f.dir, "session.jsonl")); }
			assert.throws(() => f.service.delete(f.owner, f.handle), /Unexpected|regular/);
			assert.ok(readFileSync(path.join(f.dir, "metadata.json"), "utf8").includes(f.handle));
		} finally { f.close(); }
	});
}

test("missing and corrupt native sessions have explicit errors", () => {
	const f = fixture();
	try {
		const file = path.join(f.dir, "session.jsonl"); unlinkSync(file);
		assert.throws(() => f.service.inspect("parent", f.handle), /missing/);
		writeFileSync(file, "broken");
		assert.throws(() => f.service.get(f.owner, f.handle), /corrupt/);
	} finally { f.close(); }
});

test("invalid and unknown handles cannot traverse managed paths", () => {
	const f = fixture();
	try {
		assert.throws(() => f.service.get(f.owner, "../../outside"), /Invalid/);
		assert.throws(() => f.service.inspect("parent", "00000000-0000-0000-0000-000000000000"), /Unknown/);
	} finally { f.close(); }
});

test("configured ancestor links resolve to the same managed service root", () => {
	const f = fixture();
	try {
		const alias = path.join(f.root, "alias"); symlinkSync(f.root, alias);
		const linked = getConversationService(path.join(alias, "subagents"));
		const handle = linked.create(f.owner, "Linked parent");
		assert.equal(getConversationService(path.join(f.root, "subagents")).get(f.owner, handle).label, "Linked parent");
	} finally { f.close(); }
});

test("a symlink substituted for the managed root cannot receive writes", () => {
	const f = fixture();
	try {
		const alias = path.join(f.root, "alias"); symlinkSync(f.dir, alias);
		assert.throws(() => getConversationService(alias).create(f.owner, "Unsafe"), /directory/);
		assert.equal(f.service.get(f.owner, f.handle).label, "Review");
	} finally { f.close(); }
});

test("incomplete allocations remain outside conversation discovery", () => {
	const f = fixture();
	try {
		mkdirSync(path.join(f.root, "staging", "00000000-0000-0000-0000-000000000000"), { recursive: true });
		assert.deepEqual(f.service.listParent("parent").map(info => info.handle), [f.handle]);
		const lease = f.service.acquire(f.owner); lease.release();
		f.service.deleteOwned(f.owner);
		assert.deepEqual(f.service.list(f.owner), []);
	} finally { f.close(); }
});

test("interrupted removal is undiscoverable and remains explicitly cleanable", () => {
	const f = fixture();
	try {
		mkdirSync(path.join(f.root, "removing"));
		const tombstone = path.join(f.root, "removing", f.handle);
		renameSync(f.dir, tombstone);
		unlinkSync(path.join(tombstone, "session.jsonl"));
		assert.deepEqual(f.service.listParent("parent"), []);
		f.service.deleteOwned(f.owner);
		assert.equal(existsSync(tombstone), false);
	} finally { f.close(); }
});

test("the handle lease protects final metadata persistence", async () => {
	const f = fixture();
	const service = f.service as any;
	const save = service.save.bind(service);
	let finalised = false;
	service.save = (metadata: any) => {
		if (metadata.info.status === "idle" && metadata.info.agent) {
			assert.equal(existsSync(path.join(f.dir, "run.lock")), true);
			finalised = true;
		}
		save(metadata);
	};
	try {
		await f.service.run(f.owner, f.handle, agent, { task: "Review." }, async () => success);
		assert.equal(finalised, true);
		assert.equal(existsSync(path.join(f.dir, "run.lock")), false);
	} finally { f.close(); }
});

test("managed files and directories have private permissions", () => {
	const f = fixture();
	try {
		assert.equal(lstatSync(f.dir).mode & 0o777, 0o700);
		assert.equal(lstatSync(path.join(f.dir, "metadata.json")).mode & 0o777, 0o600);
		assert.equal(lstatSync(path.join(f.dir, "session.jsonl")).mode & 0o777, 0o600);
	} finally { f.close(); }
});
