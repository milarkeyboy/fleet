import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../runner.ts";

const execFileAsync = promisify(execFile);
const enabled = process.env.PI_WORKFLOW_E2E === "1";
const model = process.env.PI_WORKFLOW_E2E_MODEL;
const skillPath = process.env.PI_WORKFLOW_E2E_SKILL ?? path.join(os.homedir(), ".agents", "skills", "python", "SKILL.md");

async function exists(filePath: string): Promise<boolean> {
	try {
		await readFile(filePath);
		return true;
	} catch {
		return false;
	}
}

// This test intentionally uses a real Pi subprocess. It is opt-in because it
// requires a configured model and a working QEMU installation.
test("workflow implementer runs in Gondolin with a selected skill and Git", { skip: !enabled || !model }, async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-e2e-"));
	const sentinel = path.join(cwd, `.pi-extension-loaded-${process.pid}-${Date.now()}`);
	const target = path.join(path.dirname(skillPath), `.workflow-e2e-write-${process.pid}-${Date.now()}`);
	try {
		await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
		// Discovery would load this extension unless the runner's extension
		// isolation is active. Its only observable behavior is a host-side marker.
		await writeFile(
			path.join(cwd, ".pi", "extensions", "sentinel.ts"),
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "loaded"); export default function () {}`, 
		);
		await writeFile(path.join(cwd, ".gitignore"), "");
		await execFileAsync("git", ["init", "-q", cwd]);

		const result = await runAgent({
			cwd,
			roleName: "workflow-implementer",
			systemPrompt: `You are a workflow implementer. Read and follow only the selected skill below. Validate your work with focused checks. End with exactly one machine-readable block: <workflow-implementation>{"status":"completed|blocked","summary":"...","filesChanged":[],"tests":[]}</workflow-implementation>.`,
			task: `In the Gondolin VM, read this selected skill: ${skillPath}. Run git status --short. Use the write tool to attempt to create this exact file beside the skill: ${target}. The write must fail because the skill mount is read-only; do not try another location. Report the failed tool result, then end with the required workflow-implementation block.`,
			skillPaths: [skillPath],
			tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
			model: model!,
		});

		assert.equal(await exists(sentinel), false, "a discovered non-Gondolin extension was loaded");
		assert.equal(await exists(target), false, "the host skill directory was modified");
		const failedWrite = result.messages.some((message: any) => {
			if (message?.role !== "toolResult") return false;
			if (message.toolName !== undefined && message.toolName !== "write") return false;
			const serialized = JSON.stringify(message);
			return message.isError === true || /error|failed|read.only|denied|EROFS/i.test(serialized);
		});
		assert.equal(failedWrite, true, "the attempted skill-mount write did not produce a failed tool result");
	} finally {
		await rm(target, { force: true });
		await rm(cwd, { recursive: true, force: true });
	}
});
