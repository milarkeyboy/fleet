// Structured Git inspection for agents whose tools are restricted to repository reads.
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const executeFile = promisify(execFile);
// Repository configuration can otherwise run helpers or refresh the index during reads.
const GIT_OPTIONS = ["--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "color.ui=false"];
const Parameters = Type.Object({
	operation: Type.Union(["status", "diff", "log", "show", "blame"].map((operation) => Type.Literal(operation))),
	revisions: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 2, description: "Git revisions or ranges. Diff accepts up to two; log, show and blame accept one. Defaults follow Git (show: HEAD; blame: worktree)." })),
	paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Literal paths relative to the working directory. Blame requires exactly one." })),
	staged: Type.Optional(Type.Boolean({ description: "Diff the index rather than unstaged worktree changes; only valid for diff." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Maximum log entries (default 20); only valid for log." })),
}, { additionalProperties: false });

type Inspection = Static<typeof Parameters>;

/** Keep all executable behaviour fixed; caller inputs select revisions and literal paths only. */
export function gitArguments(input: Inspection): string[] {
	const { operation, revisions = [], paths = [], staged, limit } = input;
	if (!["status", "diff", "log", "show", "blame"].includes(operation)) throw new Error("Unknown Git inspection operation.");
	if (revisions.length > (operation === "status" ? 0 : operation === "diff" ? 2 : 1)) throw new Error("Too many revisions for this operation.");
	if (revisions.some((revision) => !revision || revision.startsWith("-") || /[\x00-\x1f\x7f]/.test(revision))) throw new Error("Revisions must be non-empty and cannot contain options or control characters.");
	if (paths.some((file) => !file || file.includes("\0"))) throw new Error("Paths must be non-empty and contain no NUL characters.");
	if (staged !== undefined && operation !== "diff") throw new Error("staged is only valid for diff.");
	if (limit !== undefined && (operation !== "log" || !Number.isInteger(limit) || limit < 1 || limit > 200)) throw new Error("limit must be 1–200 and is only valid for log.");
	if (operation === "blame" && paths.length !== 1) throw new Error("blame requires exactly one path.");
	if (staged && revisions.length > 1) throw new Error("Staged diff accepts at most one revision.");

	const args = [operation];
	switch (operation) {
		case "status": args.push("--short", "--untracked-files=normal", "--ignore-submodules=all"); break;
		case "diff":
			args.push("--no-ext-diff", "--no-textconv", "--ignore-submodules=all");
			if (staged) args.push("--cached");
			break;
		case "log": args.push("--no-show-signature", "--format=medium", `--max-count=${limit ?? 20}`); break;
		case "show": args.push("--no-ext-diff", "--no-textconv", "--no-show-signature", "--format=fuller", "--ignore-submodules=all"); break;
		case "blame": args.push("--no-textconv"); break;
	}
	args.push(...revisions, "--", ...paths);
	return args;
}

export default function gitInspect(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "git_inspect",
		label: "Git inspection",
		description: "Read local Git status, diffs, history, objects and blame in the current working directory. Supply structured parameters. Paths are literal. Git helpers, pagers, text conversion, lazy fetching and optional index writes are disabled. Output over 2000 lines or 50 KiB is saved in full to a private temporary file for read. Commands time out after 30 seconds; capture is limited to 64 MiB.",
		parameters: Parameters,
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		async execute(_id, input, signal, _onUpdate, ctx) {
			const args = gitArguments(input);
			signal?.throwIfAborted();
			const run = (arguments_: string[], config: { key: string; value: string }[] = []) => {
				const env: NodeJS.ProcessEnv = {
					...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1",
					GIT_CONFIG_PARAMETERS: "",
				};
				// Separate keys and values preserve filter names containing '='. Append overrides
				// after inherited entries, and ignore inherited command-line config of higher priority.
				const inherited = Number(env.GIT_CONFIG_COUNT ?? 0);
				for (const [index, { key, value }] of config.entries()) {
					env[`GIT_CONFIG_KEY_${inherited + index}`] = key;
					env[`GIT_CONFIG_VALUE_${inherited + index}`] = value;
				}
				if (config.length) env.GIT_CONFIG_COUNT = String(inherited + config.length);
				return executeFile("git", [...GIT_OPTIONS, ...arguments_], {
					cwd: ctx.cwd, signal, timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
					encoding: "utf8", shell: false, env,
				});
			};
			let output: string;
			try {
				// Clean and process filters also run during status, diff and blame. Override every
				// configured filter command before inspecting content, including required filters.
				const filters = await run(["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"])
					.catch((error) => {
						if (error.code === 1) return { stdout: "", stderr: "" };
						throw error;
					});
				const overrides = [...new Set(filters.stdout.split("\0").filter(Boolean))]
					.map((key) => ({ key, value: key.endsWith(".required") ? "false" : "" }));
				const result = await run(args, overrides);
				output = result.stdout + result.stderr;
			} catch (error) {
				signal?.throwIfAborted();
				const failure = error as Error & { stderr?: string };
				throw new Error(`Git inspection failed: ${truncateHead(failure.stderr || failure.message).content}`);
			}

			// Preserve large patches outside the worktree so restricted reviewers can inspect every hunk.
			const preview = truncateHead(output);
			let fullOutputPath: string | undefined;
			if (preview.truncated) {
				const directory = await mkdtemp(path.join(os.tmpdir(), "pi-git-inspect-"));
				fullOutputPath = path.join(directory, "output.txt");
				await writeFile(fullOutputPath, output, { encoding: "utf8", mode: 0o600 });
			}
			return {
				content: [{ type: "text", text: (preview.content || "No output.") + (fullOutputPath ? `\n\n[Output truncated. Full output: ${fullOutputPath}. Use read to inspect the file.]` : "") }],
				details: { truncated: preview.truncated, fullOutputPath },
			};
		},
	});
}
