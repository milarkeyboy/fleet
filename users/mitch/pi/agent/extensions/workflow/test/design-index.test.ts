// Phase-specific commands and top-level conversational planning with deterministic peers.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveWorkflowAgents } from "../config.ts";
import { writeWorkflowTestAgents } from "./agents.ts";
import { createWorkflowTodos } from "../planner.ts";
import { cloneState, createWorkflowState, WORKFLOW_ENTRY_TYPE } from "../state.ts";

const modules: Record<string, string> = {
	"@earendil-works/pi-coding-agent": "export const getAgentDir = () => globalThis.workflowTestAgentDir;",
	"@earendil-works/pi-tui": "export class Text {}",
	typebox: "export const Type = new Proxy({}, { get: () => (...args) => args });",
	"./git.ts": `
		export * from ${JSON.stringify(new URL("../git.ts", import.meta.url).href)};
		import { requireWorktreeSnapshot as snapshot } from ${JSON.stringify(new URL("../git.ts", import.meta.url).href)};
		export async function requireWorktreeSnapshot(cwd) {
			await globalThis.workflowBeforeSnapshot?.(cwd);
			return snapshot(cwd);
		}
	`,
};
const loader = registerHooks({ resolve(name, context, next) {
	return name in modules ? { url: `data:text/javascript,${encodeURIComponent(modules[name])}`, shortCircuit: true } : next(name, context);
} });
const { WorkflowOrchestrator } = await import("../orchestrator.ts");
const { default: extension } = await import("../index.ts");
loader.deregister();
const exclusive = (WorkflowOrchestrator.prototype as any).runExclusive;
(WorkflowOrchestrator.prototype as any).runExclusive = function(ctx: any, ...args: any[]) {
	this.hooks.models = async () => resolveWorkflowAgents((globalThis as any).workflowTestAgentDir);
	this.hooks.runAgent = ctx.runAgent;
	return exclusive.call(this, ctx, ...args);
};

async function fixture() {
	const root = mkdtempSync(path.join(os.tmpdir(), "workflow-design-commands-"));
	const cwd = path.join(root, "work");
	execFileSync("git", ["init", "-q", cwd]);
	(globalThis as any).workflowTestAgentDir = path.join(root, "agent");
	writeWorkflowTestAgents((globalThis as any).workflowTestAgentDir);
	const state = createWorkflowState();
	state.todos = createWorkflowTodos([{ title: "First", instructions: ["Implement first."] }, { title: "Second", instructions: ["Implement second."] }]);
	const entries: any[] = [{ id: "initial", type: "custom", customType: WORKFLOW_ENTRY_TYPE, data: cloneState(state) }];
	const handlers: Record<string, any> = {}, tools: Record<string, any> = {};
	let command: any;
	let activeTools = ["read", "bash", "edit", "write"];
	const notices: string[] = [], calls: any[] = [], messages: any[] = [];
	const controls = {
		beforeRun: async (_options: any) => {}, beforeSnapshot: async (_cwd: string) => {},
		implementation: { status: "completed", summary: "Done", filesChanged: [], tests: [] } as any,
		review: { verdict: "approve", summary: "Ready", findings: [] } as any,
	};
	(globalThis as any).workflowBeforeSnapshot = (cwd: string) => controls.beforeSnapshot(cwd);
	const pi: any = {
		registerFlag() {}, registerMessageRenderer() {}, getFlag: () => false,
		registerCommand: (_name: string, value: any) => command = value.handler,
		registerTool: (value: any) => tools[value.name] = value,
		on: (name: string, value: any) => handlers[name] = value,
		getActiveTools: () => activeTools, setActiveTools: (value: string[]) => activeTools = value,
		appendEntry: (customType: string, data: any) => entries.push({ id: String(entries.length), type: "custom", customType, data }),
		sendMessage: (message: any) => messages.push(message),
	};
	const ctx: any = {
		cwd, hasUI: false, isProjectTrusted: () => false,
		sessionManager: { getSessionId: () => "parent", getEntries: () => entries, getBranch: () => entries },
		ui: { notify: (text: string) => notices.push(text), setStatus() {}, setWidget() {}, theme: { fg: (_colour: string, text: string) => text } },
		runAgent: async (options: any) => {
			calls.push(options);
			appendFileSync(options.sessionFile, `${JSON.stringify({ type: "message", id: `user-${calls.length}`, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: options.task, timestamp: 1 } })}\n`);
			await controls.beforeRun(options);
			return { exitCode: 0, stderr: "", messages: [], output: options.systemPrompt.includes("<workflow-implementation>")
				? `<workflow-implementation>${JSON.stringify(controls.implementation)}</workflow-implementation>`
				: `<workflow-review>${JSON.stringify(controls.review)}</workflow-review>` };
		},
	};
	extension(pi);
	await handlers.session_start({}, ctx);
	return { cwd, ctx, entries, tools, handlers, calls, messages, notices, controls, command: (args: string) => command(args, ctx), state: () => entries.at(-1).data, close: () => rmSync(root, { recursive: true, force: true }) };
}

