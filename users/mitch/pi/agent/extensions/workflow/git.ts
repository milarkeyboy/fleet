import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_DIFF_PREVIEW = 60_000;

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
	const result = await execFileAsync("git", args, {
		cwd,
		env: { ...process.env, ...env },
		maxBuffer: 20 * 1024 * 1024,
	});
	return result.stdout.trim();
}

export async function isGitRepository(cwd: string): Promise<boolean> {
	try {
		return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
	} catch {
		return false;
	}
}

/**
 * Materialize the current worktree as a Git tree using a temporary index.
 * This leaves the real index and worktree untouched. Git may retain unreachable
 * blob/tree objects until normal garbage collection.
 */
export async function snapshotWorktree(cwd: string): Promise<string | undefined> {
	if (!(await isGitRepository(cwd))) return undefined;
	const temp = await mkdtemp(path.join(os.tmpdir(), "pi-workflow-index-"));
	const index = path.join(temp, "index");
	const env = { GIT_INDEX_FILE: index };
	try {
		try {
			await git(cwd, ["read-tree", "HEAD"], env);
		} catch {
			await git(cwd, ["read-tree", "--empty"], env);
		}
		await git(cwd, ["add", "-A", "--", "."], env);
		return await git(cwd, ["write-tree"], env);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}

export interface WorktreeDiff {
	changedFiles: string[];
	preview: string;
}

export async function diffTrees(cwd: string, before?: string, after?: string): Promise<WorktreeDiff> {
	if (!before || !after) return { changedFiles: [], preview: "Per-todo diff unavailable outside a Git worktree." };
	const names = await git(cwd, ["diff", "--name-only", before, after]);
	const full = await git(cwd, ["diff", "--no-ext-diff", "--binary", before, after]);
	const preview = full.length > MAX_DIFF_PREVIEW ? `${full.slice(0, MAX_DIFF_PREVIEW)}\n\n[Diff truncated]` : full;
	return { changedFiles: names ? names.split("\n").filter(Boolean) : [], preview: preview || "No changes." };
}
