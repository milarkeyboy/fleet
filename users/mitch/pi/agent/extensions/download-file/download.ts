import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const MAX_BYTES = 50 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

export interface DownloadResult {
	path: string;
	bytes: number;
	contentType: string;
}

export async function downloadFile(url: string, signal?: AbortSignal): Promise<DownloadResult> {
	let parsed: URL;
	try { parsed = new URL(url); }
	catch { throw new Error("Provide an absolute HTTP or HTTPS URL."); }
	if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
		throw new Error("Provide an HTTP or HTTPS URL without embedded credentials. Signed download URLs are supported.");
	}

	// Bound the entire transfer, including redirects and streaming the response body.
	const controller = new AbortController();
	const transferSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]);
	let directory: string | undefined;
	try {
		transferSignal.throwIfAborted();
		const response = await fetch(parsed, { signal: transferSignal, redirect: "follow" });
		if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}.`);
		if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("Download exceeds the 50 MiB limit.");
		if (!response.body) throw new Error("Download response has no body.");

		// Ignore remote filenames and caller-chosen destinations to protect project files.
		// Successful files remain available for later reads and resumed conversations.
		directory = await mkdtemp(path.join(os.tmpdir(), "pi-download-"));
		const filePath = path.join(directory, "download");
		let bytes = 0;
		await pipeline(
			response.body,
			async function* (chunks) {
				for await (const chunk of chunks) {
					bytes += chunk.byteLength;
					if (bytes > MAX_BYTES) throw new Error("Download exceeds the 50 MiB limit.");
					yield chunk;
				}
			},
			createWriteStream(filePath, { flags: "wx", mode: 0o600 }),
			{ signal: transferSignal },
		);
		transferSignal.throwIfAborted();
		return { path: filePath, bytes, contentType: response.headers.get("content-type") ?? "application/octet-stream" };
	} catch (error) {
		if (directory) await rm(directory, { recursive: true, force: true });
		throw error;
	} finally {
		// Release unread response bodies after HTTP errors, oversized headers or cancellation.
		controller.abort();
	}
}