// Hold acceptance after the exclusive operation's preflight snapshot.
function holdAcceptanceSnapshot(f: Awaited<ReturnType<typeof fixture>>) {
	let entered!: () => void, release!: () => void;
	const started = new Promise<void>((resolve) => entered = resolve);
	const released = new Promise<void>((resolve) => release = resolve);
	let snapshots = 0;
	f.controls.beforeSnapshot = async () => {
		if (++snapshots === 2) { entered(); await released; }
	};
	return { started, release };
}

for (const command of ["abort", "replan"]) {
	test(`${command} cannot interleave with a pending code approval`, async () => {
		const f = await fixture();
		try {
			await f.command("execute");
			await f.command("design-review");
			await f.command("design-approve");
			const gate = holdAcceptanceSnapshot(f);
			const approval = f.command("approve");
			await gate.started;
			const decision = f.command(command);
			try { assert.match(f.notices.at(-1)!, /transition is already in progress/); }
			finally { gate.release(); await Promise.all([approval, decision]); }
			assert.equal(f.state().todos[0].status, "approved");
			assert.equal(f.state().todos[1].status, "design-editing");
		} finally { f.close(); }
	});
}

test("shutdown cancels pending code approval without deleting conversations", async () => {
	const f = await fixture();
	try {
		await f.command("execute");
		await f.command("design-review");
		await f.command("design-approve");
		const sessions = f.state().todos[0].sessions;
		const gate = holdAcceptanceSnapshot(f);
		const approval = f.command("approve");
		await gate.started;
		const shutdown = f.handlers.session_shutdown({}, f.ctx);
		gate.release();
		await Promise.all([approval, shutdown]);
		assert.equal(f.state().todos[0].status, "awaiting-user");
		assert.deepEqual(f.state().todos[0].sessions, sessions);
		assert.equal(f.state().todos[1].status, "pending");
	} finally { f.close(); }
});

test("design commands require acceptance before implementation", async () => {
	const f = await fixture();
	try {
		await f.command("execute");
		await f.command("design-review");
		assert.equal(f.state().todos[0].status, "awaiting-design");
		assert.equal(f.calls.length, 0);
		await f.command("design-approve");
		assert.deepEqual(f.calls.map((call) => call.roleName), ["implementer", "reviewer"]);
	} finally { f.close(); }
});

test("code approval enters the next todo's human design phase", async () => {
	const f = await fixture();
	try {
		await f.command("execute");
		await f.command("design-review");
		await f.command("design-approve");
		await f.command("approve");
		assert.equal(f.state().todos[0].status, "approved");
		assert.equal(f.state().todos[1].status, "design-editing");
		assert.equal(f.calls.length, 2);
	} finally { f.close(); }
});

test("feedback resumes a blocked skeleton implementation with the same accepted design", async () => {
	const f = await fixture();
	try {
		await f.command("execute");
		writeFileSync(path.join(f.cwd, "widget.h"), "class Widget {};\n");
		await f.command("design-review");
		f.controls.implementation = { status: "blocked", summary: "Cannot extend the skeleton", filesChanged: [], tests: [], blocker: { kind: "design", reason: "Adding a constructor would edit the design." } };
		await f.command("design-approve");
		assert.equal(f.state().todos[0].status, "awaiting-change");
		const session = f.calls[1].sessionFile;
		await f.handlers.session_start({}, f.ctx);
		f.controls.implementation = { status: "completed", summary: "Implemented", filesChanged: ["widget.h"], tests: [] };
		f.controls.beforeRun = async (options) => {
			if (options.roleName === "implementer") writeFileSync(path.join(f.cwd, "widget.h"), "class Widget { public: Widget() = default; private: int value = 0; };\n");
		};
		const clarification = "Complete the class skeleton with the constructor and private members needed for the accepted behaviour.";
		await f.command(`feedback ${clarification}`);
		assert.deepEqual(f.calls.map((call) => call.roleName), ["design-reviewer", "implementer", "implementer", "reviewer"]);
		assert.equal(f.calls[2].sessionFile, session);
		assert.ok(f.calls[2].systemPrompt.includes(clarification));
		assert.ok(f.calls[3].systemPrompt.includes(clarification));
		assert.equal(f.state().todos[0].revisions[1].humanFeedback, clarification);
		assert.deepEqual(f.state().todos[0].revisions[1].changedFiles, ["widget.h"]);
		assert.equal(f.state().todos[0].designs.length, 1);
		assert.equal(f.state().todos[0].designAccepted, 0);
		assert.equal(f.state().todos[0].status, "awaiting-user");
	} finally { f.close(); }
});

