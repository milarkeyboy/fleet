// Opt-in real-model checks for subprocess isolation and persisted conversations.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import test from "node:test";
import { runAgent, type AgentRunOptions } from "../runner.ts";
import { createWorkflowTodos } from "../planner.ts";
import { WorkflowSessionStore } from "../sessions.ts";
import { createWorkflowState } from "../state.ts";
import { installedPi } from "./pi.ts";

const execFileAsync = promisify(execFile);
const enabled = process.env.PI_WORKFLOW_E2E === "1";
const model = process.env.PI_WORKFLOW_E2E_MODEL;
const pi = installedPi();

async function runInstalled(options: AgentRunOptions) {
	const script = process.argv[1];
	// runAgent reuses the host CLI entry point; the node:test entry point is a test script.
	process.argv[1] = pi!.cli;
	try { return await runAgent(options); }
	finally { process.argv[1] = script; }
}

function roleSession(cwd: string, root: string) {
	const state = createWorkflowState();
	state.ownerSessionId = "test-parent";
	state.todos = createWorkflowTodos([{ title: "Test", instructions: ["Complete the test."] }]);
	const store = new WorkflowSessionStore(root, "test-parent", cwd);
	const lease = store.acquire(state);
	return { session: store.prepare(state, state.todos[0], "implementer").session, lease };
}
async function exists(filePath: string): Promise<boolean> {
	try {
		await readFile(filePath);
		return true;
	} catch {
		return false;
	}
}

// This test intentionally uses a real Pi subprocess. It is opt-in because it
// requires a configured model, but does not require QEMU or a filesystem sandbox.
test("workflow implementer isolates extensions and enforces the bash policy", { skip: !enabled || !model || !pi }, async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-e2e-"));
	const sentinel = path.join(cwd, `.pi-extension-loaded-${process.pid}-${Date.now()}`);
	const root = await mkdtemp(path.join(os.tmpdir(), "workflow-e2e-sessions-"));
	const { session, lease } = roleSession(cwd, root);
	try {
		await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
		// Discovery would load this extension unless the runner's extension
		// isolation is active. Its only observable behavior is a host-side marker.
		await writeFile(
			path.join(cwd, ".pi", "extensions", "sentinel.ts"),
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "loaded"); export default function () {}`, 
		);
		await writeFile(path.join(cwd, ".gitignore"), "");
		await execFileAsync("git", ["init", "-q", cwd]);

		const result = await runInstalled({
			cwd,
			sessionFile: session.file,
			onProcess: lease.setChildPid,
			roleName: "workflow-implementer",
			systemPrompt: `You are a workflow implementer. Validate your work with focused checks. End with exactly one machine-readable block: <workflow-implementation>{"status":"completed|blocked","summary":"...","filesChanged":[],"tests":[]}</workflow-implementation>.`,
			task: `Run git status --short. Then use the bash tool to run exactly this command: git push origin main. Do not substitute another command and do not retry it. Report the tool result, then end with the required workflow-implementation block.`,
			skillPaths: [],
			tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
			model: model!,
		});

		assert.equal(await exists(sentinel), false, "a discovered repository extension was loaded");
		const deniedBash = result.messages.some((message: any) => {
			if (message?.role !== "toolResult") return false;
			const serialized = JSON.stringify(message);
			return /Bash policy denied|destructive Git operation/i.test(serialized);
		});
		assert.equal(deniedBash, true, "the bash policy did not deny git push");
	} finally {
		lease.release();
		await rm(root, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	}
});

test("a new Pi subprocess recalls an earlier turn from its role session", { skip: !enabled || !model || !pi }, async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-e2e-memory-"));
	const root = await mkdtemp(path.join(os.tmpdir(), "workflow-e2e-sessions-"));
	const { session, lease } = roleSession(cwd, root);
	try {
		const phrase = `workflow-${randomUUID()}`;
		const options = {
			cwd, roleName: "workflow-implementer", sessionFile: session.file, model: model!,
			systemPrompt: "Remember phrases supplied by the user. Answer requests directly without using tools.",
			skillPaths: [], tools: ["read"], onProcess: lease.setChildPid,
		};
		await runInstalled({ ...options, task: `Remember this phrase for my next request: ${phrase}. Reply with OK.` });
		const recalled = await runInstalled({ ...options, task: "Reply with only the exact phrase I asked you to remember earlier." });
		assert.equal(recalled.output.trim(), phrase);
	} finally {
		lease.release();
		await rm(root, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	}
});
