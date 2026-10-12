// Workflow configuration validation, persistence and isolated-model preflight.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatWorkflowModels, isProviderModel, loadWorkflowModelConfig, parseWorkflowModelConfig, requireExecutableWorkflowModels, setWorkflowRoleModel, workflowConfigPath, writeWorkflowModelConfig, WORKFLOW_ROLES } from "../config.ts";

const config = {
	implementer: { model: "test/impl", "context-file-discovery": false },
	"design-reviewer": { model: "test/design", "context-file-discovery": true },
	"code-reviewer": { model: "test/code", "context-file-discovery": false },
	"max-review-cycles": 3,
};
const registry = {
	find(provider: string, id: string) { return { provider, id }; },
	hasConfiguredAuth() { return true; },
	async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "secret" }; },
};

test("model updates preserve other role assignments and settings", async () => {
	const agentDir = await mkdtemp(path.join(os.tmpdir(), "workflow-config-"));
	try {
		await writeWorkflowModelConfig(config, agentDir);
		await setWorkflowRoleModel("implementer", "test/new-impl", "high", agentDir);
		assert.deepEqual(await loadWorkflowModelConfig(agentDir), { ...config, implementer: { model: "test/new-impl", thinkingLevel: "high", "context-file-discovery": false } });
		assert.deepEqual(await readdir(path.dirname(workflowConfigPath(agentDir))), ["config.json"]);
		assert.equal((await readFile(workflowConfigPath(agentDir), "utf8")).endsWith("\n"), true);
	} finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("an omitted thinking level clears the previous assignment", async () => {
	const agentDir = await mkdtemp(path.join(os.tmpdir(), "workflow-config-"));
	try {
		await setWorkflowRoleModel("design-reviewer", "test/design", "high", agentDir);
		await setWorkflowRoleModel("design-reviewer", "test/design", undefined, agentDir);
		assert.deepEqual(await loadWorkflowModelConfig(agentDir), { "design-reviewer": { model: "test/design" } });
	} finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("absent configuration reports all three unconfigured roles", async () => {
	const agentDir = await mkdtemp(path.join(os.tmpdir(), "workflow-config-"));
	try {
		assert.deepEqual(await loadWorkflowModelConfig(agentDir), {});
		assert.equal(formatWorkflowModels({}), "implementer: not configured\ndesign-reviewer: not configured\ncode-reviewer: not configured");
	} finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("role model identifiers and thinking levels are validated", () => {
	assert.equal(isProviderModel("openrouter/anthropic/claude"), true);
	assert.equal(isProviderModel("missing-provider"), false);
	assert.throws(() => parseWorkflowModelConfig({ implementer: { model: "test/impl", thinkingLevel: "extreme" } }), /thinking level/i);
	assert.throws(() => parseWorkflowModelConfig({ "design-reviewer": { model: "missing-provider" } }), /provider\/model/);
});

test("discovery settings and cycle maximum survive configuration parsing", () => {
	assert.deepEqual(parseWorkflowModelConfig(config), config);
});

test("each role rejects non-boolean discovery settings", () => {
	for (const role of WORKFLOW_ROLES) for (const value of [null, "false", 0, {}, []]) {
		assert.throws(() => parseWorkflowModelConfig({ [role]: { model: "test/model", "context-file-discovery": value } }), /context-file-discovery.*boolean/);
	}
});

test("cycle maxima must be positive safe integers", () => {
	for (const value of [0, -1, 1.5, "3", null, true, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(() => parseWorkflowModelConfig({ "max-review-cycles": value }), /max-review-cycles.*positive safe integer/);
	}
});

test("missing models fail before resolving any role", async () => {
	let calls = 0;
	await assert.rejects(requireExecutableWorkflowModels({ implementer: { model: "test/impl" } }, { ...registry, find() { calls++; return undefined; } } as any), /Missing: design-reviewer, code-reviewer/);
	assert.equal(calls, 0);
});

test("preflight authenticates every role and preserves settings", async () => {
	const authenticated: string[] = [];
	assert.deepEqual(await requireExecutableWorkflowModels(config, {
		...registry, async getApiKeyAndHeaders(model: any) { authenticated.push(model.id); return { ok: true, apiKey: "secret" }; },
	} as any), config);
	assert.deepEqual(authenticated, ["impl", "design", "code"]);
});

test("subprocess authentication requires inherited credentials", async () => {
	await assert.rejects(requireExecutableWorkflowModels(config, { ...registry, hasConfiguredAuth() { return false; } } as any), /top-level --api-key overrides.*not inherited/i);
});

test("subprocess preflight rejects unavailable extension-registered models", async () => {
	await assert.rejects(requireExecutableWorkflowModels(config, { ...registry, find() { return undefined; } } as any), /--no-extensions.*extension-registered models cannot be used/i);
});

test("authentication resolution failures are reported", async () => {
	await assert.rejects(requireExecutableWorkflowModels(config, { ...registry, async getApiKeyAndHeaders() { return { ok: false, error: "expired credential" }; } } as any), /authentication failed: expired credential/i);
});