test("feedback resolves a code review escalation through another implementation and review", async () => {
	const f = await fixture();
	try {
		await f.command("execute");
		await f.command("design-review");
		f.controls.review = { verdict: "escalate", summary: "Constructor needs approval", findings: [], blocker: { kind: "design", reason: "The skeleton has no constructor." } };
		await f.command("design-approve");
		assert.equal(f.state().todos[0].status, "awaiting-change");
		f.controls.review = { verdict: "approve", summary: "Ready", findings: [] };
		await f.command("feedback The constructor completes the skeleton within the accepted contract.");
		assert.deepEqual(f.calls.map((call) => call.roleName), ["implementer", "reviewer", "implementer", "reviewer"]);
		assert.equal(f.calls[0].sessionFile, f.calls[2].sessionFile);
		assert.equal(f.calls[1].sessionFile, f.calls[3].sessionFile);
		assert.equal(f.state().todos[0].status, "awaiting-user");
	} finally { f.close(); }
});

test("escalation review offers implementation clarification without code approval", async () => {
	const f = await fixture();
	try {
		await f.command("execute");
		await f.command("design-review");
		f.controls.implementation = { status: "blocked", summary: "Needs clarification", filesChanged: [], tests: [], blocker: { kind: "design", reason: "May the skeleton be extended?" } };
		await f.command("design-approve");
		f.controls.implementation = { status: "completed", summary: "Done", filesChanged: [], tests: [] };
		f.ctx.hasUI = true;
		let choices: string[] = [];
		f.ctx.ui.select = async (_title: string, options: string[]) => { choices = options; return "Clarify implementation"; };
		f.ctx.ui.editor = async () => "Complete the skeleton within the accepted contract.";
		await f.command("review");
		assert.ok(choices.includes("Clarify implementation"));
		assert.equal(choices.includes("Approve and continue"), false);
		assert.equal(f.state().todos[0].revisions[1].humanFeedback, "Complete the skeleton within the accepted contract.");
		assert.equal(f.state().todos[0].status, "awaiting-user");
	} finally { f.close(); }
});

test("design feedback reaches only the design reviewer", async () => {
	const f = await fixture();
	try {
		await f.command("execute");
		writeFileSync(path.join(f.cwd, "design.md"), "Contract\n");
		await f.command("design-feedback Check testability.");
		assert.equal(f.calls[0].roleName, "design-reviewer");
		assert.match(f.calls[0].task, /Check testability/);
	} finally { f.close(); }
});

test("design review findings are shown at the human checkpoint", async () => {
	const f = await fixture();
	try {
		await f.command("execute");
		writeFileSync(path.join(f.cwd, "design.md"), "Contract\n");
		await f.command("design-review");
		assert.ok(f.notices.some((notice) => /Design reviewer \(test\/design\): approve\nReady/.test(notice)));
	} finally { f.close(); }
});

test("design diffs are labelled separately from code checkpoints", async () => {
	const f = await fixture();
	try {
		await f.command("execute");
		writeFileSync(path.join(f.cwd, "design.md"), "Contract\n");
		await f.command("diff");
		assert.equal(f.messages[0].details.title, "Todo 1: human design changes");
		assert.match(f.messages[0].details.diff, /Contract/);
	} finally { f.close(); }
});

