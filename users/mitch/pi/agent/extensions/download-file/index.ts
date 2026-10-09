import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { downloadFile } from "./download.ts";

export default function downloadFileExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "download_file",
		label: "Download File",
		description: "Download an HTTP(S) URL to a private temporary file and return its path for read. Supports signed attachment URLs and redirects. Maximum 50 MiB, 60-second timeout. Output stays in the system temporary directory; project files are unchanged. Supply the URL, not a curl command.",
		parameters: Type.Object({
			url: Type.String({ minLength: 1, description: "Absolute HTTP(S) download URL, including any signed query parameters." }),
		}),
		outputSchema: Type.Object({
			path: Type.String(),
			bytes: Type.Number(),
			contentType: Type.String(),
		}),
		async execute(_id, params, signal) {
			const result = await downloadFile(params.url, signal);
			return {
				content: [{ type: "text", text: `Downloaded ${result.bytes} bytes (${result.contentType}) to ${result.path}. Use read to inspect the file.` }],
				details: result,
				structuredContent: result,
			};
		},
	});
}
