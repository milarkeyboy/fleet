// Real SDK loading verifies independently loaded extensions share lifecycle state and tool contracts.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getConversationService } from "../api.ts";
import { installedPi } from "./pi.ts";

async function fixture() {
	const api = await import(installedPi()!.api);
	const root = mkdtempSync(path.join(os.tmpdir(), "subagent-sdk-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	const settingsManager = api.SettingsManager.inMemory();
	const loader = new api.DefaultResourceLoader({
		cwd: root, agentDir: root, settingsManager, noExtensions: true,
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url)), fileURLToPath(new URL("../../workflow/index.ts", import.meta.url))],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await api.createAgentSession({
		cwd: root, resourceLoader: loader, settingsManager, sessionManager: api.SessionManager.inMemory(),
		modelRuntime: await api.ModelRuntime.create({ allowModelNetwork: false }),
	});
	await session.bindExtensions({});
	const service = getConversationService(path.join(root, "subagents"));
	const owner = { parentSessionId: session.sessionManager.getSessionId(), creator: "adhoc", cwd: root };
	return { api, session, service, owner, root,
		async close() {
			await session.extensionRunner.emit("session_shutdown", { type: "session_shutdown" });
			session.dispose();
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("real Pi registers both lifecycle tools and viewer controls", { skip: !installedPi() }, async () => {
	const f = await fixture();
	try {
		assert.ok(f.session.getActiveToolNames().includes("subagent"));
		assert.ok(f.session.getActiveToolNames().includes("subagent_list"));
		assert.ok(f.session.getActiveToolNames().includes("subagent_delete"));
		assert.ok(f.session.getActiveToolNames().includes("workflow_submit_plan"));
		assert.ok(f.session.extensionRunner.getRegisteredCommands().some((command: any) => command.name === "subagents"));
		assert.ok(f.session.extensionRunner.getShortcuts({}).has("ctrl+alt+a"));
	} finally { await f.close(); }
});

test("real Pi tool wrappers discover and delete only their creator's handles", { skip: !installedPi() }, async () => {
	const f = await fixture();
	try {
		const handle = f.service.create(f.owner, "Ad-hoc review");
		const workflow = f.service.create({ ...f.owner, creator: "workflow:one" }, "Workflow review");
		const tools = f.session.agent.state.tools;
		const list = tools.find((tool: any) => tool.name === "subagent_list")!;
		const remove = tools.find((tool: any) => tool.name === "subagent_delete")!;
		const listed = await list.execute("list", {});
		assert.deepEqual(listed.structuredContent.conversations.map((item: any) => item.handle), [handle]);
		const deleted = await remove.execute("delete", { handle });
		assert.deepEqual(deleted.structuredContent, { handle, deleted: true });
		assert.deepEqual(f.service.listParent(f.owner.parentSessionId).map(info => info.handle), [workflow]);
	} finally { await f.close(); }
});
