import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatWorkflowModels, isProviderModel, loadWorkflowModelConfig, parseWorkflowModelConfig, requireExecutableWorkflowModels, setWorkflowRoleModel, workflowConfigPath } from "../config.ts";

test("sets role models in the global workflow config without discarding the other role", async () => {
	const temp = await mkdtemp(path.join(os.tmpdir(), "workflow-config-test-"));
	const agentDir = path.join(temp, "agent");
	try {
		await setWorkflowRoleModel("implementer", "openai/gpt-coder", "medium", agentDir);
		await setWorkflowRoleModel("reviewer", "openrouter/anthropic/claude-reviewer", "high", agentDir);
		await setWorkflowRoleModel("implementer", "openai/gpt-coder-2", undefined, agentDir);

		assert.deepEqual(await loadWorkflowModelConfig(agentDir), {
			implementer: { model: "openai/gpt-coder-2" },
			reviewer: { model: "openrouter/anthropic/claude-reviewer", thinkingLevel: "high" },
		});
		assert.deepEqual(await readdir(path.dirname(workflowConfigPath(agentDir))), ["config.json"]);
		assert.equal((await readFile(workflowConfigPath(agentDir), "utf8")).endsWith("\n"), true);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});

test("loads an absent workflow model config as unconfigured", async () => {
	const temp = await mkdtemp(path.join(os.tmpdir(), "workflow-config-test-"));
	try {
		assert.deepEqual(await loadWorkflowModelConfig(temp), {});
		assert.equal(formatWorkflowModels({}), "implementer: not configured\nreviewer: not configured");
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});

test("validates workflow role model configuration", () => {
	assert.equal(isProviderModel("openrouter/anthropic/claude"), true);
	assert.equal(isProviderModel("missing-provider"), false);
	assert.throws(() => parseWorkflowModelConfig({ implementer: { model: "openai/gpt", thinkingLevel: "extreme" } }), /thinking level/i);
	assert.throws(() => parseWorkflowModelConfig({ reviewer: { model: "missing-provider" } }), /provider\/model/);
});

test("requires both role models before resolving either role", async () => {
	let registryCalls = 0;
	const registry = {
		find() { registryCalls++; return undefined; },
		hasConfiguredAuth() { registryCalls++; return false; },
		async getApiKeyAndHeaders() { registryCalls++; return { ok: false as const, error: "missing" }; },
	};

	await assert.rejects(
		requireExecutableWorkflowModels({ implementer: { model: "openai/gpt" } }, registry as any),
		/explicit model configuration.*Missing: reviewer/i,
	);
	assert.equal(registryCalls, 0);
});

test("resolves configured role models and validates authentication", async () => {
	const models = new Map([
		["openai/gpt-coder", { provider: "openai", id: "gpt-coder" }],
		["openrouter/anthropic/claude-reviewer", { provider: "openrouter", id: "anthropic/claude-reviewer" }],
	]);
	const authenticated: string[] = [];
	const registry = {
		find(provider: string, modelId: string) { return models.get(`${provider}/${modelId}`); },
		hasConfiguredAuth() { return true; },
		async getApiKeyAndHeaders(model: { provider: string; id: string }) {
			authenticated.push(`${model.provider}/${model.id}`);
			return { ok: true as const, apiKey: "secret" };
		},
	};
	const config = {
		implementer: { model: "openai/gpt-coder", thinkingLevel: "high" as const },
		reviewer: { model: "openrouter/anthropic/claude-reviewer", thinkingLevel: "medium" as const },
	};

	assert.deepEqual(await requireExecutableWorkflowModels(config, registry as any), config);
	assert.deepEqual(authenticated, ["openai/gpt-coder", "openrouter/anthropic/claude-reviewer"]);
});

test("rejects top-level runtime-only api-key authentication unavailable to subprocesses", async () => {
	const config = {
		implementer: { model: "openai/gpt-coder" },
		reviewer: { model: "openai/gpt-reviewer" },
	};
	const find = (provider: string, id: string) => ({ provider, id });
	const topLevelRegistry = {
		find,
		hasConfiguredAuth() { return true; },
		async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "runtime-api-key" }; },
	};
	const subprocessRegistry = {
		find,
		hasConfiguredAuth() { return false; },
		async getApiKeyAndHeaders() { return { ok: false as const, error: "missing" }; },
	};

	assert.deepEqual(await requireExecutableWorkflowModels(config, topLevelRegistry as any), config);
	await assert.rejects(
		requireExecutableWorkflowModels(config, subprocessRegistry as any),
		/top-level --api-key overrides.*not inherited/i,
	);
});

test("rejects extension-registered models absent from no-extensions subprocesses", async () => {
	const config = {
		implementer: { model: "extension-provider/coder" },
		reviewer: { model: "openai/gpt-reviewer" },
	};
	const topLevelRegistry = {
		find(provider: string, id: string) { return { provider, id }; },
		hasConfiguredAuth() { return true; },
		async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "configured" }; },
	};
	const subprocessRegistry = {
		find(provider: string, id: string) {
			return provider === "openai" ? { provider, id } : undefined;
		},
		hasConfiguredAuth() { return true; },
		async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "configured" }; },
	};

	assert.deepEqual(await requireExecutableWorkflowModels(config, topLevelRegistry as any), config);
	await assert.rejects(
		requireExecutableWorkflowModels(config, subprocessRegistry as any),
		/--no-extensions.*extension-registered models cannot be used/i,
	);
});

test("rejects unavailable and unauthenticated role models", async () => {
	const config = {
		implementer: { model: "openai/gpt-coder" },
		reviewer: { model: "anthropic/claude-reviewer" },
	};
	const unavailable = {
		find() { return undefined; },
		hasConfiguredAuth() { return true; },
		async getApiKeyAndHeaders() { return { ok: true as const }; },
	};
	await assert.rejects(requireExecutableWorkflowModels(config, unavailable as any), /implementer model.*not available/i);

	const unauthenticated = {
		find(provider: string, id: string) { return { provider, id }; },
		hasConfiguredAuth() { return false; },
		async getApiKeyAndHeaders() { return { ok: true as const }; },
	};
	await assert.rejects(requireExecutableWorkflowModels(config, unauthenticated as any), /implementer model.*not authenticated/i);
});

test("rejects authentication resolution failures", async () => {
	const registry = {
		find(provider: string, id: string) { return { provider, id }; },
		hasConfiguredAuth() { return true; },
		async getApiKeyAndHeaders() { return { ok: false as const, error: "expired credential" }; },
	};
	await assert.rejects(requireExecutableWorkflowModels({
		implementer: { model: "openai/gpt-coder" },
		reviewer: { model: "anthropic/claude-reviewer" },
	}, registry as any), /authentication failed: expired credential/i);
});
