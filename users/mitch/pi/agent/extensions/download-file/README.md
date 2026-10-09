# Download file

Provides `download_file({ url })` for HTTP(S) downloads, including signed Jira
attachment URLs. The result contains `path`, `bytes` and `contentType`. Pass the
path to `read` to inspect text or supported images; Pi detects images from their
contents.

The extension is discovered under Pi's extensions directory and is available
during workflow planning. It can also be loaded explicitly with
`pi -e /path/to/download-file/index.ts`.

Downloads use GET, follow redirects, and have a 50 MiB limit and a 60-second
timeout. The byte limit also applies to streamed or decompressed responses.
Requests use the supplied URL without added authentication headers or browser
cookies. For Jira, obtain the short-lived URL from
`downloadJiraIssueAttachment` through Atlassian MCP first.

Each download gets a private `pi-download-*` directory under the system temporary
directory and a fixed filename, `download`. Output paths and remote filenames
cannot select project files. Files have owner-only read/write permissions.
Failed or cancelled downloads are removed; successful files remain for later
reads until manually removed or cleaned by the operating system. Their paths may
therefore expire across session restarts.

The tool has normal host network access, including internal services. Use trusted
URLs and treat downloaded content as untrusted data. Signed URLs supplied as tool
arguments are retained in the conversation; avoid sharing transcripts containing
live download credentials.

Run `npm test` in this directory. Tests use deterministic responses and a local
HTTP server, with no external service credentials.
