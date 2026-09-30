// Compatibility with Pi's real session storage and compaction; no provider calls.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { implementerInvocation, reviewerInvocation } from "../context.ts";
import { createWorkflowTodos } from "../planner.ts";
import { WorkflowSessionStore } from "../sessions.ts";
import { createWorkflowState } from "../state.ts";
import { installedPi } from "./pi.ts";

const pi = installedPi();
for (const [role, invoke] of [["implementer", implementerInvocation], ["reviewer", reviewerInvocation]] as const) {
	test(`${role} requirements survive Pi compaction and reopening the session`, { skip: !pi }, async () => {
		const { SessionManager } = await import(pi!.api);
		const root = mkdtempSync(path.join(os.tmpdir(), "workflow-pi-session-"));
		try {
			const state = createWorkflowState();
			state.ownerSessionId = "parent";
			state.todos = createWorkflowTodos([{ title: "Fix errors", instructions: ["Preserve the public API."] }]);
			const todo = state.todos[0];
			todo.revisions = [
				{ humanFeedback: "Remove the fallback.", changedFiles: [] },
				{ humanFeedback: "Change the label to Retry.", changedFiles: [], implementation: { status: "completed", summary: "done", filesChanged: [], tests: [] } },
			];
			const content = { planner: "", skills: {}, diagnostics: [], roles: {
				implementer: { name: "implementer" as const, body: "Implement", filePath: "/impl.md", source: "bundled" as const },
				reviewer: { name: "reviewer" as const, body: "Review", filePath: "/review.md", source: "bundled" as const },
			} };
			const snapshot = invoke(state, todo, content).systemPrompt;
			const store = new WorkflowSessionStore(root, "parent", root);
			const lease = store.acquire(state);
			const { session } = store.prepare(state, todo, role);
			const manager = SessionManager.open(session.file, root);
			assert.equal(manager.getSessionId(), session.id);
			assert.equal(manager.getCwd(), root);
			manager.appendMessage({ role: "system", content: snapshot, sections: { preamble: snapshot }, toolsAdded: [], timestamp: 1 });
			manager.appendMessage({ role: "user", content: "Old conversation-only detail.", timestamp: 2 });
			manager.appendCompaction("A summary that omits requirements.", null, 10000);
			const reopened = SessionManager.open(session.file, root);
			const messages = reopened.buildSessionContext().messages;
			const system = messages.find((message: any) => message.role === "system");
			assert.match(system.content, /Preserve the public API\./);
			assert.match(system.content, /Remove the fallback\./);
			assert.match(system.content, /Change the label to Retry\./);
			assert.doesNotMatch(JSON.stringify(messages), /Old conversation-only detail/);
			lease.release();
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
}
