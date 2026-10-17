// Lifecycle tools exercise the real service and runner with deterministic subprocess peers.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { writeTestAgent } from "./agents.ts";

async function call(root: string, scenario: string, handle?: string) {
	const script = fileURLToPath(new URL("./fixtures/tool.ts", import.meta.url));
	const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", script, root, scenario, ...(handle ? [handle] : [])], { timeout: 15_000 });
	return JSON.parse(stdout);
}
async function invoke(scenario: string) {
	const root = await mkdtemp(path.join(os.tmpdir(), "subagent-tool-"));
	try {
		writeTestAgent(root, "reviewer", { model: "test/review", thinkingLevel: "high", "context-file-discovery": false });
		return await call(root, scenario);
	} finally { await rm(root, { recursive: true, force: true }); }
}

test("tool and programmatic runs share prompt, model and tool settings", async () => {
	const { outcome, persistent, updates } = await invoke("normal");
	assert.deepEqual(JSON.parse(outcome.structuredContent.output), {
		model: "test/review", thinking: "high", tools: "read,grep,find,ls", contextDiscovery: false, prompt: "# reviewer prompt",
	});
	assert.deepEqual(JSON.parse(persistent.output), {
		model: "test/review", thinking: "high", tools: "read,grep,find,ls", contextDiscovery: false,
		prompt: "# reviewer prompt\n\n---\n\nWorkflow assignment.",
	});
	assert.equal(updates[0], "Running read");
});

test("delegation returns a visible opaque handle with structured results", async () => {
	const { outcome } = await invoke("create");
	assert.match(outcome.structuredContent.handle, /^[a-f0-9-]{36}$/);
	assert.equal(outcome.content[0].text.startsWith(`Subagent handle: ${outcome.structuredContent.handle}\n`), true);
	assert.equal(outcome.details.handle, outcome.structuredContent.handle);
});

test("tool usage includes every child assistant turn", async () => {
	const { outcome } = await invoke("normal");
	assert.deepEqual(outcome.usage, {
		input: 20, output: 8, cacheRead: 4, cacheWrite: 2, totalTokens: 34,
		cost: { input: 0.2, output: 0.4, cacheRead: 0.02, cacheWrite: 0.04, total: 0.66 },
	});
});

test("bounded model output retains the handle and full results in details", async () => {
	const { outcome } = await invoke("large");
	assert.equal(Buffer.byteLength(outcome.content[0].text), 50 * 1024);
	assert.match(outcome.content[0].text, /^Subagent handle:/);
	assert.match(outcome.content[0].text, /Output truncated/);
	assert.equal(outcome.details.result.output.length, 60_000);
});

test("failed calls retain their handle, diagnostics, partial output and usage", async () => {
	const { outcome, conversations, transcript } = await invoke("failure");
	assert.equal(outcome.isError, true);
	assert.match(outcome.content[0].text, /model failure.*\n\npartial/);
	assert.equal(outcome.details.result.stderr, "child diagnostics");
	assert.equal(outcome.usage.input, 20);
	assert.equal(conversations[0].handle, outcome.structuredContent.handle);
	assert.equal(conversations[0].status, "failed");
	assert.match(transcript.diagnostics, /child diagnostics/);
});

test("shutdown stops active children while retaining interrupted conversations", async () => {
	const result = await invoke("cancel");
	assert.equal(result.shutdownComplete, true);
	assert.equal(result.outcome.isError, true);
	assert.equal(result.conversations.length, 1);
	assert.equal(result.conversations[0].status, "interrupted");
	assert.equal(result.outcome.details.result.stopReason, "aborted");
});

test("saved handles are discoverable and reusable after restarting the parent", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "subagent-restart-"));
	try {
		writeTestAgent(root, "reviewer");
		const created = await call(root, "create");
		const handle = created.outcome.structuredContent.handle;
		const listed = await call(root, "list");
		assert.equal(listed.structuredContent.conversations[0].handle, handle);
		const resumed = await call(root, "continue", handle);
		assert.equal(resumed.structuredContent.handle, handle);
		assert.equal(resumed.structuredContent.output, "remembered");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("creator deletion releases saved conversations explicitly and idempotently", async () => {
	const { deletion, repeated, listed } = await invoke("delete");
	assert.equal(deletion.structuredContent.deleted, true);
	assert.equal(repeated.structuredContent.deleted, false);
	assert.deepEqual(listed.structuredContent.conversations, []);
});

test("ad-hoc tools cannot reuse or delete workflow-owned handles", async () => {
	const { deletionError, reuseError, listed, parentCount } = await invoke("ownership");
	assert.match(deletionError, /another owner/);
	assert.match(reuseError, /another owner/);
	assert.equal(listed.structuredContent.conversations.length, 1);
	assert.equal(parentCount, 2);
});
