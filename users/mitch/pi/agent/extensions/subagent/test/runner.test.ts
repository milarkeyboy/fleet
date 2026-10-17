// Subprocess arguments, persisted conversation transport, and cancellation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BASH_POLICY_EXTENSION_PATH, buildAgentArgs } from "../runner.ts";

function options(skillPaths: string[]) {
	return {
		cwd: "/repo", roleName: "implementer", sessionFile: "/sessions/implementer.jsonl", systemPrompt: "role", task: "todo", skillPaths, tools: ["read", "edit"], model: "openai/gpt-coder",
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

test("disabled discovery emits Pi's no-context-files switch once", () => {
	const args = buildAgentArgs({ ...options([]), contextFileDiscovery: false }, "/tmp/role.md");
	assert.equal(args.filter((arg) => arg === "--no-context-files").length, 1);
});

test("explicitly enabled discovery retains Pi's normal context loading", () => {
	const args = buildAgentArgs({ ...options([]), contextFileDiscovery: true }, "/tmp/role.md");
	assert.equal(args.includes("--no-context-files"), false);
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

test("omitted thinking levels explicitly reset resumed sessions to off", () => {
	const args = buildAgentArgs(options([]), "/tmp/role.md");
	assert.deepEqual(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2), ["--thinking", "off"]);
});

test("subagents explicitly reopen their assigned session", () => {
	const args = buildAgentArgs(options([]), "/tmp/role.md");
	assert.deepEqual(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2), ["--session", "/sessions/implementer.jsonl"]);
});

function subprocess(file: string, task: string) {
	const script = fileURLToPath(new URL("./fixtures/runner.ts", import.meta.url));
	return JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", script, file, task], { encoding: "utf8" }));
}

test("separate subprocess invocations reuse the same persisted conversation", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "workflow-runner-"));
	try {
		const file = path.join(dir, "session.jsonl");
		writeFileSync(file, '{"type":"session"}\n');
		assert.deepEqual(subprocess(file, "remember-this"), { ok: true, output: "first run", listeners: 0 });
		assert.deepEqual(subprocess(file, "recall"), { ok: true, output: "remembered", listeners: 0 });
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an aborted final response is unsuccessful even with exit code zero", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "workflow-runner-"));
	try {
		const file = path.join(dir, "session.jsonl");
		writeFileSync(file, '{"type":"session"}\n');
		const result = subprocess(file, "aborted");
		assert.equal(result.ok, false);
		assert.equal(result.listeners, 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cancelling a subprocess waits for exit and removes its abort listener", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "workflow-runner-"));
	try {
		const file = path.join(dir, "session.jsonl");
		writeFileSync(file, '{"type":"session"}\n');
		const result = subprocess(file, "cancel");
		assert.equal(result.ok, false);
		assert.equal(result.listeners, 0);
		assert.equal(result.result.stopReason, "aborted");
		assert.equal(result.processes[0], 0);
		assert.ok(result.processes[1] > 0);
		assert.equal(result.processes.at(-1), null);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const outcome of ["non-zero", "model-error", "length"]) {
	test(`${outcome} failures preserve partial output and usage`, () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "subagent-runner-"));
		try {
			const file = path.join(dir, "session.jsonl");
			writeFileSync(file, '{"type":"session"}\n');
			const response = subprocess(file, outcome);
			assert.equal(response.ok, false);
			assert.equal(response.result.output, "first run");
			assert.equal(response.result.usage.totalTokens, 5);
			assert.equal(response.result.usage.reasoning, 1);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
}

test("compaction usage contributes to the child token and cost totals", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "subagent-runner-"));
	try {
		const file = path.join(dir, "session.jsonl");
		writeFileSync(file, '{"type":"session"}\n');
		const response = subprocess(file, "compaction");
		assert.equal(response.result.usage.input, 10);
		assert.equal(response.result.usage.output, 5);
		assert.equal(response.result.usage.totalTokens, 15);
		assert.equal(response.result.usage.cost.total, 0.3);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("interrupted streams retain delta output and cumulative usage", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "subagent-runner-"));
	try {
		const file = path.join(dir, "session.jsonl");
		writeFileSync(file, '{"type":"session"}\n');
		const response = subprocess(file, "stream-partial");
		assert.equal(response.ok, false);
		assert.equal(response.result.output, "partial\u2028answer");
		assert.equal(response.result.usage.totalTokens, 5);
		assert.equal(response.result.messages.at(-1).content[0].thinking, "Consider carefully.");
		assert.deepEqual(response.result.messages.at(-1).content[2].arguments, { path: "source.ts" });
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an incomplete response fails even when the subprocess exits successfully", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "subagent-runner-"));
	try {
		const file = path.join(dir, "session.jsonl");
		writeFileSync(file, '{"type":"session"}\n');
		const response = subprocess(file, "stream-partial-zero");
		assert.equal(response.ok, false);
		assert.equal(response.result.exitCode, 0);
		assert.equal(response.result.stopReason, "error");
		assert.equal(response.result.output, "partial\u2028answer");
		assert.equal(response.result.usage.totalTokens, 5);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("raw JSON and stderr observers receive progress despite observer exceptions", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "subagent-runner-"));
	try {
		const file = path.join(dir, "session.jsonl");
		writeFileSync(file, '{"type":"session"}\n');
		const response = subprocess(file, "stream-observer-error");
		assert.equal(response.ok, true);
		assert.equal(response.events.filter((event: string) => event === "message_update").length, 4);
		assert.ok(response.events.includes("tool_execution_end"));
		assert.equal(response.stderr.join(""), "fixture diagnostic\n");
		assert.equal(response.processes[0], 0);
		assert.ok(response.processes[1] > 0);
		assert.equal(response.processes.at(-1), null);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("aborted streams retain partial text and usage", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "subagent-runner-"));
	try {
		const file = path.join(dir, "session.jsonl");
		writeFileSync(file, '{"type":"session"}\n');
		const response = subprocess(file, "stream-cancel");
		assert.equal(response.ok, false);
		assert.equal(response.result.stopReason, "aborted");
		assert.equal(response.result.output, "partial\u2028answer");
		assert.equal(response.result.usage.totalTokens, 5);
		assert.equal(response.listeners, 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cancellation terminates shell descendants before returning", { skip: process.platform === "win32" }, async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "subagent-runner-"));
	try {
		const file = path.join(dir, "session.jsonl");
		writeFileSync(file, '{"type":"session"}\n');
		const response = subprocess(file, "stream-cancel-tree");
		assert.equal(response.ok, false);
		assert.equal(response.result.stopReason, "aborted");
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(existsSync(`${file}.descendant`), false);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
