import assert from "node:assert/strict";
import test from "node:test";
import { BASH_POLICY_EXTENSION_PATH, buildAgentArgs, extractProtocolJson } from "../runner.ts";

function options(skillPaths: string[]) {
	return {
		cwd: "/repo", roleName: "implementer", systemPrompt: "role", task: "todo", skillPaths, tools: ["read", "edit"], model: "openai/gpt-coder",
	};
}

test("subagent arguments isolate extensions and skills while loading context files", () => {
	const args = buildAgentArgs(options(["/skills/rust/SKILL.md", "/skills/testing/SKILL.md"]), "/tmp/role.md");
	assert.ok(args.includes("--no-extensions"));
	assert.deepEqual(args.slice(args.indexOf("-e"), args.indexOf("-e") + 2), ["-e", BASH_POLICY_EXTENSION_PATH]);
	assert.equal(args.filter((arg) => arg === "-e").length, 1);
	assert.ok(args.includes("--no-skills"));
	assert.equal(args.includes("--no-context-files"), false);
	assert.equal(args.filter((arg) => arg === "--skill").length, 2);
	assert.ok(args.includes("/skills/rust/SKILL.md"));
	assert.ok(args.includes("/skills/testing/SKILL.md"));
	assert.ok(!args.includes("/skills/python/SKILL.md"));
	assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "openai/gpt-coder"]);
});

test("untagged subagents can run without any Agent Skill", () => {
	const args = buildAgentArgs(options([]), "/tmp/role.md");
	assert.ok(args.includes("--no-skills"));
	assert.equal(args.includes("--skill"), false);
});

test("subagents load the bash policy and no discovered extensions", () => {
	const args = buildAgentArgs(options([]), "/tmp/role.md");
	assert.deepEqual(args.filter((arg) => arg === "-e" || arg.endsWith("/bash-policy/index.ts")), ["-e", BASH_POLICY_EXTENSION_PATH]);
	assert.equal(args.some((arg) => arg.endsWith("/gondolin/index.ts")), false);
});

test("extracts structured handoff protocol", () => {
	const value = extractProtocolJson<{ verdict: string }>("notes\n<workflow-review>{\"verdict\":\"approve\"}</workflow-review>", "workflow-review");
	assert.equal(value.verdict, "approve");
});
