// Git inspection behaviour and guardrails, exercised against disposable local repositories.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import extension, { gitArguments } from "../index.ts";

/** Register the model-facing tool and provide committed, staged and unstaged content. */
function fixture(t: TestContext) {
	const root = mkdtempSync(path.join(os.tmpdir(), "git-inspect-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
	});
	git("init", "--quiet", "-b", "main");
	git("config", "user.name", "Reviewer");
	git("config", "user.email", "reviewer@example.com");
	writeFileSync(path.join(root, "source.txt"), "original\n");
	git("add", "source.txt");
	git("commit", "--quiet", "-m", "Initial content");
	writeFileSync(path.join(root, "source.txt"), "staged\n");
	git("add", "source.txt");
	writeFileSync(path.join(root, "source.txt"), "worktree\n");
	let tool: any;
	extension({ registerTool(value: any) { tool = value; } } as any);
	const inspect = (input: object, signal?: AbortSignal) => tool.execute("test", input, signal, undefined, { cwd: root });
	return { root, git, tool, inspect };
}

test("status reports staged and unstaged changes", async (t) => {
	const f = fixture(t);
	const result = await f.inspect({ operation: "status" });
	assert.equal(result.content[0].text, "MM source.txt\n");
});

test("diff compares the worktree with the index by default", async (t) => {
	const f = fixture(t);
	const result = await f.inspect({ operation: "diff", paths: ["source.txt"] });
	assert.match(result.content[0].text, /-staged\n\+worktree\n/);
});

test("staged diff compares the index with HEAD", async (t) => {
	const f = fixture(t);
	const result = await f.inspect({ operation: "diff", staged: true });
	assert.match(result.content[0].text, /-original\n\+staged\n/);
});

test("diff accepts two revisions for historical comparisons", async (t) => {
	const f = fixture(t);
	f.git("commit", "--quiet", "-m", "Staged content");
	const result = await f.inspect({ operation: "diff", revisions: ["HEAD~1", "HEAD"] });
	assert.match(result.content[0].text, /-original\n\+staged\n/);
});

test("log honours the requested entry limit", async (t) => {
	const f = fixture(t);
	f.git("commit", "--quiet", "-m", "Staged content");
	const result = await f.inspect({ operation: "log", limit: 1 });
	assert.match(result.content[0].text, /Staged content/);
	assert.doesNotMatch(result.content[0].text, /Initial content/);
});

test("log accepts revision ranges", async (t) => {
	const f = fixture(t);
	f.git("commit", "--quiet", "-m", "Staged content");
	const result = await f.inspect({ operation: "log", revisions: ["HEAD~1..HEAD"] });
	assert.match(result.content[0].text, /Staged content/);
	assert.doesNotMatch(result.content[0].text, /Initial content/);
});

test("show reads committed file content", async (t) => {
	const f = fixture(t);
	const result = await f.inspect({ operation: "show", revisions: ["HEAD:source.txt"] });
	assert.equal(result.content[0].text, "original\n");
});

test("show defaults to the HEAD commit patch", async (t) => {
	const f = fixture(t);
	const result = await f.inspect({ operation: "show" });
	assert.match(result.content[0].text, /Initial content/);
	assert.match(result.content[0].text, /\+original\n/);
});

test("blame attributes a committed file to its author", async (t) => {
	const f = fixture(t);
	const result = await f.inspect({ operation: "blame", revisions: ["HEAD"], paths: ["source.txt"] });
	assert.match(result.content[0].text, /Reviewer.*1\) original\n/);
});

test("paths containing shell syntax are passed literally", async (t) => {
	const f = fixture(t);
	const file = "$(touch sentinel).txt";
	writeFileSync(path.join(f.root, file), "literal\n");
	f.git("add", "--", file);
	const result = await f.inspect({ operation: "diff", staged: true, paths: [file] });
	assert.match(result.content[0].text, /\+literal\n/);
	assert.equal(existsSync(path.join(f.root, "sentinel")), false);
});

test("pathspec magic is treated as a literal filename", async (t) => {
	const f = fixture(t);
	const result = await f.inspect({ operation: "diff", paths: [":(glob)*.txt"] });
	assert.equal(result.content[0].text, "No output.");
});

test("revision inputs cannot inject Git options", () => {
	for (const revision of ["--output=sentinel", "--ext-diff", "-c", "HEAD\n--output=sentinel"]) {
		assert.throws(() => gitArguments({ operation: "diff", revisions: [revision] }), /cannot contain options or control characters/);
	}
});

test("status rejects revisions", () => {
	assert.throws(() => gitArguments({ operation: "status", revisions: ["HEAD"] }), /Too many revisions/);
});

