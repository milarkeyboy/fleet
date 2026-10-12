// Deterministic agent boundary for design and implementation orchestration tests.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverWorkflowContent } from "../content.ts";
import { WorkflowOrchestrator } from "../orchestrator.ts";
import { createWorkflowTodos } from "../planner.ts";
import type { AgentRunOptions } from "../runner.ts";
import { WorkflowSessionStore } from "../sessions.ts";
import { cloneState, createWorkflowState } from "../state.ts";

export function fixture() {
	const root = mkdtempSync(path.join(os.tmpdir(), "workflow-design-"));
	const cwd = path.join(root, "work");
	execFileSync("git", ["init", "-q", cwd]);
	const state = createWorkflowState();
	state.todos = createWorkflowTodos([{ title: "API", instructions: ["Implement API."] }]);
	const ctx = { cwd, ui: { notify() {}, setStatus() {}, setWidget() {} } } as unknown as ExtensionContext;
	const store = new WorkflowSessionStore(path.join(root, "sessions"), "parent", cwd);
	const calls: AgentRunOptions[] = [];
	const controls = { beforeRun: async (_options: AgentRunOptions) => {}, implementation: { status: "completed", summary: "Done", filesChanged: [], tests: [] } as any, review: { verdict: "approve", summary: "Ready", findings: [] } as any };
	const content = discoverWorkflowContent(cwd, false, path.join(root, "home"));
	function orchestrator(current = state) {
		return new WorkflowOrchestrator(current, {
			persist() {}, updateUi() {}, content: () => content, sessions: () => store,
			models: async () => ({ implementer: { model: "test/impl" }, "design-reviewer": { model: "test/design" }, "code-reviewer": { model: "test/code" } }),
			runAgent: async (options) => {
				calls.push(options);
				appendFileSync(options.sessionFile, `${JSON.stringify({ type: "message", message: { role: "user", content: options.task } })}\n`);
				await controls.beforeRun(options);
				const output = options.roleName === "workflow-implementer" ? `<workflow-implementation>${JSON.stringify(controls.implementation)}</workflow-implementation>` : `<workflow-review>${JSON.stringify(controls.review)}</workflow-review>`;
				return { exitCode: 0, output, stderr: "", messages: [] };
			},
		});
	}
	return { root, cwd, ctx, state, calls, controls, store, content, orchestrator, restored: () => cloneState(state), close: () => rmSync(root, { recursive: true, force: true }) };
}
