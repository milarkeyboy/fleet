// Subprocess arguments, persisted conversation transport, and cancellation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BASH_POLICY_EXTENSION_PATH, buildAgentArgs, extractProtocolJson } from "../runner.ts";

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
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("extracts structured handoff protocol", () => {
	const value = extractProtocolJson<{ verdict: string }>("notes\n<workflow-review>{\"verdict\":\"approve\"}</workflow-review>", "workflow-review");
	assert.equal(value.verdict, "approve");
});