test("staged selection is restricted to diff", () => {
	assert.throws(() => gitArguments({ operation: "show", staged: true }), /only valid for diff/);
});

test("log rejects entry limits outside the supported range", () => {
	for (const limit of [0, 201, 1.5]) {
		assert.throws(() => gitArguments({ operation: "log", limit }), /limit must be/);
	}
});

test("blame requires a single path", () => {
	assert.throws(() => gitArguments({ operation: "blame" }), /exactly one path/);
});

test("staged diff accepts at most one revision", () => {
	assert.throws(() => gitArguments({ operation: "diff", staged: true, revisions: ["HEAD~1", "HEAD"] }), /at most one revision/);
});

test("repository-configured helpers remain disabled across inspection operations", async (t) => {
	const f = fixture(t);
	const marker = path.join(f.root, "helper-ran");
	const helper = path.join(f.root, "helper");
	writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
	writeFileSync(path.join(f.root, ".gitattributes"), "*.txt diff=inspection\n");
	f.git("config", "diff.external", helper);
	f.git("config", "diff.inspection.textconv", helper);
	f.git("config", "core.fsmonitor", helper);
	for (const operation of ["status", "diff", "log", "show", "blame"]) {
		await f.inspect({ operation, paths: ["source.txt"] });
	}
	assert.equal(existsSync(marker), false);
});

for (const [kind, driver] of [["clean", "inspection"], ["process", "inspection"], ["clean", "a=b"], ["process", "a=b"]]) {
	test(`required ${kind} filter '${driver}' remains disabled during worktree inspection`, async (t) => {
		const f = fixture(t);
		const marker = path.join(f.root, "filter-ran");
		const helper = path.join(f.root, "filter");
		writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
		writeFileSync(path.join(f.root, ".gitattributes"), `*.txt filter=${driver}\n`);
		f.git("config", `filter.${driver}.${kind}`, helper);
		f.git("config", `filter.${driver}.required`, "true");
		for (const operation of ["status", "diff", "blame"]) {
			await f.inspect({ operation, paths: ["source.txt"] });
		}
		assert.equal(existsSync(marker), false);
	});
}

test("filter overrides take precedence over inherited Git environment entries", async (t) => {
	const f = fixture(t);
	const marker = path.join(f.root, "filter-ran");
	writeFileSync(path.join(f.root, ".gitattributes"), "*.txt filter=inspection\n");
	const environment = {
		GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "filter.inspection.clean",
		GIT_CONFIG_VALUE_0: `touch '${marker}'`,
		GIT_CONFIG_PARAMETERS: `'filter.inspection.clean=touch "${marker}"'`,
	};
	for (const [key, value] of Object.entries(environment)) {
		const previous = process.env[key];
		process.env[key] = value;
		t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
	}
	await f.inspect({ operation: "diff" });
	assert.equal(existsSync(marker), false);
});

test("inspection preserves both index bytes and worktree content", async (t) => {
	const f = fixture(t);
	const index = readFileSync(path.join(f.root, ".git/index"));
	const timestamp = statSync(path.join(f.root, ".git/index")).mtimeMs;
	for (const operation of ["status", "diff", "log", "show", "blame"]) {
		await f.inspect({ operation, paths: ["source.txt"] });
	}
	assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), index);
	assert.equal(statSync(path.join(f.root, ".git/index")).mtimeMs, timestamp);
	assert.equal(readFileSync(path.join(f.root, "source.txt"), "utf8"), "worktree\n");
});

test("large output remains available in a private temporary file", async (t) => {
	const f = fixture(t);
	writeFileSync(path.join(f.root, "source.txt"), "large output\n".repeat(2500));
	const result = await f.inspect({ operation: "diff" });
	const fullPath = result.details.fullOutputPath;
	t.after(() => rmSync(path.dirname(fullPath), { recursive: true, force: true }));
	assert.equal(result.details.truncated, true);
	assert.match(result.content[0].text, /Output truncated.*Use read/);
	assert.ok(readFileSync(fullPath, "utf8").endsWith("+large output\n"));
	assert.equal(statSync(path.dirname(fullPath)).mode & 0o777, 0o700);
	assert.equal(statSync(fullPath).mode & 0o777, 0o600);
});

test("Git failures produce failed tool calls with diagnostic output", async (t) => {
	const f = fixture(t);
	await assert.rejects(f.inspect({ operation: "show", revisions: ["missing-revision"] }), /Git inspection failed: fatal:/);
});

test("cancelled requests stop before launching Git", async (t) => {
	const f = fixture(t);
	await assert.rejects(f.inspect({ operation: "status" }, AbortSignal.abort()), { name: "AbortError" });
});
