// Extension command and session-event integration, with Pi UI and model calls replaced by deterministic peers.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkflowOrchestrator } from "../orchestrator.ts";
import { createWorkflowTodos } from "../planner.ts";
import { cloneState, createWorkflowState, WORKFLOW_ENTRY_TYPE, type WorkflowState } from "../state.ts";

const modules: Record<string, string> = {
	"@earendil-works/pi-coding-agent": 'export const getAgentDir = () => globalThis.workflowTestAgentDir;',
	"@earendil-works/pi-tui": "export class Text {}",
	typebox: "export const Type = new Proxy({}, { get: () => (...args) => args });",
};
const loader = registerHooks({ resolve(name, context, next) {
	return name in modules ? { url: `data:text/javascript,${encodeURIComponent(modules[name])}`, shortCircuit: true } : next(name, context);
} });
const { default: extension } = await import("../index.ts");
loader.deregister();

// Keep command handling and orchestration real; replace only the external model boundary.
const exclusive = (WorkflowOrchestrator.prototype as any).runExclusive;
(WorkflowOrchestrator.prototype as any).runExclusive = function(ctx: any, ...args: any[]) {
	this.hooks.models = async () => ({ "design-reviewer": { model: "test/design" }, implementer: { model: "test/impl" }, "code-reviewer": { model: "test/review" } });
	this.hooks.runAgent = ctx.runAgent;
	return exclusive.call(this, ctx, ...args);
};

