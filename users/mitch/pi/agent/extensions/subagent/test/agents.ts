// Global agent files shared by deterministic subagent and workflow fixtures.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function writeTestAgent(agentDir: string, name: string, overrides: Record<string, unknown> = {}): string {
	const directory = path.join(agentDir, "agents");
	mkdirSync(directory, { recursive: true });
	const file = path.join(directory, `${name}.md`);
	const config = {
		name, description: `${name} tasks`, model: name === "reviewer" ? "test/review" : "test/impl",
		tools: name === "reviewer" ? ["read", "grep", "find", "ls"] : ["read", "bash", "edit", "write"],
		...overrides,
	};
	writeFileSync(file, `---\n${JSON.stringify(config, null, 2)}\n---\n# ${name} prompt\n`);
	return file;
}
