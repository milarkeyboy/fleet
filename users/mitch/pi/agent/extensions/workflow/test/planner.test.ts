import assert from "node:assert/strict";
import test from "node:test";
import type { MarkdownContent } from "../content.ts";
import { appendPlanFormatInstructions, extractWorkflowTodos, planFormatInstructions, resolveSkillTag } from "../planner.ts";

function skill(name: string, description = `${name} guidance`): MarkdownContent {
	return { name, description, body: "", filePath: `/skills/${name}/SKILL.md`, source: "user" };
}

const skills = {
	cpp: skill("cpp", "C++ development"),
	python: skill("python", "Python development"),
	rust: skill("rust", "Rust development"),
};

test("extracts exact skill tags and leaves untagged todos without a primary skill", () => {
	const todos = extractWorkflowTodos(`Intro\n\nPlan:\n1. [rust] Add the parser and tests\n2. Update the TypeScript extension\n3. [cpp] Update native bindings\n`, skills);
	assert.equal(todos.length, 3);
	assert.equal(todos[0].primarySkill, "rust");
	assert.equal(todos[1].primarySkill, undefined);
	assert.equal(todos[1].skillRequest, undefined);
	assert.equal(todos[2].primarySkill, "cpp");
});

test("does not alias old or shorthand skill names", () => {
	assert.equal(resolveSkillTag("cpp-development", skills), undefined);
	assert.equal(resolveSkillTag("C++", skills), undefined);
	assert.equal(resolveSkillTag("py", skills), undefined);
	assert.equal(resolveSkillTag("Python", skills), "python");
	const [todo] = extractWorkflowTodos("Plan:\n1. [cpp-development] Update native bindings", skills);
	assert.equal(todo.primarySkill, undefined);
	assert.equal(todo.skillRequest, "cpp-development");
});

test("planning instructions advertise discovered skills and permit untagged work", () => {
	const normalPrompt = "Normal pi prompt\n\nContext file: AGENTS.md";
	const instructions = planFormatInstructions(skills);
	assert.equal(appendPlanFormatInstructions(normalPrompt, skills), `${normalPrompt}\n\n${instructions}`);
	assert.match(instructions, /Produce the final plan under exactly "Plan:"/);
	assert.match(instructions, /Tags are optional/);
	assert.match(instructions, /Use exact skill names/);
	assert.match(instructions, /\[rust\]: Rust development/);
	assert.doesNotMatch(instructions, /investigate|read-only|without modifying|workflow_questionnaire/i);
});
