// Public conversation ownership, definition mapping and durable invocation lifecycle.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getConversationService } from "../api.ts";
import type { AgentDefinition } from "../agents.ts";
import { AgentRunError, type AgentRunOptions } from "../runner.ts";

const agent: AgentDefinition = {
	name: "reviewer", description: "Review", body: "Review carefully.",
	filePath: "/agents/reviewer.md", model: "test/reviewer", thinkingLevel: "high",
	tools: ["read", "grep"], contextFileDiscovery: false,
};
function fixture() {
	const root = mkdtempSync(path.join(os.tmpdir(), "subagent-api-"));
	const service = getConversationService(root);
	const owner = { parentSessionId: "parent", creator: "adhoc", cwd: "/repo" };
	return { root, service, owner, close: () => rmSync(root, { recursive: true, force: true }) };
}
const result = { exitCode: 0, output: "Reviewed.", stderr: "", messages: [] };

test("handles map shared definitions and assignment protocols to private runner inputs", async () => {
	const f = fixture();
	try {
		const handle = f.service.create(f.owner, "Review auth");
		let received: AgentRunOptions | undefined;
		assert.deepEqual(await f.service.run(f.owner, handle, agent, {
			task: "Review todo 1.", skillPaths: ["/skills/cpp/SKILL.md"], instructions: "Return the review protocol.",
		}, async (options) => { received = options; return result; }), result);
		assert.equal(received!.systemPrompt, "Review carefully.\n\n---\n\nReturn the review protocol.");
		assert.equal(received!.cwd, "/repo");
		assert.equal(received!.roleName, "reviewer");
		assert.equal(received!.model, "test/reviewer");
		assert.equal(received!.thinkingLevel, "high");
		assert.deepEqual(received!.tools, ["read", "grep"]);
		assert.deepEqual(received!.skillPaths, ["/skills/cpp/SKILL.md"]);
		assert.equal(received!.contextFileDiscovery, false);
		assert.ok(received!.sessionFile.startsWith(f.root));
		assert.equal(JSON.stringify(f.service.get(f.owner, handle)).includes(f.root), false);
	} finally { f.close(); }
});

test("successive definitions reuse a handle and native history", async () => {
	const f = fixture();
	try {
		const handle = f.service.create(f.owner, "Review");
		let first: string | undefined;
		await f.service.run(f.owner, handle, agent, { task: "First" }, async (options) => {
			first = options.sessionFile;
			appendFileSync(first, '{"type":"message","id":"user-1","message":{"role":"user","content":"Remember this","timestamp":1}}\n');
			return result;
		});
		await f.service.run(f.owner, handle, { ...agent, name: "implementer", model: "test/implementer", thinkingLevel: undefined }, { task: "Second" }, async (options) => {
			assert.equal(options.sessionFile, first);
			assert.match(readFileSync(options.sessionFile, "utf8"), /Remember this/);
			assert.equal(options.thinkingLevel, undefined);
			return result;
		});
		assert.equal(f.service.hasHistory(f.owner, handle), true);
		assert.equal(f.service.get(f.owner, handle).agent, "implementer");
	} finally { f.close(); }
});

for (const change of [{ parentSessionId: "another" }, { creator: "workflow:other" }, { cwd: "/other" }]) {
	test(`ownership rejects mismatched ${Object.keys(change)[0]}`, async () => {
		const f = fixture();
		try {
			const handle = f.service.create(f.owner, "Review");
			const other = { ...f.owner, ...change };
			assert.throws(() => f.service.get(other, handle), /owner|directory/);
			assert.throws(() => f.service.delete(other, handle), /owner|directory/);
			await assert.rejects(async () => f.service.run(other, handle, agent, { task: "Review" }, async () => result), /owner|directory/);
		} finally { f.close(); }
	});
}

test("failed invocations preserve the normal result and handle", async () => {
	const f = fixture();
	try {
		const handle = f.service.create(f.owner, "Review");
		const failed = { ...result, exitCode: 2, output: "Partial answer", stderr: "provider diagnostic" };
		await assert.rejects(f.service.run(f.owner, handle, agent, { task: "Review" }, async () => { throw new AgentRunError("Failed", failed); }), (error: unknown) => {
			assert.deepEqual((error as AgentRunError).result, failed); return true;
		});
		assert.equal(f.service.get(f.owner, handle).status, "failed");
		assert.equal(f.service.list(f.owner).length, 1);
	} finally { f.close(); }
});

test("stop aborts and awaits local workers while preserving their conversations", async () => {
	const f = fixture();
	try {
		const handle = f.service.create(f.owner, "Review");
		let ended = false;
		const pending = f.service.run(f.owner, handle, agent, { task: "Review" }, async (options) => {
			await new Promise<void>((resolve) => {
				if (options.signal!.aborted) resolve(); else options.signal!.addEventListener("abort", () => resolve(), { once: true });
			});
			ended = true;
			throw new AgentRunError("Cancelled", { ...result, stopReason: "aborted" });
		});
		const rejected = assert.rejects(pending, /Cancelled/);
		await getConversationService(f.root).stop("parent");
		await rejected;
		assert.equal(ended, true);
		assert.equal(f.service.get(f.owner, handle).status, "interrupted");
		assert.equal(f.service.listParent("parent").length, 1);
	} finally { f.close(); }
});
