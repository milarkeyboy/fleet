import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentArgs, extractProtocolJson } from "../runner.ts";

function options(skillPaths: string[]) {
	return {
		cwd: "/repo", roleName: "implementer", systemPrompt: "role", task: "todo", skillPaths, tools: ["read", "edit"], model: "openai/gpt-coder",
	};
}

test("subagent arguments isolate extensions, context, and selected skills", () => {
	const args = buildAgentArgs(options(["/skills/rust/SKILL.md", "/skills/testing/SKILL.md"]), "/tmp/role.md");
	assert.ok(args.includes("--no-extensions"));
	assert.ok(args.includes("--no-skills"));
	assert.ok(args.includes("--no-context-files"));
	assert.equal(args.filter((arg) => arg === "--skill").length, 2);
	assert.ok(args.includes("/skills/rust/SKILL.md"));
	assert.ok(args.includes("/skills/testing/SKILL.md"));
	assert.ok(!args.includes("/skills/python-development/SKILL.md"));
	assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "openai/gpt-coder"]);
});

test("untagged subagents can run without any Agent Skill", () => {
	const args = buildAgentArgs(options([]), "/tmp/role.md");
	assert.ok(args.includes("--no-skills"));
	assert.equal(args.includes("--skill"), false);
});

test("extracts structured handoff protocol", () => {
	const value = extractProtocolJson<{ verdict: string }>("notes\n<workflow-review>{\"verdict\":\"approve\"}</workflow-review>", "workflow-review");
	assert.equal(value.verdict, "approve");
});