async function fixture(initial?: WorkflowState, initialTools = ["read", "bash", "edit", "write"]) {
	const root = mkdtempSync(path.join(os.tmpdir(), "workflow-extension-"));
	execFileSync("git", ["init", "-q", root]);
	(globalThis as any).workflowTestAgentDir = path.join(root, ".git", "agent");
	const state = initial ?? createWorkflowState();
	if (!initial) state.todos = createWorkflowTodos([{ title: "First", instructions: ["Implement first."] }, { title: "Second", instructions: ["Implement second."] }]);
	const entries: any[] = [{ id: "entry-1", type: "custom", customType: WORKFLOW_ENTRY_TYPE, data: cloneState(state) }];
	let branch = entries;
	const handlers: Record<string, any> = {}, commands: Record<string, any> = {}, tools: Record<string, any> = {};
	const notices: string[] = [], calls: any[] = [];
	let activeTools = [...initialTools];
	const pi = {
		registerMessageRenderer() {}, registerFlag() {}, getFlag: () => false,
		registerCommand: (name: string, command: any) => commands[name] = command.handler,
		registerTool: (tool: any) => tools[tool.name] = tool,
		on: (name: string, handler: any) => handlers[name] = handler,
		getActiveTools: () => activeTools, setActiveTools: (value: string[]) => activeTools = value,
		appendEntry(customType: string, data: any) {
			const entry = { id: `entry-${entries.length + 1}`, type: "custom", customType, data };
			entries.push(entry);
			if (branch !== entries) branch.push(entry);
		}, sendMessage() {},
	};
	const ctx: any = {
		cwd: root, hasUI: false, isProjectTrusted: () => false,
		sessionManager: { getSessionId: () => "parent", getEntries: () => entries, getBranch: () => branch },
		ui: { notify: (text: string) => notices.push(text), setStatus() {}, setWidget() {}, theme: { fg: (_colour: string, text: string) => text } },
		runAgent: async (options: any) => {
			calls.push(options);
			appendFileSync(options.sessionFile, `${JSON.stringify({ type: "message", message: { role: "user", content: options.task } })}\n`);
			await control.beforeRun(options);
			return { exitCode: 0, stderr: "", messages: [], output: options.roleName === "workflow-implementer"
				? '<workflow-implementation>{"status":"completed","summary":"done","filesChanged":[],"tests":[]}</workflow-implementation>'
				: '<workflow-review>{"verdict":"approve","summary":"ready","findings":[]}</workflow-review>' };
		},
	};
	const control = { beforeRun: async (_options: any) => {} };
	extension(pi as any);
	await handlers.session_start({}, ctx);
	return { root, ctx, handlers, commands, tools, entries, notices, calls, control,
		getActiveTools: pi.getActiveTools, setActiveTools: pi.setActiveTools,
		command: (args: string) => commands.workflow(args, ctx), state: () => entries.at(-1).data as WorkflowState,
		restart: async () => { extension(pi as any); await handlers.session_start({}, ctx); },
		branch: (value: any[]) => { branch = value; }, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("planning retains active MCP gateways, direct tools and resource tools", async () => {
	const f = await fixture(undefined, ["read", "edit", "write", "codemode", "tool_search", "mcp__jira__get_issue", "mcp__jira__update_issue", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
	try {
		await f.command("on");
		assert.deepEqual(f.getActiveTools(), [
			"read", "bash", "grep", "find", "ls", "download_file", "questionnaire", "workflow_submit_plan",
			"codemode", "tool_search", "mcp__jira__get_issue", "mcp__jira__update_issue",
			"list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
		]);
	} finally { f.close(); }
});

test("planning makes temporary downloads available without enabling local write tools", async () => {
	const f = await fixture();
	try {
		await f.command("on");
		assert.equal(f.getActiveTools().includes("download_file"), true);
		assert.equal(await f.handlers.tool_call({ toolName: "download_file", input: { url: "https://example.com/image" } }, f.ctx), undefined);
		assert.equal(f.getActiveTools().includes("edit"), false);
		assert.equal(f.getActiveTools().includes("write"), false);
	} finally { f.close(); }
});

test("resumed planning recovers MCP access from the saved pre-planning tool set", async () => {
	const state = createWorkflowState();
	state.planning = true;
	state.toolsBeforePlanning = ["read", "edit", "codemode", "mcp__jira__get_issue"];
	const f = await fixture(state, ["read", "bash"]);
	try {
		assert.equal(f.getActiveTools().includes("codemode"), true);
		assert.equal(f.getActiveTools().includes("mcp__jira__get_issue"), true);
		assert.equal(f.getActiveTools().includes("edit"), false);
	} finally { f.close(); }
});

test("re-entering planning retains MCP tools discovered after planning began", async () => {
	const f = await fixture(undefined, ["read", "codemode"]);
	try {
		await f.command("on");
		f.setActiveTools([...f.getActiveTools(), "mcp__jira__get_issue"]);
		await f.command("on");
		assert.equal(f.getActiveTools().includes("mcp__jira__get_issue"), true);
		assert.equal(f.getActiveTools().filter((name) => name === "codemode").length, 1);
	} finally { f.close(); }
});

for (const command of ["off", "clear"]) {
	test(`${command} restores the pre-planning tools including MCP access`, async () => {
		const f = await fixture(undefined, ["read", "bash", "edit", "write", "codemode", "mcp__jira__get_issue"]);
		try {
			await f.command("on");
			await f.command(command);
			assert.deepEqual(f.getActiveTools(), ["read", "bash", "edit", "write", "codemode", "mcp__jira__get_issue"]);
		} finally { f.close(); }
	});
}

test("planning permits MCP reads and writes both directly and through codemode", async () => {
	const f = await fixture(undefined, ["read", "codemode"]);
	try {
		await f.command("on");
		for (const toolName of ["codemode", "tool_search", "mcp__jira__get_issue", "mcp__jira__update_issue"]) {
			for (const parentToolCallId of [undefined, "codemode-call"]) {
				assert.equal(await f.handlers.tool_call({ toolName, input: {}, parentToolCallId }, f.ctx), undefined);
			}
		}
	} finally { f.close(); }
});

test("planning still blocks local writes and unsafe Bash calls made through codemode", async () => {
	const f = await fixture(undefined, ["read", "bash", "edit", "write", "codemode"]);
	try {
		await f.command("on");
		for (const parentToolCallId of [undefined, "codemode-call"]) {
			for (const toolName of ["edit", "write"]) {
				assert.equal((await f.handlers.tool_call({ toolName, input: {}, parentToolCallId }, f.ctx))?.block, true);
			}
			assert.equal((await f.handlers.tool_call({ toolName: "bash", input: { command: "touch changed.txt" }, parentToolCallId }, f.ctx))?.block, true);
			assert.equal(await f.handlers.tool_call({ toolName: "bash", input: { command: "git status" }, parentToolCallId }, f.ctx), undefined);
		}
	} finally { f.close(); }
});

// Execution integration starts at a human design-acceptance checkpoint.
async function codeFixture() {
	const f = await fixture();
	await f.command("execute");
	await f.command("design-review");
	return f;
}

for (const command of ["abort", "clear"] as const) {
	test(`${command} stops workers before deleting their transcripts`, async () => {
		const f = await codeFixture();
		try {
			let entered!: () => void;
			const active = new Promise<void>((resolve) => { entered = resolve; });
			f.control.beforeRun = async (options) => {
				entered();
				await new Promise<void>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
			};
			const execution = f.command("design-approve");
			await active;
			await f.command(command);
			await execution;
			assert.equal(f.calls.length, 1);
			assert.equal(f.calls[0].signal.aborted, true);
			assert.equal(existsSync(f.calls[0].sessionFile), false);
			if (command === "clear") assert.deepEqual(f.state().todos, []);
			else assert.equal(f.state().todos[0].status, "aborted");
		} finally { f.close(); }
	});
}

test("shutdown stops workers but retains unfinished conversations", async () => {
	const f = await codeFixture();
	try {
		let entered!: () => void;
		const active = new Promise<void>((resolve) => { entered = resolve; });
		f.control.beforeRun = async (options) => {
			entered();
			await new Promise<void>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
		};
		const execution = f.command("design-approve");
		await active;
		await f.handlers.session_shutdown({}, f.ctx);
		await execution;
		assert.equal(f.calls.length, 1);
		assert.equal(f.state().todos[0].status, "interrupted");
		assert.equal(existsSync(f.calls[0].sessionFile), true);
	} finally { f.close(); }
});

test("restart after shutdown waits for an explicit command and reuses the interrupted session", async () => {
	const f = await codeFixture();
	try {
		let entered!: () => void;
		const active = new Promise<void>((resolve) => { entered = resolve; });
		f.control.beforeRun = async (options) => {
			entered();
			await new Promise<void>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
		};
		const execution = f.command("design-approve");
		await active;
		await f.handlers.session_shutdown({}, f.ctx);
		await execution;
		f.control.beforeRun = async () => {};
		await f.restart();
		assert.equal(f.calls.length, 1);
		assert.equal(f.state().todos[0].status, "interrupted");
		await f.command("resume");
		assert.equal(f.calls.length, 3);
		assert.equal(f.calls[0].sessionFile, f.calls[1].sessionFile);
		assert.equal(f.state().todos[0].status, "awaiting-user");
	} finally { f.close(); }
});

test("restart finishes a persisted discard without resuming any worker", async () => {
	const f = await codeFixture();
	try {
		await f.command("design-approve");
		const file = f.calls[0].sessionFile;
		f.state().discarding = true;
		await f.restart();
		assert.deepEqual(f.state().todos, []);
		assert.equal(f.calls.length, 2);
		assert.equal(existsSync(file), false);
	} finally { f.close(); }
});

test("restart completes transcript cleanup after a persisted approval", async () => {
	const f = await codeFixture();
	try {
		await f.command("design-approve");
		const file = f.calls[0].sessionFile;
		f.state().todos[0].status = "approved";
		await f.restart();
		assert.equal(f.calls.length, 2);
		assert.equal(f.state().todos[0].status, "approved");
		assert.equal(f.state().todos[0].sessions, undefined);
		assert.equal(existsSync(file), false);
	} finally { f.close(); }
});

test("approval deletes the completed todo's sessions before starting the next", async () => {
	const f = await codeFixture();
	try {
		await f.command("design-approve");
		const files = f.calls.map((call) => call.sessionFile);
		await f.command("approve");
		assert.equal(f.state().todos[0].status, "approved");
		assert.equal(f.state().todos[1].status, "design-editing");
		assert.equal(existsSync(files[0]), false);
		assert.equal(existsSync(files[1]), false);
		assert.equal(f.calls.length, 2);
	} finally { f.close(); }
});

test("feedback from a cleared todo cannot restart work through a stale editor", async () => {
	const f = await codeFixture();
	try {
		await f.command("design-approve");
		f.ctx.hasUI = true;
		let entered!: () => void;
		const active = new Promise<void>((resolve) => { entered = resolve; });
		let answer!: (value: string) => void;
		f.ctx.ui.editor = () => { entered(); return new Promise<string>((resolve) => { answer = resolve; }); };
		const feedback = f.command("feedback");
		await active;
		await f.command("clear");
		answer("Change the label.");
		await feedback;
		assert.equal(f.calls.length, 2);
		assert.deepEqual(f.state().todos, []);
		assert.ok(f.notices.some((notice) => notice.includes("changed while awaiting feedback")));
	} finally { f.close(); }
});

test("a stale plan dialog cannot replace a newly cleared workflow", async () => {
	const f = await fixture();
	try {
		await f.command("on");
		f.ctx.hasUI = true;
		let entered!: () => void;
		const active = new Promise<void>((resolve) => { entered = resolve; });
		let answer!: (value: string) => void;
		f.ctx.ui.select = () => { entered(); return new Promise<string>((resolve) => { answer = resolve; }); };
		const submitted = f.tools.workflow_submit_plan.execute("id", { todos: [{ title: "Old dialog", instructions: ["Implement."], primarySkill: "unknown-test-skill" }] }, undefined, undefined, f.ctx);
		const rejected = assert.rejects(submitted, /changed while awaiting plan input/);
		await active;
		await f.command("clear");
		answer("No primary skill");
		await rejected;
		assert.deepEqual(f.state().todos, []);
	} finally { f.close(); }
});

test("navigating into a divergent history requires replanning without deleting its sessions", async () => {
	const f = await codeFixture();
	try {
		await f.command("design-approve");
		const file = f.calls[0].sessionFile;
		await f.handlers.session_before_tree({}, f.ctx);
		f.branch([f.entries[0]]);
		await f.handlers.session_tree({}, f.ctx);
		assert.deepEqual(f.state().todos, []);
		assert.equal(f.state().planning, true);
		assert.ok(f.notices.some((notice) => notice.includes("history diverged")));
		await f.command("clear");
		assert.equal(existsSync(file), true);
	} finally { f.close(); }
});

test("forked parents cannot resume or clear the original role conversations", async () => {
	const f = await codeFixture();
	try {
		await f.command("design-approve");
		const file = f.calls[0].sessionFile;
		f.ctx.sessionManager.getSessionId = () => "fork";
		await f.handlers.session_start({}, f.ctx);
		assert.deepEqual(f.state().todos, []);
		assert.ok(f.notices.some((notice) => notice.includes("another parent session")));
		await f.command("clear");
		assert.equal(existsSync(file), true);
	} finally { f.close(); }
});

test("forced manual completion deletes skipped transcripts", async () => {
	const f = await codeFixture();
	try {
		await f.command("design-approve");
		const file = f.calls[0].sessionFile;
		await f.command("execute 2");
		assert.equal(f.state().todos[0].status, "completed-manually");
		assert.equal(f.state().todos[1].status, "design-editing");
		assert.equal(existsSync(file), false);
	} finally { f.close(); }
});

test("clear can discard a workflow whose session directory has gone missing", async () => {
	const f = await codeFixture();
	try {
		await f.command("design-approve");
		rmSync(path.dirname(f.calls[0].sessionFile), { recursive: true });
		await f.command("clear");
		assert.deepEqual(f.state().todos, []);
		assert.ok(f.notices.includes("Workflow state cleared."));
	} finally { f.close(); }
});

test("plan amendments preserve established role sessions", async () => {
	const f = await codeFixture();
	try {
		await f.command("design-approve");
		const oldId = f.state().id;
		await f.command("replan");
		await f.tools.workflow_submit_plan.execute("id", { baseRevision: 1, affectedIds: [], todos: f.state().todos.map((todo: any) => ({ id: todo.id, title: todo.title, instructions: todo.instructions })) }, undefined, undefined, f.ctx);
		await f.command("plan-approve");
		assert.equal(f.state().id, oldId);
		assert.equal(existsSync(f.calls[0].sessionFile), true);
		assert.equal(existsSync(f.calls[1].sessionFile), true);
	} finally { f.close(); }
});
