// Authoritative design context composed with shared agent personality profiles.
import assert from "node:assert/strict";
import test from "node:test";
import { codeReviewerInvocation, designReviewerInvocation, implementerInvocation } from "../context.ts";
import { fixture } from "./design-fixture.ts";

function reviewedFixture() {
	const f = fixture();
	const todo = f.state.todos[0];
	todo.designs = [{ planRevision: 1, baselineTree: "before", resultTree: "after", changedFiles: ["api.h"], diffPreview: "+ void start();", reviews: [], accepted: true }];
	todo.designAccepted = 0;
	todo.revisions = [{ designIndex: 0, changedFiles: [], implementation: { status: "completed", summary: "Done", filesChanged: [], tests: [] } }];
	return { ...f, todo };
}

test("design review receives the human diff and internal review guidance", () => {
	const f = reviewedFixture();
	try {
		const invocation = designReviewerInvocation(f.state, f.todo, f.content);
		assert.match(invocation.task, /\+ void start\(\);/);
		assert.match(invocation.systemPrompt, /temporarily break compilation/);
	} finally { f.close(); }
});

test("implementation receives accepted design as authoritative context", () => {
	const f = reviewedFixture();
	try { assert.match(implementerInvocation(f.state, f.todo, f.content).systemPrompt, /\+ void start\(\);/); }
	finally { f.close(); }
});

test("code review receives the current accepted design", () => {
	const f = reviewedFixture();
	try { assert.match(codeReviewerInvocation(f.state, f.todo, f.content).systemPrompt, /\+ void start\(\);/); }
	finally { f.close(); }
});

for (const [role, invoke] of [["implementer", implementerInvocation], ["code-reviewer", codeReviewerInvocation]] as const) {
	test(`${role} treats skeleton completion as implementation within explicit constraints`, () => {
		const f = reviewedFixture();
		try {
			f.todo.designs[0].diffPreview = "+ class Widget { public: void start(); };";
			const prompt = invoke(f.state, f.todo, f.content).systemPrompt;
			assert.match(prompt, /Completing class skeletons with constructors, members and method bodies is implementation work/);
			assert.match(prompt, /unless explicit design constraints forbid those additions/);
			assert.match(prompt, /Existing contractual signatures and documented behaviour remain constraints/);
		} finally { f.close(); }
	});

	test(`${role} treats feedback as clarification without granting contract or scope changes`, () => {
		const f = reviewedFixture();
		try {
			f.todo.revisions[0].humanFeedback = "Add the constructor and private members needed to implement the skeleton.";
			const prompt = invoke(f.state, f.todo, f.content).systemPrompt;
			assert.match(prompt, /Add the constructor and private members/);
			assert.match(prompt, /Human implementation feedback is authoritative clarification/);
			assert.match(prompt, /does not authorise changing explicit contracts or plan scope/);
		} finally { f.close(); }
	});
}

for (const [role, invoke, required] of [
	["implementer", implementerInvocation, [/Preserve human-authored design/, /Return blocked with a design or plan blocker/, /<workflow-implementation>/]],
	["design-reviewer", designReviewerInvocation, [/explicit human acceptance authorises implementation/, /Preserve all repository files/, /<workflow-review>/]],
	["code-reviewer", codeReviewerInvocation, [/You are read-only/, /Use escalate with a design or plan blocker/, /<workflow-review>/]],
] as const) {
	test(`${role} personality customisation retains the internal workflow protocol`, async () => {
		const f = reviewedFixture();
		try {
			const agent = { ...f.agents[role], body: "Prefer concise explanations." };
			const { systemPrompt, ...assignment } = invoke(f.state, f.todo, f.content);
			const { handle } = f.store.prepare(f.state, f.todo, role);
			await f.store.run(f.state, handle, agent, { ...assignment, instructions: systemPrompt }, async (options) => {
				assert.match(options.systemPrompt, /Prefer concise explanations/);
				for (const pattern of required) assert.match(options.systemPrompt, pattern);
				return { exitCode: 0, output: "Done.", stderr: "", messages: [] };
			});
		} finally { f.close(); }
	});
}
