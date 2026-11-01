// Real Pi loading verifies the restricted tool selection reaches the Git extension.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installedPi } from "../../subagent/test/pi.ts";

test("isolated reviewer sessions expose Git inspection alongside read/search tools", { skip: !installedPi() }, async () => {
	const api = await import(installedPi()!.api);
	const root = await mkdtemp(path.join(os.tmpdir(), "git-inspect-sdk-"));
	let session: any;
	try {
		execFileSync("git", ["init", "--quiet", root]);
		await writeFile(path.join(root, "untracked.txt"), "context\n");
		const settingsManager = api.SettingsManager.inMemory({ defaultTools: ["read", "grep", "find", "ls", "git_inspect"] });
		const loader = new api.DefaultResourceLoader({
			cwd: root, agentDir: root, settingsManager, noExtensions: true,
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		({ session } = await api.createAgentSession({
			cwd: root, resourceLoader: loader, settingsManager, sessionManager: api.SessionManager.inMemory(),
			modelRuntime: await api.ModelRuntime.create({ allowModelNetwork: false }),
		}));
		await session.bindExtensions({});
		assert.deepEqual(session.getActiveToolNames().sort(), ["find", "git_inspect", "grep", "ls", "read"]);
		const tool = session.agent.state.tools.find((tool: any) => tool.name === "git_inspect");
		const result = await tool.execute("test", { operation: "status" });
		assert.equal(result.content[0].text, "?? untracked.txt\n");
	} finally {
		session?.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
