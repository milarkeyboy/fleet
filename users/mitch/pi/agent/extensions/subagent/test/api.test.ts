// The programmatic API applies shared definitions and caller-owned assignment context.
import assert from "node:assert/strict";
import test from "node:test";
import { runSubagent } from "../api.ts";
import type { AgentDefinition } from "../agents.ts";
import type { AgentRunOptions } from "../runner.ts";

const agent: AgentDefinition = {
	name: "reviewer", description: "Review", body: "Review carefully.",
	filePath: "/agents/reviewer.md", model: "test/reviewer", thinkingLevel: "high",
	tools: ["read", "grep"], contextFileDiscovery: false,
};

test("ad-hoc calls use shared settings with an ephemeral conversation", async () => {
	let received: AgentRunOptions | undefined;
	await runSubagent(agent, { cwd: "/repo", task: "Review auth." }, async (options) => {
		received = options;
		return { exitCode: 0, output: "Reviewed.", stderr: "", messages: [] };
	});
	assert.deepEqual(received, {
		cwd: "/repo", task: "Review auth.", roleName: "reviewer",
		systemPrompt: "Review carefully.", skillPaths: [],
		model: "test/reviewer", thinkingLevel: "high",
		tools: ["read", "grep"], contextFileDiscovery: false,
	});
});

test("workflow calls retain their supplied session, skills and assignment protocol", async () => {
	let received: AgentRunOptions | undefined;
	await runSubagent(agent, {
		cwd: "/repo", task: "Review todo 1.", sessionFile: "/sessions/reviewer.jsonl",
		skillPaths: ["/skills/cpp/SKILL.md"], instructions: "Return the workflow review protocol.",
	}, async (options) => {
		received = options;
		return { exitCode: 0, output: "Reviewed.", stderr: "", messages: [] };
	});
	assert.deepEqual(received, {
		cwd: "/repo", task: "Review todo 1.", sessionFile: "/sessions/reviewer.jsonl", roleName: "reviewer",
		systemPrompt: "Review carefully.\n\n---\n\nReturn the workflow review protocol.",
		skillPaths: ["/skills/cpp/SKILL.md"], model: "test/reviewer", thinkingLevel: "high",
		tools: ["read", "grep"], contextFileDiscovery: false,
	});
});
