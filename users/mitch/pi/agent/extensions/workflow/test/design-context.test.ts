// Role separation and authoritative design context supplied to isolated agents.
import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflowModelConfig, requireExecutableWorkflowModels } from "../config.ts";
import { discoverWorkflowContent } from "../content.ts";
import { codeReviewerInvocation, designReviewerInvocation, implementerInvocation } from "../context.ts";
import { createWorkflowTodos } from "../planner.ts";
import { createWorkflowState } from "../state.ts";

function fixture() {
	const state = createWorkflowState();
	state.todos = createWorkflowTodos([{ title: "API", instructions: ["Implement the API."] }]);
	const todo = state.todos[0];
	todo.designs = [{ planRevision: 1, baselineTree: "before", resultTree: "after", changedFiles: ["api.h"], diffPreview: "+ void start();", reviews: [], accepted: true }];
	todo.designAccepted = 0;
	todo.revisions = [{ designIndex: 0, changedFiles: [], implementation: { status: "completed", summary: "Done", filesChanged: [], tests: [] } }];
	return { state, todo, content: discoverWorkflowContent(process.cwd(), false, "/nonexistent-workflow-home") };
}

test("design review receives the human diff and separate review guidance", () => {
	const f = fixture();
	const invocation = designReviewerInvocation(f.state, f.todo, f.content);
	assert.match(invocation.task, /\+ void start\(\);/);
	assert.match(invocation.systemPrompt, /# Design Reviewer Role/);
	assert.match(invocation.systemPrompt, /temporarily break compilation/);
});

test("implementation receives accepted design as authoritative context", () => {
	const f = fixture();
	assert.match(implementerInvocation(f.state, f.todo, f.content).systemPrompt, /\+ void start\(\);/);
});

test("code review uses its own role and current accepted design", () => {
	const f = fixture();
	const invocation = codeReviewerInvocation(f.state, f.todo, f.content);
	assert.match(invocation.systemPrompt, /# Code Reviewer Role/);
	assert.match(invocation.systemPrompt, /\+ void start\(\);/);
});

test("all three roles require explicit model assignments", async () => {
	const config = parseWorkflowModelConfig({ implementer: { model: "test/impl" }, "code-reviewer": { model: "test/code" } });
	await assert.rejects(requireExecutableWorkflowModels(config, {} as any), /Missing: design-reviewer/);
});

test("implementer personality customisation retains the internal workflow protocol", () => {
	const f = fixture();
	f.content.roles.implementer.body = "Prefer concise explanations.";
	const prompt = implementerInvocation(f.state, f.todo, f.content).systemPrompt;
	assert.match(prompt, /Prefer concise explanations/);
	assert.match(prompt, /Preserve human-authored design/);
	assert.match(prompt, /Return blocked with a design or plan blocker/);
	assert.match(prompt, /<workflow-implementation>/);
});

test("design reviewer personality customisation retains human acceptance rules", () => {
	const f = fixture();
	f.content.roles["design-reviewer"].body = "Question assumptions thoughtfully.";
	const prompt = designReviewerInvocation(f.state, f.todo, f.content).systemPrompt;
	assert.match(prompt, /Question assumptions thoughtfully/);
	assert.match(prompt, /explicit human acceptance authorises implementation/);
	assert.match(prompt, /Preserve all repository files/);
	assert.match(prompt, /<workflow-review>/);
});

test("code reviewer personality customisation retains review routing rules", () => {
	const f = fixture();
	f.content.roles["code-reviewer"].body = "Be exacting and independent.";
	const prompt = codeReviewerInvocation(f.state, f.todo, f.content).systemPrompt;
	assert.match(prompt, /Be exacting and independent/);
	assert.match(prompt, /You are read-only/);
	assert.match(prompt, /Use escalate with a design or plan blocker/);
	assert.match(prompt, /<workflow-review>/);
});
