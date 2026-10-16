// The standalone plan-mode extension guards direct and nested delegation.
import assert from "node:assert/strict";
import test from "node:test";
import planMode from "../../plan-mode/index.ts";

function fixture() {
	let activeTools = ["read", "bash", "edit", "write", "subagent", "codemode"];
	const handlers: Record<string, any> = {}, commands: Record<string, any> = {};
	planMode({
		registerFlag() {}, registerShortcut() {}, appendEntry() {},
		registerCommand(name: string, command: any) { commands[name] = command.handler; },
		on(name: string, handler: any) { handlers[name] = handler; },
		getActiveTools() { return activeTools; }, setActiveTools(tools: string[]) { activeTools = tools; },
	} as any);
	const ctx = { ui: { notify() {}, setWidget() {}, setStatus() {}, theme: { fg(_colour: string, text: string) { return text; } } } };
	return { handlers, command: (args: string) => commands.plan(args, ctx), activeTools: () => activeTools };
}

test("planning blocks both direct and codemode subagent calls", async () => {
	const f = fixture();
	await f.command("on");
	assert.equal(f.activeTools().includes("subagent"), false);
	for (const parentToolCallId of [undefined, "codemode-call"]) {
		assert.equal((await f.handlers.tool_call({ toolName: "subagent", input: { agent: "reviewer", task: "Review." }, parentToolCallId }))?.block, true);
	}
});

test("leaving planning restores ad-hoc delegation", async () => {
	const f = fixture();
	await f.command("on");
	await f.command("off");
	assert.equal(f.activeTools().includes("subagent"), true);
	assert.equal(await f.handlers.tool_call({ toolName: "subagent", input: {} }), undefined);
});
