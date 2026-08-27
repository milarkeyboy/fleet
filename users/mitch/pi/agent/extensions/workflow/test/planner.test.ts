import assert from "node:assert/strict";
import test from "node:test";
import type { MarkdownContent } from "../content.ts";
import { appendPlanFormatInstructions, extractWorkflowTodos, planFormatInstructions, resolveSkillTag } from "../planner.ts";

function skill(name: string, description = `${name} guidance`): MarkdownContent {
	return { name, description, body: "", filePath: `/skills/${name}/SKILL.md`, source: "bundled", skills: [] };
}

const skills = {
	"cpp-development": skill("cpp-development", "C++ development"),
	"python-development": skill("python-development", "Python development"),
	rust: skill("rust", "Rust development"),
};

test("extracts arbitrary skill tags and leaves untagged todos without a primary skill", () => {
	const todos = extractWorkflowTodos(`Intro\n\nPlan:\n1. [rust] Add the parser and tests\n2. Update the TypeScript extension\n3. [cpp] Update native bindings\n`, skills);
	assert.equal(todos.length, 3);
	assert.equal(todos[0].primarySkill, "rust");
	assert.equal(todos[1].primarySkill, undefined);
	assert.equal(todos[1].skillRequest, undefined);
	assert.equal(todos[2].primarySkill, "cpp-development");
});

test("preserves legacy aliases and records unknown explicit tags", () => {
	assert.equal(resolveSkillTag("C++", skills), "cpp-development");
	assert.equal(resolveSkillTag("py", skills), "python-development");
	assert.equal(resolveSkillTag("typescript", skills), undefined);
	const [todo] = extractWorkflowTodos("Plan:\n1. [typescript] Update extension code", skills);
	assert.equal(todo.primarySkill, undefined);
	assert.equal(todo.skillRequest, "typescript");
});

test("planning instructions advertise discovered skills and permit untagged work", () => {
	const normalPrompt = "Normal pi prompt\n\nContext file: AGENTS.md";
	const instructions = planFormatInstructions(skills);
	assert.equal(appendPlanFormatInstructions(normalPrompt, skills), `${normalPrompt}\n\n${instructions}`);
	assert.match(instructions, /Produce the final plan under exactly "Plan:"/);
	assert.match(instructions, /Tags are optional/);
	assert.match(instructions, /\[rust\]: Rust development/);
	assert.doesNotMatch(instructions, /investigate|read-only|without modifying|workflow_questionnaire/i);
});
