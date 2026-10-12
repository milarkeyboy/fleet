// Workflow roles integrate with the shared conversation service and parent viewer.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { getConversationService } from "../../subagent/api.ts";
import { fixture } from "./design-fixture.ts";

test("design and code review keep distinct visible handles when sharing a profile", async () => {
	const f = fixture();
	try {
		f.agents["design-reviewer"] = f.agents["code-reviewer"];
		const run = f.orchestrator();
		await run.execute(f.ctx);
		writeFileSync(path.join(f.cwd, "design.md"), "Contract\n");
		await run.reviewDesign(f.ctx);
		await run.approveDesign(f.ctx);
		const sessions = f.state.todos[0].sessions!;
		assert.notEqual(sessions["design-reviewer"], sessions["code-reviewer"]);
		const service = getConversationService(f.store.root);
		const visible = service.listParent("parent");
		assert.equal(visible.length, 3);
		assert.equal(visible.find((info) => info.handle === sessions["design-reviewer"])?.agent, "reviewer");
		assert.equal(visible.find((info) => info.handle === sessions["code-reviewer"])?.agent, "reviewer");
		assert.match(service.inspect("parent", sessions["design-reviewer"]!).instructions!, /explicit human acceptance authorises implementation/);
		assert.match(service.inspect("parent", sessions["code-reviewer"]!).instructions!, /Use escalate with a design or plan blocker/);
	} finally { f.close(); }
});
