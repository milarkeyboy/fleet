import assert from "node:assert/strict";
import test from "node:test";
import { askQuestionnaire, formatQuestionnaireResult } from "../questionnaire.ts";

// These tests cover the questionnaire's shared interaction and result contract.
test("returns selected labels and custom answers for every question", async () => {
	const selections = ["API A — Stable", "Type a custom answer…"];
	const prompts: Array<{ prompt: string; options: string[] }> = [];
	const result = await askQuestionnaire({
		async select(prompt: string, options: string[]) {
			prompts.push({ prompt, options });
			return selections.shift();
		},
		async input() { return "  Custom scope  "; },
	}, [
		{ id: "api", prompt: "Which API?", options: [{ label: "API A", description: "Stable" }] },
		{ id: "scope", prompt: "What scope?", options: [{ label: "Small" }] },
	]);

	assert.deepEqual(prompts, [
		{ prompt: "Which API?", options: ["API A — Stable", "Type a custom answer…"] },
		{ prompt: "What scope?", options: ["Small", "Type a custom answer…"] },
	]);
	assert.deepEqual(result, {
		cancelled: false,
		answers: [
			{ id: "api", answer: "API A", custom: false },
			{ id: "scope", answer: "Custom scope", custom: true },
		],
	});
	assert.equal(formatQuestionnaireResult(result), "api: user selected: API A\nscope: user wrote: Custom scope");
});

test("returns answers collected before the user cancels", async () => {
	const selections = ["First", undefined];
	const result = await askQuestionnaire({
		async select() { return selections.shift(); },
		async input() { return undefined; },
	}, [
		{ id: "one", prompt: "One?", options: [{ label: "First" }] },
		{ id: "two", prompt: "Two?", options: [{ label: "Second" }] },
	]);

	assert.deepEqual(result, {
		cancelled: true,
		answers: [{ id: "one", answer: "First", custom: false }],
	});
	assert.equal(formatQuestionnaireResult(result), "User cancelled the questionnaire.");
});

test("omits the custom answer when a question disables it", async () => {
	let displayed: string[] = [];
	const result = await askQuestionnaire({
		async select(_prompt, options) {
			displayed = options;
			return "Required";
		},
		async input() { throw new Error("Custom input should be unavailable."); },
	}, [{ id: "choice", prompt: "Choose", options: [{ label: "Required" }], allowOther: false }]);

	assert.deepEqual(displayed, ["Required"]);
	assert.deepEqual(result.answers, [{ id: "choice", answer: "Required", custom: false }]);
});
