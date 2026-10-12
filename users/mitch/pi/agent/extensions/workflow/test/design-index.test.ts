// Phase-specific commands and top-level conversational planning with deterministic peers.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkflowOrchestrator } from "../orchestrator.ts";
import { createWorkflowTodos } from "../planner.ts";
import { cloneState, createWorkflowState, WORKFLOW_ENTRY_TYPE } from "../state.ts";

const modules: Record<string, string> = {
	"@earendil-works/pi-coding-agent": "export const getAgentDir = () => globalThis.workflowTestAgentDir;",
	"@earendil-works/pi-tui": "export class Text {}",
	typebox: "export const Type = new Proxy({}, { get: () => (...args) => args });",
};
const loader = registerHooks({ resolve(name, context, next) {
	return name in modules ? { url: `data:text/javascript,${encodeURIComponent(modules[name])}`, shortCircuit: true } : next(name, context);
} });
const { default: extension } = await import("../index.ts");
loader.deregister();
const exclusive = (WorkflowOrchestrator.prototype as any).runExclusive;
(WorkflowOrchestrator.prototype as any).runExclusive = function(ctx: any, ...args: any[]) {
	this.hooks.models = async () => ({ implementer: { model: "test/impl" }, "design-reviewer": { model: "test/design" }, "code-reviewer": { model: "test/code" } });
	this.hooks.runAgent = ctx.runAgent;
	return exclusive.call(this, ctx, ...args);
};

async function fixture() {
	const root = mkdtempSync(path.join(os.tmpdir(), "workflow-design-commands-"));
	const cwd = path.join(root, "work");
	execFileSync("git", ["init", "-q", cwd]);
	(globalThis as any).workflowTestAgentDir = path.join(root, "agent");
	const state = createWorkflowState();
	state.todos = createWorkflowTodos([{ title: "First", instructions: ["Implement first."] }, { title: "Second", instructions: ["Implement second."] }]);
	const entries: any[] = [{ id: "initial", type: "custom", customType: WORKFLOW_ENTRY_TYPE, data: cloneState(state) }];
	const handlers: Record<string, any> = {}, tools: Record<string, any> = {};
	let command: any;
	let activeTools = ["read", "bash", "edit", "write"];
	const notices: string[] = [], calls: any[] = [], messages: any[] = [];
	const controls = { beforeRun: async (_options: any) => {} };
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
			appendFileSync(options.sessionFile, `${JSON.stringify({ type: "message", message: { role: "user", content: options.task } })}\n`);
			await controls.beforeRun(options);
			return { exitCode: 0, stderr: "", messages: [], output: options.roleName === "workflow-implementer"
				? '<workflow-implementation>{"status":"completed","summary":"Done","filesChanged":[],"tests":[]}</workflow-implementation>'
				: '<workflow-review>{"verdict":"approve","summary":"Ready","findings":[]}</workflow-review>' };
		},
	};
	extension(pi);
	await handlers.session_start({}, ctx);
	return { cwd, ctx, entries, tools, handlers, calls, messages, notices, controls, command: (args: string) => command(args, ctx), state: () => entries.at(-1).data, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("design commands require acceptance before implementation", async () => {
	const f = await fixture();
	try {
		await f.command("execute");
		await f.command("design-review");
		assert.equal(f.state().todos[0].status, "awaiting-design");
		assert.equal(f.calls.length, 0);
		await f.command("design-approve");
		assert.deepEqual(f.calls.map((call) => call.roleName), ["workflow-implementer", "workflow-code-reviewer"]);
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

test("design feedback reaches only the design reviewer", async () => {
	const f = await fixture();
	try {
		await f.command("execute");
		writeFileSync(path.join(f.cwd, "design.md"), "Contract\n");
		await f.command("design-feedback Check testability.");
		assert.equal(f.calls[0].roleName, "workflow-design-reviewer");
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
