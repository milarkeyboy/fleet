import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { diffTrees, snapshotWorktree } from "../git.ts";

let hasGit = true;
try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { hasGit = false; }

test("captures todo-specific tracked and untracked changes without touching the real index", { skip: !hasGit }, async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-git-test-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
	try {
		git("init"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
		await writeFile(path.join(cwd, "a.py"), "print('a')\n"); git("add", "a.py"); git("commit", "-m", "initial");
		const beforeStatus = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
		const before = await snapshotWorktree(cwd);
		await writeFile(path.join(cwd, "a.py"), "print('b')\n");
		await writeFile(path.join(cwd, "new.py"), "value = 1\n");
		const after = await snapshotWorktree(cwd);
		const diff = await diffTrees(cwd, before, after);
		assert.deepEqual(diff.changedFiles.sort(), ["a.py", "new.py"]);
		assert.equal(beforeStatus, "");
		assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd, encoding: "utf8" }), "");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("non-git workspaces return an unavailable baseline", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-nongit-test-"));
	try { assert.equal(await snapshotWorktree(cwd), undefined); }
	finally { await rm(cwd, { recursive: true, force: true }); }
});
