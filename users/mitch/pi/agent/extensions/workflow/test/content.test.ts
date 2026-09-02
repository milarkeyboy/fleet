import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bundledContentRoot, discoverWorkflowContent, listMarkdownFiles, parseAgentSkill, scaffoldWorkflowRoles } from "../content.ts";

test("parses standard Agent Skill frontmatter", () => {
	const parsed = parseAgentSkill(
		"---\nname: sample\ndescription: Portable skill\nlicense: CC0-1.0\n---\nHello\n",
		"/tmp/sample/SKILL.md",
		"user",
	);
	assert.equal(parsed.name, "sample");
	assert.equal(parsed.description, "Portable skill");
	assert.equal(parsed.body.trim(), "Hello");
});

test("bundled shared Markdown contains only plain workflow prompts", async () => {
	const root = bundledContentRoot();
	const files = listMarkdownFiles(root).map((file) => path.relative(root, file).replaceAll(path.sep, "/")).sort();

	assert.deepEqual(files, ["planner.md", "roles/implementer.md", "roles/reviewer.md"]);
	for (const file of files) {
		const markdown = await readFile(path.join(root, file), "utf8");
		assert.equal(markdown.startsWith("---\n"), false, `${file} must be a plain Markdown prompt`);
	}
	const planner = await readFile(path.join(root, "planner.md"), "utf8");
	assert.match(planner, /implemented and reviewed in isolation/);
	assert.match(planner, /Do not create standalone todos/);
});

test("scaffolds only workflow role prompts", async () => {
	const temp = await mkdtemp(path.join(os.tmpdir(), "workflow-content-test-"));
	const agents = path.join(temp, ".agents");
	try {
		await scaffoldWorkflowRoles(agents);
		assert.deepEqual(
			listMarkdownFiles(agents).map((file) => path.relative(agents, file).replaceAll(path.sep, "/")),
			["workflow/roles/implementer.md", "workflow/roles/reviewer.md"],
		);
		assert.equal(existsSync(path.join(agents, "skills")), false);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});

test("discovers user skills and applies trusted project precedence", async () => {
	const temp = await mkdtemp(path.join(os.tmpdir(), "workflow-content-test-"));
	const home = path.join(temp, "home");
	const project = path.join(temp, "project");
	await mkdir(path.join(home, ".agents", "workflow", "roles"), { recursive: true });
	await mkdir(path.join(home, ".agents", "skills", "cpp"), { recursive: true });
	await mkdir(path.join(home, ".agents", "skills", "python"), { recursive: true });
	await mkdir(path.join(home, ".agents", "skills", "group", "rust"), { recursive: true });
	await mkdir(path.join(project, ".agents", "workflow", "roles"), { recursive: true });
	await mkdir(path.join(project, ".agents", "skills", "nested", "rust"), { recursive: true });
	await writeFile(path.join(home, ".agents", "workflow", "roles", "implementer.md"), "# User implementer\n\nUser personality");
	await writeFile(path.join(project, ".agents", "workflow", "roles", "implementer.md"), "# Project implementer\n\nProject personality");
	await writeFile(path.join(home, ".agents", "skills", "cpp", "SKILL.md"), "---\nname: cpp\ndescription: C++ guidance\n---\nC++");
	await writeFile(path.join(home, ".agents", "skills", "python", "SKILL.md"), "---\nname: python\ndescription: Python guidance\n---\nPython");
	await writeFile(path.join(home, ".agents", "skills", "group", "rust", "SKILL.md"), "---\nname: rust\ndescription: user rust\n---\nUser Rust");
	await writeFile(path.join(project, ".agents", "skills", "nested", "rust", "SKILL.md"), "---\nname: rust\ndescription: project rust\n---\nProject Rust");
	try {
		const content = discoverWorkflowContent(project, true, home);
		assert.match(content.planner, /^# Workflow Planner Guidance/);
		assert.equal(content.roles.implementer.source, "project");
		assert.match(content.roles.implementer.body, /^# Project implementer/);
		assert.equal(content.roles.reviewer.source, "bundled");
		assert.equal(content.skills.cpp.source, "user");
		assert.equal(content.skills.python.source, "user");
		assert.equal(content.skills.rust.source, "project");
		assert.match(content.diagnostics.join("\n"), /project Agent Skill "rust" overrides user/);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});

test("loads role files verbatim without interpreting frontmatter", async () => {
	const temp = await mkdtemp(path.join(os.tmpdir(), "workflow-content-test-"));
	const home = path.join(temp, "home");
	const project = path.join(temp, "project");
	const role = "---\nname: not-metadata\n---\n# Implementer";
	await mkdir(path.join(home, ".agents", "workflow", "roles"), { recursive: true });
	await writeFile(path.join(home, ".agents", "workflow", "roles", "implementer.md"), role);
	try {
		assert.equal(discoverWorkflowContent(project, false, home).roles.implementer.body, role);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});

test("does not load untrusted project skills", async () => {
	const temp = await mkdtemp(path.join(os.tmpdir(), "workflow-content-test-"));
	const home = path.join(temp, "home");
	const project = path.join(temp, "project");
	await mkdir(path.join(project, ".agents", "skills", "private-skill"), { recursive: true });
	await writeFile(path.join(project, ".agents", "skills", "private-skill", "SKILL.md"), "---\nname: private-skill\ndescription: private\n---\nPrivate");
	try {
		assert.equal(discoverWorkflowContent(project, false, home).skills["private-skill"], undefined);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});