test("plan amendments are staged until explicit human acceptance", async () => {
	const f = await fixture();
	try {
		await f.command("execute");
		await f.command("replan");
		const first = f.state().todos[0];
		await f.tools.workflow_submit_plan.execute("id", {
			baseRevision: 1, affectedIds: [first.id],
			todos: f.state().todos.map((todo: any) => ({ id: todo.id, title: todo.title, instructions: todo.id === first.id ? ["Changed requirement."] : todo.instructions })),
		}, undefined, undefined, f.ctx);
		assert.deepEqual(f.state().todos[0].instructions, ["Implement first."]);
		assert.equal(f.state().planRevision, 1);
		await f.command("plan-approve");
		assert.deepEqual(f.state().todos[0].instructions, ["Changed requirement."]);
		assert.equal(f.state().todos[0].status, "design-editing");
		assert.equal(f.state().planRevision, 2);
		assert.equal(f.calls.length, 0);
	} finally { f.close(); }
});

test("plan acceptance preserves crash-left implementation before invalidating its checkpoint", async () => {
	const f = await fixture();
	try {
		await f.command("execute");
		await f.command("design-review");
		// Restore the persisted launch state without the worker's cleanup snapshots.
		const todo = f.state().todos[0];
		todo.designs[0].accepted = true;
		todo.designAccepted = 0;
		todo.status = "implementing";
		todo.revisions = [{ planRevision: 1, designIndex: 0, baselineTree: todo.designs[0].resultTree, changedFiles: [] }];
		todo.checkpoint = { role: "implementer", revisionIndex: 0 };
		writeFileSync(path.join(f.cwd, "partial.ts"), "export const partial = true;\n");
		await f.handlers.session_start({}, f.ctx);
		await f.command("replan");
		await f.tools.workflow_submit_plan.execute("id", {
			baseRevision: 1, affectedIds: [todo.id],
			todos: f.state().todos.map((item: any) => ({ id: item.id, title: item.title, instructions: item.instructions })),
		}, undefined, undefined, f.ctx);
		await f.command("plan-approve");
		assert.deepEqual(f.state().todos[0].revisions[0].changedFiles, ["partial.ts"]);
		await f.command("design-review");
		await f.command("design-approve");
		assert.match(f.calls.at(-1).task, /export const partial = true/);
	} finally { f.close(); }
});

test("rejecting an amendment retains the accepted plan", async () => {
	const f = await fixture();
	try {
		await f.command("execute");
		await f.command("replan");
		await f.command("plan-reject");
		assert.equal(f.state().planRevision, 1);
		assert.equal(f.state().amending, false);
		assert.equal(f.state().todos[0].status, "design-editing");
	} finally { f.close(); }
});

test("amendment planning uses the top-level conversation", async () => {
	const f = await fixture();
	try {
		await f.command("execute");
		await f.command("replan");
		const response = await f.handlers.before_agent_start({ systemPrompt: "Base", prompt: "Amend scope" }, f.ctx);
		assert.match(response.systemPrompt, /through this top-level conversation/);
		assert.match(response.systemPrompt, /baseRevision 1/);
		assert.equal(f.calls.length, 0);
	} finally { f.close(); }
});

test("replanning stops active agents and preserves their transcripts", async () => {
	const f = await fixture();
	try {
		await f.command("execute");
		await f.command("design-review");
		let started!: () => void;
		const ready = new Promise<void>((resolve) => started = resolve);
		f.controls.beforeRun = async (options) => {
			started();
			await new Promise<void>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true }));
		};
		const active = f.command("design-approve");
		await ready;
		await f.command("replan");
		await active;
		assert.equal(f.calls[0].signal.aborted, true);
		assert.equal(f.state().amending, true);
		assert.equal(f.state().todos[0].status, "interrupted");
		assert.ok(f.state().todos[0].sessions.implementer);
	} finally { f.close(); }
});

test("stale design feedback dialogues cannot restart a changed workflow", async () => {
	const f = await fixture();
	try {
		await f.command("execute");
		f.ctx.hasUI = true;
		let started!: () => void;
		const ready = new Promise<void>((resolve) => started = resolve);
		let answer!: (value: string) => void;
		f.ctx.ui.editor = () => { started(); return new Promise<string>((resolve) => answer = resolve); };
		const feedback = f.command("design-feedback");
		await ready;
		await f.command("replan");
		answer("Reconsider the design.");
		await feedback;
		assert.equal(f.calls.length, 0);
		assert.ok(f.notices.some((notice) => /changed while awaiting feedback/.test(notice)));
	} finally { f.close(); }
});
