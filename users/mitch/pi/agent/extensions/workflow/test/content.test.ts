import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bundledContentRoot, discoverWorkflowContent, listMarkdownFiles, parseMarkdown } from "../content.ts";

test("parses portable Markdown frontmatter and supplemental role skills", () => {
	const parsed = parseMarkdown("---\nname: sample\ndescription: Portable role\nskills:\n  - testing\n  - security-review\n---\nHello\n", "/tmp/sample.md", "user");
	assert.equal(parsed.name, "sample");
	assert.equal(parsed.description, "Portable role");
	assert.deepEqual(parsed.skills, ["testing", "security-review"]);
	assert.equal(parsed.body.trim(), "Hello");
	assert.deepEqual(parseMarkdown("---\nname: x\ndescription: x\nskills: [testing, 'docs']\n---\n", "/tmp/x.md", "user").skills, ["testing", "docs"]);
});

test("bundled shared Markdown contains only portable roles and Agent Skills", async () => {
	const root = bundledContentRoot();
	const files = listMarkdownFiles(root).map((file) => path.relative(root, file).replaceAll(path.sep, "/")).sort();

	assert.deepEqual(files.filter((file) => file.startsWith("roles/")), ["roles/implementer.md", "roles/reviewer.md"]);
	const skillFiles = files.filter((file) => file.startsWith("skills/"));
	assert.ok(skillFiles.length > 0);
	for (const skill of new Set(skillFiles.map((file) => file.split("/")[1]))) assert.ok(files.includes(`skills/${skill}/SKILL.md`));
	for (const file of files) {
		assert.match(file, /^(?:roles\/(?:implementer|reviewer)\.md|skills\/[^/]+\/.*\.md)$/);
		const markdown = await readFile(path.join(root, file), "utf8");
		const frontmatterEnd = markdown.startsWith("---\n") ? markdown.indexOf("\n---", 4) : -1;
		const frontmatter = frontmatterEnd >= 0 ? markdown.slice(4, frontmatterEnd) : "";
		assert.doesNotMatch(frontmatter, /^(?:model|model-id|modelId|provider|thinking-level|thinkingLevel):/im);
	}
});

test("bundled Agent Skill names match their parent directories", async () => {
	const root = bundledContentRoot();
	const skillFiles = listMarkdownFiles(path.join(root, "skills")).filter((file) => path.basename(file) === "SKILL.md");
	assert.ok(skillFiles.length > 0);
	for (const skillFile of skillFiles) {
		const parsed = parseMarkdown(await readFile(skillFile, "utf8"), skillFile, "bundled");
		assert.equal(parsed.name, path.basename(path.dirname(skillFile)), `${skillFile} name must match its parent directory`);
	}
});

test("recursively discovers arbitrary skills with project precedence and role references", async () => {
	const temp = await mkdtemp(path.join(os.tmpdir(), "workflow-content-test-"));
	const home = path.join(temp, "home");
	const project = path.join(temp, "project");
	await mkdir(path.join(home, ".agents", "workflow", "roles"), { recursive: true });
	await mkdir(path.join(home, ".agents", "skills", "group", "rust"), { recursive: true });
	await mkdir(path.join(project, ".agents", "workflow", "roles"), { recursive: true });
	await mkdir(path.join(project, ".agents", "skills", "nested", "rust"), { recursive: true });
	await mkdir(path.join(project, ".agents", "skills", "testing"), { recursive: true });
	await writeFile(path.join(home, ".agents", "workflow", "roles", "implementer.md"), "---\nname: implementer\ndescription: user\n---\nUser personality");
	await writeFile(path.join(project, ".agents", "workflow", "roles", "implementer.md"), "---\nname: implementer\ndescription: project\nskills: [testing]\n---\nProject personality");
	await writeFile(path.join(home, ".agents", "skills", "group", "rust", "SKILL.md"), "---\nname: rust\ndescription: user rust\n---\nUser Rust");
	await writeFile(path.join(project, ".agents", "skills", "nested", "rust", "SKILL.md"), "---\nname: rust\ndescription: project rust\n---\nProject Rust");
	await writeFile(path.join(project, ".agents", "skills", "testing", "SKILL.md"), "---\nname: testing\ndescription: testing guidance\n---\nTest");
	try {
		const content = discoverWorkflowContent(project, true, home);
		assert.equal(content.roles.implementer.source, "project");
		assert.deepEqual(content.roles.implementer.skills, ["testing"]);
		assert.equal(content.roles.reviewer.source, "bundled");
		assert.equal("planner" in content.roles, false);
		assert.equal(content.skills.rust.source, "project");
		assert.equal(content.skills.testing.name, "testing");
		assert.match(content.diagnostics.join("\n"), /project Agent Skill "rust" overrides user/);
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
