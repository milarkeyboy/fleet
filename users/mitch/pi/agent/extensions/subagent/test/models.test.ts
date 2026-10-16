// Model availability and authentication are checked against subprocess-visible configuration.
import assert from "node:assert/strict";
import test from "node:test";
import { requireExecutableAgents } from "../models.ts";
import type { AgentDefinition } from "../agents.ts";

const agent: AgentDefinition = { name: "reviewer", description: "Review.", model: "openrouter/anthropic/reviewer", tools: ["read"], body: "Review.", filePath: "/agents/reviewer.md" };

test("resolves provider/model assignments and validates configured credentials", async () => {
	const calls: string[] = [];
	await requireExecutableAgents([agent], {
		find(provider: string, id: string) { calls.push(`${provider}/${id}`); return { provider, id }; },
		hasConfiguredAuth() { return true; },
		async getApiKeyAndHeaders() { calls.push("authenticated"); return { ok: true, apiKey: "configured" }; },
	} as any);
	assert.deepEqual(calls, ["openrouter/anthropic/reviewer", "authenticated"]);
});

test("reports models unavailable to isolated subprocesses", async () => {
	await assert.rejects(requireExecutableAgents([agent], {
		find() { return undefined; },
	} as any), /reviewer model.*not available.*--no-extensions/);
});

test("reports credentials unavailable to isolated subprocesses", async () => {
	await assert.rejects(requireExecutableAgents([agent], {
		find() { return {}; }, hasConfiguredAuth() { return false; },
	} as any), /not authenticated.*--api-key overrides.*not inherited/);
});

test("reports credential resolution failures", async () => {
	await assert.rejects(requireExecutableAgents([agent], {
		find() { return {}; }, hasConfiguredAuth() { return true; },
		async getApiKeyAndHeaders() { return { ok: false, error: "expired credential" }; },
	} as any), /authentication failed: expired credential/);
});
