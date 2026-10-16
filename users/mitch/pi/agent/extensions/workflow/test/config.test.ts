// Workflow-only settings and resolution of the shared global agents.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatWorkflowModels, loadWorkflowConfig, parseWorkflowConfig, resolveWorkflowAgents, workflowConfigPath } from "../config.ts";
import { discoverAgents, requireAgent } from "../../subagent/agents.ts";
import { writeTestAgent } from "../../subagent/test/agents.ts";

test("loads an absent workflow configuration with default settings", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "workflow-config-"));
	try { assert.deepEqual(await loadWorkflowConfig(root), {}); }
	finally { await rm(root, { recursive: true, force: true }); }
});

test("loads the configured automatic review limit", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "workflow-config-"));
	try {
		await mkdir(path.dirname(workflowConfigPath(root)), { recursive: true });
		await writeFile(workflowConfigPath(root), '{"max-review-cycles":4}');
		assert.deepEqual(await loadWorkflowConfig(root), { "max-review-cycles": 4 });
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("validates positive integer review limits", () => {
	for (const value of [0, -1, 1.5, "3", null, true, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(() => parseWorkflowConfig({ "max-review-cycles": value }), /positive safe integer/);
	}
	assert.deepEqual(parseWorkflowConfig({ "max-review-cycles": 1 }), { "max-review-cycles": 1 });
});

test("workflow and ad-hoc discovery resolve the same agent definitions", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "workflow-config-"));
	try {
		writeTestAgent(root, "implementer", { thinkingLevel: "low", "context-file-discovery": false });
		const reviewerFile = writeTestAgent(root, "reviewer", { thinkingLevel: "high" });
		const roles = resolveWorkflowAgents(root);
		assert.deepEqual(roles.implementer, requireAgent(discoverAgents(root), "implementer"));
		assert.equal(roles.implementer.contextFileDiscovery, false);
		assert.equal(formatWorkflowModels(roles), `implementer → implementer: test/impl (thinking: low) — ${path.join(root, "agents/implementer.md")}\nreviewer → reviewer: test/review (thinking: high) — ${reviewerFile}`);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("workflow requires an independently read-only reviewer", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "workflow-config-"));
	try {
		writeTestAgent(root, "implementer");
		writeTestAgent(root, "reviewer", { tools: ["read", "bash"] });
		assert.throws(() => resolveWorkflowAgents(root), /reviewer tools must remain read-only/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("loads configured role mappings from the workflow file", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "workflow-config-"));
	try {
		await mkdir(path.dirname(workflowConfigPath(root)), { recursive: true });
		await writeFile(workflowConfigPath(root), '{"agents":{"implementer":"worker","reviewer":"auditor"},"max-review-cycles":3}');
		assert.deepEqual(await loadWorkflowConfig(root), {
			agents: { implementer: "worker", reviewer: "auditor" }, "max-review-cycles": 3,
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("partial mappings retain the default agent for the other role", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "workflow-config-"));
	try {
		writeTestAgent(root, "worker");
		writeTestAgent(root, "reviewer");
		const roles = resolveWorkflowAgents(root, { agents: { implementer: "worker" } });
		assert.equal(roles.implementer.name, "worker");
		assert.equal(roles.reviewer.name, "reviewer");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("configured names resolve both workflow roles to shared definitions", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "workflow-config-"));
	try {
		writeTestAgent(root, "worker");
		writeTestAgent(root, "auditor", { tools: ["read"], model: "test/audit", thinkingLevel: "high" });
		const roles = resolveWorkflowAgents(root, { agents: { implementer: "worker", reviewer: "auditor" } });
		assert.equal(roles.implementer.name, "worker");
		assert.equal(roles.reviewer.name, "auditor");
		assert.match(formatWorkflowModels(roles), /reviewer → auditor: test\/audit \(thinking: high\)/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown configured agents produce a selection error", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "workflow-config-"));
	try {
		writeTestAgent(root, "implementer");
		writeTestAgent(root, "reviewer");
		assert.throws(() => resolveWorkflowAgents(root, { agents: { implementer: "missing" } }), /Unknown or invalid subagent "missing"/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("reviewer mappings preserve the workflow read-only boundary", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "workflow-config-"));
	try {
		writeTestAgent(root, "implementer");
		writeTestAgent(root, "worker");
		assert.throws(() => resolveWorkflowAgents(root, { agents: { reviewer: "worker" } }), /reviewer tools must remain read-only/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("agent mappings require an object with non-empty string selections", () => {
	for (const agents of [null, [], "worker", { implementer: 3 }, { reviewer: "" }, { reviewer: " " }]) {
		assert.throws(() => parseWorkflowConfig({ agents }), /Workflow agents/);
	}
});
