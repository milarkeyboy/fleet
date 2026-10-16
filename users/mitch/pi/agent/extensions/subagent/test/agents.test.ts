// Global Markdown definition parsing and discovery diagnostics.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverAgents, parseAgent, requireAgent } from "../agents.ts";
import { writeTestAgent } from "./agents.ts";

const markdown = `---
name: reviewer
description: >
  Review supplied changes.
model: openrouter/anthropic/claude
thinkingLevel: high
tools: [read, grep]
context-file-discovery: false
---
Review carefully.
`;

test("parses YAML settings and the prompt as one agent definition", () => {
	assert.deepEqual(parseAgent(markdown, "/agents/reviewer.md"), {
		name: "reviewer", description: "Review supplied changes.\n",
		model: "openrouter/anthropic/claude", thinkingLevel: "high",
		tools: ["read", "grep"], contextFileDiscovery: false,
		body: "Review carefully.", filePath: "/agents/reviewer.md",
	});
});

test("accepts comma-separated tool names", () => {
	assert.deepEqual(parseAgent(markdown.replace("[read, grep]", "read, grep"), "/agents/reviewer.md").tools, ["read", "grep"]);
});

test("requires a fully qualified model assignment", () => {
	assert.throws(() => parseAgent(markdown.replace("openrouter/anthropic/claude", "claude"), "/agents/reviewer.md"), /explicit provider\/model/);
});

test("validates thinking levels", () => {
	assert.throws(() => parseAgent(markdown.replace("high", "extreme"), "/agents/reviewer.md"), /thinkingLevel/);
});

test("validates tool names available in isolated subprocesses", () => {
	assert.throws(() => parseAgent(markdown.replace("[read, grep]", "[read, nonexistent]"), "/agents/reviewer.md"), /tools must be/);
});

test("validates boolean context discovery settings", () => {
	assert.throws(() => parseAgent(markdown.replace("false", '"false"'), "/agents/reviewer.md"), /must be a boolean/);
});

test("identifies an agent by its matching filename and declared name", () => {
	assert.throws(() => parseAgent(markdown, "/agents/other.md"), /name must match/);
});

test("discovery retains valid agents and reports invalid definitions", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "subagent-definitions-"));
	try {
		writeTestAgent(root, "reviewer");
		await writeFile(path.join(root, "agents/broken.md"), "---\nname: broken\n---\nPrompt");
		const found = discoverAgents(root);
		assert.deepEqual(Object.keys(found.agents), ["reviewer"]);
		assert.match(found.diagnostics[0], /broken.md: description/);
		assert.throws(() => requireAgent(found, "broken"), /Unknown or invalid subagent "broken".*\n.*broken.md: description/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a missing definition directory produces an actionable selection error", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "subagent-definitions-"));
	try { assert.throws(() => requireAgent(discoverAgents(root), "reviewer"), /agents\/reviewer.md/); }
	finally { await rm(root, { recursive: true, force: true }); }
});
