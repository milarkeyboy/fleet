import assert from "node:assert/strict";
import test from "node:test";
import type { MarkdownContent } from "../content.ts";
import { appendPlanningInstructions, createWorkflowTodos, extractRelevantFiles, formatWorkflowPlan, formatWorkflowTodo, planFormatInstructions, resolveSkillTag, submitWorkflowPlan } from "../planner.ts";
import { createWorkflowState } from "../state.ts";

function skill(name: string, description = `${name} guidance`): MarkdownContent {
	return { name, description, body: "", filePath: `/skills/${name}/SKILL.md`, source: "user" };
}

const skills = {
	cpp: skill("cpp", "C++ development"),
	python: skill("python", "Python development"),
	rust: skill("rust", "Rust development"),
};

const submitted = [
	{
		title: "Co-locate maintained dictionaries.",
		instructions: [
			"Move `cspell-dictionary.txt` to `linters/cspell-dictionaries/common.txt` and update its configuration reference.",
			"Retain plain text.\nUse preceding # comment blocks to explain terms and groups.",
		],
		primarySkill: "python",
	},
	{
		title: "Verify integration.",
		instructions: ["Run the Meson CSpell target."],
	},
];

test("creates native todos with exact skills and complete instructions", () => {
	const todos = createWorkflowTodos(submitted, skills);
	assert.equal(todos.length, 2);
	assert.equal(todos[0].title, submitted[0].title);
	assert.deepEqual(todos[0].instructions, submitted[0].instructions);
	assert.equal(todos[0].primarySkill, "python");
	assert.equal(todos[1].primarySkill, undefined);
});

test("does not alias old or shorthand skill names", () => {
	assert.equal(resolveSkillTag("cpp-development", skills), undefined);
	assert.equal(resolveSkillTag("C++", skills), undefined);
	assert.equal(resolveSkillTag("py", skills), undefined);
	assert.equal(resolveSkillTag("Python", skills), "python");
	const [todo] = createWorkflowTodos([{ title: "Bindings", instructions: ["Update them."], primarySkill: "cpp-development" }], skills);
	assert.equal(todo.primarySkill, undefined);
	assert.equal(todo.skillRequest, "cpp-development");
});

test("requires every todo to contain implementation instructions", () => {
	assert.throws(() => createWorkflowTodos([], skills), /at least one todo/);
	assert.throws(() => createWorkflowTodos([{ title: "Task", instructions: [] }], skills), /at least one instruction/);
	assert.throws(() => createWorkflowTodos([{ title: " ", instructions: ["Do it"] }], skills), /requires a title/);
});

test("typed submission replaces the prior plan and resets orchestration selection", () => {
	const state = createWorkflowState();
	state.executing = true;
	state.paused = true;
	state.currentStep = 9;
	state.todos = [{ step: 9, title: "Old", instructions: ["Discard this."], status: "approved", attempts: 1, automaticReviewCycles: 1, revisions: [{ changedFiles: ["old.ts"] }] }];
	const todos = submitWorkflowPlan(state, submitted, skills);
	assert.equal(state.todos, todos);
	assert.equal(state.currentStep, 1);
	assert.equal(state.executing, false);
	assert.equal(state.paused, false);
	assert.deepEqual(state.todos.map((todo) => todo.title), ["Co-locate maintained dictionaries.", "Verify integration."]);
	assert.deepEqual(state.todos.map((todo) => todo.revisions), [[], []]);
});

test("one formatter renders the complete canonical plan and individual todo", () => {
	const todos = createWorkflowTodos(submitted, skills);
	const expected = [
		"Plan:",
		"1. [python] Co-locate maintained dictionaries.",
		"   - Move `cspell-dictionary.txt` to `linters/cspell-dictionaries/common.txt` and update its configuration reference.",
		"   - Retain plain text.",
		"     Use preceding # comment blocks to explain terms and groups.",
		"",
		"2. Verify integration.",
		"   - Run the Meson CSpell target.",
	].join("\n");
	assert.equal(formatWorkflowPlan(todos), expected);
	assert.equal(formatWorkflowTodo(todos[0]), expected.split("\n\n")[0].replace("Plan:\n", ""));
});

test("relevant paths are discovered from native instructions", () => {
	const [todo] = createWorkflowTodos(submitted, skills);
	assert.deepEqual(extractRelevantFiles(todo), ["cspell-dictionary.txt", "linters/cspell-dictionaries/common.txt"]);
});

test("planning instructions require typed submission and list skills", () => {
	const normalPrompt = "Normal pi prompt\n\nContext file: AGENTS.md";
	const plannerPrompt = "# Planner\n\nCreate independently reviewable todos.";
	const instructions = planFormatInstructions(skills);
	assert.equal(appendPlanningInstructions(normalPrompt, plannerPrompt, skills), `${normalPrompt}\n\n${plannerPrompt}\n\n${instructions}`);
	assert.match(instructions, /Use questionnaire for important scope/);
	assert.match(instructions, /workflow_submit_plan/);
	assert.match(instructions, /instructions array containing every requirement/);
	assert.match(instructions, /Use exact skill names/);
	assert.match(instructions, /rust: Rust development/);
	assert.doesNotMatch(instructions, /Produce the final plan under exactly/);
});
