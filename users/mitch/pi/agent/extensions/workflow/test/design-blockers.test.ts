// Design/plan escalation, retained implementation work and worker shutdown.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { validateImplementation, validateReview } from "../context.ts";
import { fixture } from "./design-fixture.ts";

async function prepare(f: ReturnType<typeof fixture>) {
	const run = f.orchestrator();
	await run.execute(f.ctx);
	await run.reviewDesign(f.ctx);
	return run;
}

test("an implementer design blocker returns to a human decision", async () => {
	const f = fixture();
	try {
		const run = await prepare(f);
		f.controls.implementation = { status: "blocked", summary: "Contract needs changing", filesChanged: [], tests: [], blocker: { kind: "design", reason: "Return type is ambiguous." } };
		await run.approveDesign(f.ctx);
		assert.equal(f.state.todos[0].status, "awaiting-change");
		assert.deepEqual(f.calls.map((call) => call.roleName), ["implementer"]);
	} finally { f.close(); }
});

test("a code reviewer plan blocker bypasses automatic revisions", async () => {
	const f = fixture();
	try {
		const run = await prepare(f);
		f.controls.review = { verdict: "escalate", summary: "Scope issue", findings: [], blocker: { kind: "plan", reason: "A prerequisite todo is required." } };
		await run.approveDesign(f.ctx);
		assert.equal(f.state.todos[0].status, "awaiting-change");
		assert.equal(f.calls.length, 2);
	} finally { f.close(); }
});

test("revised design preserves partial work and implementation conversation", async () => {
	const f = fixture();
	try {
		const run = await prepare(f);
		f.controls.beforeRun = async (options) => {
			if (options.roleName === "implementer") writeFileSync(path.join(f.cwd, "code.ts"), "export const partial = true;\n");
		};
		f.controls.implementation = { status: "blocked", summary: "Blocked", filesChanged: ["code.ts"], tests: [], blocker: { kind: "design", reason: "Choose an API." } };
		await run.approveDesign(f.ctx);
		await run.enterDesign(f.ctx);
		assert.equal(readFileSync(path.join(f.cwd, "code.ts"), "utf8"), "export const partial = true;\n");
		writeFileSync(path.join(f.cwd, "design.md"), "Revised API\n");
		await run.reviewDesign(f.ctx);
		f.controls.implementation = { status: "completed", summary: "Done", filesChanged: [], tests: [] };
		await run.approveDesign(f.ctx);
		assert.equal(f.calls[0].sessionFile, f.calls[2].sessionFile);
		assert.match(f.calls[3].task, /Retained implementation history/);
		assert.match(f.calls[3].task, /export const partial = true/);
		assert.match(f.calls[2].systemPrompt, /Revised API/);
	} finally { f.close(); }
});

test("stopping awaits a worker before beginning human design editing", async () => {
	const f = fixture();
	try {
		const run = await prepare(f);
		let started!: () => void;
		const ready = new Promise<void>((resolve) => started = resolve);
		let exited = false;
		f.controls.beforeRun = async (options) => {
			started();
			try { await new Promise<void>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(new Error("Stopped")), { once: true })); }
			finally { exited = true; }
		};
		const active = run.approveDesign(f.ctx);
		await ready;
		await run.stop();
		await active;
		assert.equal(exited, true);
		await f.orchestrator().enterDesign(f.ctx);
		assert.equal(f.state.todos[0].status, "design-editing");
		assert.equal(f.state.todos[0].designAccepted, undefined);
	} finally { f.close(); }
});

test("review blockers require escalation", () => {
	assert.throws(() => validateReview({ verdict: "request_changes", summary: "Change design", findings: [], blocker: { kind: "design", reason: "Choose an API." } }), /requires blocked implementation or escalated review/);
});

test("implementation blockers require a human decision reason", () => {
	assert.throws(() => validateImplementation({ status: "blocked", summary: "Blocked", filesChanged: [], tests: [], blocker: { kind: "plan", reason: "" } }), /Invalid workflow blocker/);
});
