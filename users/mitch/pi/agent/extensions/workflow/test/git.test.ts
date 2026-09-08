import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { diffForHumanCheckpoint, diffTrees, snapshotWorktree } from "../git.ts";
import type { WorkflowTodo } from "../state.ts";

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

test("reconstructs uncached diffs between human checkpoints", { skip: !hasGit }, async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-human-diff-test-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
	try {
		git("init");
		const todoBase = await snapshotWorktree(cwd);
		await writeFile(path.join(cwd, "one.ts"), "one\n");
		const first = await snapshotWorktree(cwd);
		await writeFile(path.join(cwd, "two.ts"), "two\n");
		const firstCheckpoint = await snapshotWorktree(cwd);
		const todo: WorkflowTodo = {
			step: 1,
			text: "Task",
			status: "awaiting-user",
			attempts: 2,
			automaticReviewCycles: 2,
			revisions: [
				{ baselineTree: todoBase, resultTree: first, changedFiles: ["one.ts"], diffPreview: "first revision" },
				{ baselineTree: first, resultTree: firstCheckpoint, changedFiles: ["two.ts"], diffPreview: "second revision" },
			],
		};

		const initial = await diffForHumanCheckpoint(cwd, todo);
		assert.deepEqual(initial.changedFiles.sort(), ["one.ts", "two.ts"]);

		await writeFile(path.join(cwd, "three.ts"), "three\n");
		const third = await snapshotWorktree(cwd);
		await writeFile(path.join(cwd, "four.ts"), "four\n");
		const secondCheckpoint = await snapshotWorktree(cwd);
		todo.revisions.push(
			{ humanFeedback: "Revise it.", baselineTree: firstCheckpoint, resultTree: third, changedFiles: ["three.ts"], diffPreview: "third revision" },
			{ baselineTree: third, resultTree: secondCheckpoint, changedFiles: ["four.ts"], diffPreview: "fourth revision" },
		);

		const revised = await diffForHumanCheckpoint(cwd, todo);
		assert.deepEqual(revised.changedFiles.sort(), ["four.ts", "three.ts"]);
		assert.doesNotMatch(revised.preview, /one\.ts|two\.ts/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("non-git workspaces return an unavailable baseline", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-nongit-test-"));
	try { assert.equal(await snapshotWorktree(cwd), undefined); }
	finally { await rm(cwd, { recursive: true, force: true }); }
});
