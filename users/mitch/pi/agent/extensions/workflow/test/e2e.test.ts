// Opt-in provider-backed conversation continuity through workflow handles.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../../subagent/runner.ts";
import { WorkflowSessionStore } from "../sessions.ts";
import { createWorkflowState } from "../state.ts";
import { createWorkflowTodos } from "../planner.ts";
import { installedPi } from "../../subagent/test/pi.ts";

const pi = installedPi();
const model = process.env.PI_WORKFLOW_E2E_MODEL;
const enabled = process.env.PI_WORKFLOW_E2E === "1";

test("workflow subprocesses isolate extensions and enforce the bash policy", { skip: !enabled || !model || !pi }, async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "workflow-e2e-isolation-"));
	const sentinel = path.join(root, "extension-loaded");
	const state = createWorkflowState();
	state.ownerSessionId = "parent";
	state.todos = createWorkflowTodos([{ title: "Check policy", instructions: ["Check policy."] }]);
	const store = new WorkflowSessionStore(path.join(root, "subagents"), "parent", root);
	const lease = store.acquire(state);
	const script = process.argv[1];
	try {
		mkdirSync(path.join(root, ".pi", "extensions"), { recursive: true });
		writeFileSync(path.join(root, ".pi", "extensions", "sentinel.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "loaded"); export default function () {}`);
		process.argv[1] = pi!.cli;
		const { handle } = store.prepare(state, state.todos[0], "implementer");
		const agent = { name: "implementer", body: "Follow the task exactly.", model: model!, tools: ["read", "bash"] } as any;
		const result = await store.run(state, handle, agent, { task: "Use bash to run exactly git push origin main. Do not retry or substitute commands. Report the tool result.", onProcess: lease.setChildPid }, runAgent);
		assert.equal(existsSync(sentinel), false);
		assert.equal(result.messages.some((message: any) => message.role === "toolResult" && /Bash policy denied|destructive Git operation/i.test(JSON.stringify(message))), true);
	} finally {
		process.argv[1] = script;
		lease.release();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a later invocation recalls the same workflow role conversation", { skip: !enabled || !model || !pi }, async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "workflow-e2e-"));
	const state = createWorkflowState();
	state.ownerSessionId = "parent";
	state.todos = createWorkflowTodos([{ title: "Remember", instructions: ["Remember a phrase."] }]);
	const store = new WorkflowSessionStore(path.join(root, "subagents"), "parent", root);
	const lease = store.acquire(state);
	const script = process.argv[1];
	try {
		process.argv[1] = pi!.cli;
		const { handle } = store.prepare(state, state.todos[0], "implementer");
		const agent = { name: "implementer", body: "Remember phrases. Answer directly without tools.", model: model!, tools: ["read"] } as any;
		const phrase = `workflow-${randomUUID()}`;
		await store.run(state, handle, agent, { task: `Remember ${phrase}. Reply OK.`, onProcess: lease.setChildPid }, runAgent);
		const recalled = await store.run(state, handle, agent, { task: "Reply with only the exact phrase.", onProcess: lease.setChildPid }, runAgent);
		assert.equal(recalled.output.trim(), phrase);
	} finally {
		process.argv[1] = script;
		lease.release();
		rmSync(root, { recursive: true, force: true });
	}
});
