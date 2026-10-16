// Workflow planning guidance and selected Agent Skills discovery.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverWorkflowContent, listMarkdownFiles, parseAgentSkill } from "../content.ts";

test("parses standard Agent Skill frontmatter", () => {
	const parsed = parseAgentSkill(
		"---\nname: sample\ndescription: Portable skill\nlicense: CC0-1.0\n---\nHello\n",
		"/tmp/sample/SKILL.md", "user",
	);
	assert.equal(parsed.name, "sample");
	assert.equal(parsed.description, "Portable skill");
	assert.equal(parsed.body.trim(), "Hello");
});

test("bundled Markdown supplies conversational planning guidance", async () => {
	const root = new URL("../content/", import.meta.url).pathname;
	assert.deepEqual(listMarkdownFiles(root).map((file) => path.relative(root, file)), ["planner.md"]);
	const planner = await readFile(path.join(root, "planner.md"), "utf8");
	assert.equal(planner.startsWith("---\n"), false);
	assert.match(planner, /single increment/);
	assert.doesNotMatch(planner, /workflow_submit_plan/);
});

test("discovers user skills and applies trusted project precedence", async () => {
	const temp = await mkdtemp(path.join(os.tmpdir(), "workflow-content-test-"));
	const home = path.join(temp, "home");
	const project = path.join(temp, "project");
	await mkdir(path.join(home, ".agents", "skills", "cpp"), { recursive: true });
	await mkdir(path.join(home, ".agents", "skills", "python"), { recursive: true });
	await mkdir(path.join(home, ".agents", "skills", "group", "rust"), { recursive: true });
	await mkdir(path.join(project, ".agents", "skills", "nested", "rust"), { recursive: true });
	await writeFile(path.join(home, ".agents", "skills", "cpp", "SKILL.md"), "---\nname: cpp\ndescription: C++ guidance\n---\nC++");
	await writeFile(path.join(home, ".agents", "skills", "python", "SKILL.md"), "---\nname: python\ndescription: Python guidance\n---\nPython");
	await writeFile(path.join(home, ".agents", "skills", "group", "rust", "SKILL.md"), "---\nname: rust\ndescription: user rust\n---\nUser Rust");
	await writeFile(path.join(project, ".agents", "skills", "nested", "rust", "SKILL.md"), "---\nname: rust\ndescription: project rust\n---\nProject Rust");
	try {
		const content = discoverWorkflowContent(project, true, home);
		assert.match(content.planner, /^# Workflow Planner Guidance/);
		assert.equal(content.skills.cpp.source, "user");
		assert.equal(content.skills.python.source, "user");
		assert.equal(content.skills.rust.source, "project");
		assert.match(content.diagnostics.join("\n"), /project Agent Skill "rust" overrides user/);
	} finally { await rm(temp, { recursive: true, force: true }); }
});

test("does not load untrusted project skills", async () => {
	const temp = await mkdtemp(path.join(os.tmpdir(), "workflow-content-test-"));
	const home = path.join(temp, "home");
	const project = path.join(temp, "project");
	await mkdir(path.join(project, ".agents", "skills", "private-skill"), { recursive: true });
	await writeFile(path.join(project, ".agents", "skills", "private-skill", "SKILL.md"), "---\nname: private-skill\ndescription: private\n---\nPrivate");
	try { assert.equal(discoverWorkflowContent(project, false, home).skills["private-skill"], undefined); }
	finally { await rm(temp, { recursive: true, force: true }); }
});
