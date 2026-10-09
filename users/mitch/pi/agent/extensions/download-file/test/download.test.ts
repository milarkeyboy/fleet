// HTTP transport, destination isolation, transfer limits, and failure cleanup.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import { downloadFile } from "../download.ts";

// Isolate temporary-file assertions from downloads in other test workers.
const originalTemp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
let testTemp: string;
before(async () => {
	testTemp = await mkdtemp(path.join(os.tmpdir(), "download-tests-"));
	for (const name of Object.keys(originalTemp)) process.env[name] = testTemp;
});
after(async () => {
	for (const [name, value] of Object.entries(originalTemp)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	await rm(testTemp, { recursive: true, force: true });
});

async function serverFixture(handler: (url: string, response: ServerResponse) => void) {
	const server = createServer((request, response) => handler(request.url!, response));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as { port: number };
	return {
		url: `http://127.0.0.1:${address.port}`,
		async close() {
			const closed = once(server, "close");
			server.close();
			server.closeAllConnections();
			await closed;
		},
	};
}

async function downloadDirectories() {
	return (await readdir(os.tmpdir())).filter((name) => name.startsWith("pi-download-")).sort();
}

async function removeDownload(filePath: string) {
	await rm(path.dirname(filePath), { recursive: true, force: true });
}

test("signed URLs preserve their query parameters and download binary content", async () => {
	let requestedUrl = "";
	const server = await serverFixture((url, response) => {
		requestedUrl = url;
		response.setHeader("Content-Type", "image/png");
		response.end(Buffer.from([0, 1, 255, 128]));
	});
	let filePath: string | undefined;
	try {
		const result = await downloadFile(`${server.url}/attachment?token=a%2Bb&expires=123`);
		filePath = result.path;
		assert.equal(requestedUrl, "/attachment?token=a%2Bb&expires=123");
		assert.deepEqual(await readFile(result.path), Buffer.from([0, 1, 255, 128]));
		assert.equal(result.bytes, 4);
		assert.equal(result.contentType, "image/png");
	} finally {
		if (filePath) await removeDownload(filePath);
		await server.close();
	}
});

test("redirects are followed before saving the final response", async () => {
	const server = await serverFixture((url, response) => {
		if (url === "/redirect") { response.writeHead(302, { Location: "/file" }); response.end(); }
		else response.end("redirected");
	});
	let filePath: string | undefined;
	try {
		const result = await downloadFile(`${server.url}/redirect`);
		filePath = result.path;
		assert.equal(await readFile(result.path, "utf8"), "redirected");
	} finally {
		if (filePath) await removeDownload(filePath);
		await server.close();
	}
});

test("remote filenames cannot select destinations and each download is private", async () => {
	const server = await serverFixture((_url, response) => {
		response.setHeader("Content-Disposition", 'attachment; filename="../../project-file"');
		response.end("reference");
	});
	const files: string[] = [];
	try {
		for (let i = 0; i < 2; i++) files.push((await downloadFile(`${server.url}/../../project-file`)).path);
		assert.notEqual(files[0], files[1]);
		for (const file of files) {
			assert.equal(path.dirname(path.dirname(file)), os.tmpdir());
			assert.match(path.basename(path.dirname(file)), /^pi-download-/);
			assert.equal(path.basename(file), "download");
			if (process.platform !== "win32") {
				assert.equal((await stat(file)).mode & 0o777, 0o600);
				assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
			}
		}
	} finally {
		for (const file of files) await removeDownload(file);
		await server.close();
	}
});

test("unsupported URLs and embedded credentials fail before any request", async (t) => {
	const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
	for (const url of ["relative/path", "file:///tmp/image", "ftp://example.com/file", "https://user:secret@example.com/file"]) {
		await assert.rejects(downloadFile(url), /HTTP or HTTPS URL/);
	}
	assert.equal(fetch.mock.callCount(), 0);
});

test("HTTP errors leave no download directory and omit response contents", async () => {
	const before = await downloadDirectories();
	const server = await serverFixture((_url, response) => { response.writeHead(403); response.end("secret response"); });
	try {
		await assert.rejects(downloadFile(`${server.url}/private`), { message: "Download failed: HTTP 403." });
		assert.deepEqual(await downloadDirectories(), before);
	} finally { await server.close(); }
});

test("oversized Content-Length is rejected before writing a file", async (t) => {
	const before = await downloadDirectories();
	t.mock.method(globalThis, "fetch", async () => new Response("", { headers: { "Content-Length": "52428801" } }));
	await assert.rejects(downloadFile("https://example.com/large"), /50 MiB limit/);
	assert.deepEqual(await downloadDirectories(), before);
});

test("streamed responses exceeding the byte limit have their partial files removed", async (t) => {
	const before = await downloadDirectories();
	t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
		start(controller) { controller.enqueue(new Uint8Array(52428801)); controller.close(); },
	})));
	await assert.rejects(downloadFile("https://example.com/stream"), /50 MiB limit/);
	assert.deepEqual(await downloadDirectories(), before);
});

test("an interrupted response removes the partial download", async (t) => {
	const before = await downloadDirectories();
	let sent = false;
	t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
		pull(controller) {
			if (sent) controller.error(new Error("Disconnected"));
			else { sent = true; controller.enqueue(new Uint8Array([1, 2, 3])); }
		},
	})));
	await assert.rejects(downloadFile("https://example.com/broken"), /Disconnected/);
	assert.deepEqual(await downloadDirectories(), before);
});

test("an already cancelled download makes no request", async (t) => {
	const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
	await assert.rejects(downloadFile("https://example.com/file", AbortSignal.abort()), { name: "AbortError" });
	assert.equal(fetch.mock.callCount(), 0);
});

test("cancelling a streaming response removes the partial download", async (t) => {
	const before = await downloadDirectories();
	const abort = new AbortController();
	let sent = false;
	t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
		pull(controller) {
			if (sent) abort.abort();
			else { sent = true; controller.enqueue(new Uint8Array([1, 2, 3])); }
		},
	})));
	await assert.rejects(downloadFile("https://example.com/slow", abort.signal), { name: "AbortError" });
	assert.deepEqual(await downloadDirectories(), before);
});
