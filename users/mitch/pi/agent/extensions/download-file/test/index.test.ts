// Pi tool registration and the direct/codemode result contract.
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";

const loader = registerHooks({ resolve(name, context, next) {
	return name === "typebox" ? {
		url: `data:text/javascript,${encodeURIComponent('export const Type = { Object: (properties) => ({ properties }), String: () => ({}), Number: () => ({}) };')}`,
		shortCircuit: true,
	} : next(name, context);
} });
const { default: extension } = await import("../index.ts");
loader.deregister();

function toolFixture() {
	let tool: any;
	extension({ registerTool(value: any) { tool = value; } } as any);
	return tool;
}

test("download_file exposes a URL input and structured file metadata", () => {
	const tool = toolFixture();
	assert.equal(tool.name, "download_file");
	assert.deepEqual(Object.keys(tool.parameters.properties), ["url"]);
	assert.deepEqual(Object.keys(tool.outputSchema.properties), ["path", "bytes", "contentType"]);
});

test("download results supply a readable path to direct and codemode callers", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response("reference", { headers: { "Content-Type": "text/plain" } }));
	const result = await toolFixture().execute("call", { url: "https://example.com/reference" }, undefined);
	try {
		assert.equal(await readFile(result.details.path, "utf8"), "reference");
		assert.deepEqual(result.structuredContent, { path: result.details.path, bytes: 9, contentType: "text/plain" });
		assert.match(result.content[0].text, /Use read to inspect the file/);
		assert.ok(result.content[0].text.includes(result.details.path));
	} finally { await rm(path.dirname(result.details.path), { recursive: true, force: true }); }
});
