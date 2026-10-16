// Ad-hoc tool and programmatic execution share the real runner; children emit deterministic events.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { writeTestAgent } from "./agents.ts";

async function invoke(scenario: string) {
	const root = await mkdtemp(path.join(os.tmpdir(), "subagent-tool-"));
	try {
		writeTestAgent(root, "reviewer", { model: "test/review", thinkingLevel: "high", "context-file-discovery": false });
		const script = fileURLToPath(new URL("./fixtures/tool.ts", import.meta.url));
		const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", script, root, scenario], { timeout: 15_000 });
		return JSON.parse(stdout);
	} finally { await rm(root, { recursive: true, force: true }); }
}

test("tool and programmatic runs share prompt, model and tool settings", async () => {
	const { outcome, persistent, updates } = await invoke("normal");
	assert.deepEqual(JSON.parse(outcome.content[0].text), {
		ephemeral: true, model: "test/review", thinking: "high",
		tools: "read,grep,find,ls", contextDiscovery: false, prompt: "# reviewer prompt",
	});
	assert.deepEqual(JSON.parse(persistent.output), {
		ephemeral: false, model: "test/review", thinking: "high",
		tools: "read,grep,find,ls", contextDiscovery: false,
		prompt: "# reviewer prompt\n\n---\n\nWorkflow assignment.",
	});
	assert.equal(updates[0], "Running read");
});

test("tool usage includes every child assistant turn", async () => {
	const { outcome } = await invoke("normal");
	assert.deepEqual(outcome.usage, {
		input: 20, output: 8, cacheRead: 4, cacheWrite: 2, totalTokens: 34,
		cost: { input: 0.2, output: 0.4, cacheRead: 0.02, cacheWrite: 0.04, total: 0.66 },
	});
});

test("model-facing output is bounded while tool details retain the full response", async () => {
	const { outcome } = await invoke("large");
	assert.equal(Buffer.byteLength(outcome.content[0].text), 50 * 1024);
	assert.equal(outcome.content[0].text.startsWith("x".repeat(100)), true);
	assert.match(outcome.content[0].text, /Output truncated/);
	assert.equal(outcome.details.output.length, 60_000);
});

test("failed child calls preserve diagnostics, partial output and usage", async () => {
	const { outcome } = await invoke("failure");
	assert.equal(outcome.isError, true);
	assert.match(outcome.content[0].text, /model failure.*\n\npartial/);
	assert.equal(outcome.details.stderr, "child diagnostics");
	assert.equal(outcome.usage.input, 20);
});

test("session shutdown aborts and awaits active ad-hoc children", async () => {
	const result = await invoke("cancel");
	assert.match(result.error, /AbortError/);
	assert.equal(result.shutdownComplete, true);
	assert.equal(result.updates[0], "Running read");
});
