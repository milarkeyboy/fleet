import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AgentRunOptions {
	cwd: string;
	roleName: string;
	sessionFile: string;
	systemPrompt: string;
	task: string;
	skillPaths: string[];
	tools: string[];
	model: string;
	thinkingLevel?: string;
	contextFileDiscovery?: boolean;
	signal?: AbortSignal;
	onUpdate?: (text: string) => void;
	/** Track child ownership: 0 fences the spawn window; undefined records completed cleanup. */
	onProcess?: (pid: number | undefined) => void;
}

export interface AgentRunResult {
	exitCode: number;
	output: string;
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
	messages: unknown[];
}

// Subagents explicitly load the policy while opting out of extension discovery,
// so repository and user extensions cannot change the command guardrail.
export const BASH_POLICY_EXTENSION_PATH = fileURLToPath(new URL("../bash-policy/index.ts", import.meta.url));

function invocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const executable = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function textFromMessage(message: any): string {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("\n");
}

export function buildAgentArgs(options: AgentRunOptions, promptPath: string): string[] {
	const args = [
		"--mode", "json",
		"-p",
		"--session", options.sessionFile,
		"--no-extensions",
		"-e", BASH_POLICY_EXTENSION_PATH,
		"--no-skills",
		...options.skillPaths.flatMap((skillPath) => ["--skill", skillPath]),
		"--no-prompt-templates",
		"--tools", options.tools.join(","),
		"--append-system-prompt", promptPath,
	];
	if (options.contextFileDiscovery === false) args.push("--no-context-files");
	args.push("--model", options.model);
	args.push("--thinking", options.thinkingLevel ?? "off");
	args.push(`Task: ${options.task}`);
	return args;
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
	options.signal?.throwIfAborted();
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-workflow-"));
	const promptPath = path.join(tempDir, `${options.roleName.replace(/[^\w.-]/g, "_")}.md`);
	const result: AgentRunResult = { exitCode: 1, output: "", stderr: "", messages: [] };
	try {
		await writeFile(promptPath, options.systemPrompt, { encoding: "utf8", mode: 0o600 });
		const launch = invocation(buildAgentArgs(options, promptPath));
		options.signal?.throwIfAborted();
		result.exitCode = await new Promise<number>((resolve, reject) => {
			options.onProcess?.(0);
			const child = spawn(launch.command, launch.args, {
				cwd: options.cwd,
				shell: false,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			});
			// An implementer's shell descendants must stop before snapshots or deletion.
			const kill = (signal: NodeJS.Signals) => {
				try {
					if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
					else child.kill(signal);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") result.stderr += String(error);
				}
			};
			let timer: ReturnType<typeof setTimeout> | undefined;
			let aborted = false;
			const abort = () => {
				if (aborted) return;
				aborted = true;
				kill("SIGTERM");
				timer = setTimeout(() => kill("SIGKILL"), 5_000);
				timer.unref?.();
			};
			let trackingError: unknown;
			try { options.onProcess?.(child.pid); }
			catch (error) { trackingError = error; abort(); }
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			let buffer = "";
			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line);
					if (event.type === "message_end" && event.message) {
						result.messages.push(event.message);
						const text = textFromMessage(event.message);
						if (text) options.onUpdate?.(text);
						if (event.message.role === "assistant") {
							result.output = text;
							result.stopReason = event.message.stopReason;
							result.errorMessage = event.message.errorMessage;
						}
					}
				} catch {
					// Ignore non-JSON diagnostic lines on stdout.
				}
			};
			child.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			child.stderr.on("data", (data) => { result.stderr += data.toString(); });
			child.on("error", (error) => { result.stderr += error.message; });
			child.on("close", (code) => {
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
				if (aborted) kill("SIGKILL");
				if (buffer.trim()) processLine(buffer);
				try { options.onProcess?.(undefined); }
				catch (error) { trackingError ??= error; }
				if (trackingError) reject(trackingError);
				else resolve(code ?? 1);
			});
			if (options.signal?.aborted) abort();
			else options.signal?.addEventListener("abort", abort, { once: true });
		});
		options.signal?.throwIfAborted();
		if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || result.stopReason === "length") {
			throw new Error(result.errorMessage || result.stderr || `${options.roleName} ended with ${result.stopReason ?? `exit code ${result.exitCode}`}`);
		}
		return result;
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

export function extractProtocolJson<T>(output: string, tag: string): T {
	const pattern = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i");
	const match = output.match(pattern);
	if (!match) throw new Error(`Agent output did not contain <${tag}> structured result.`);
	try {
		return JSON.parse(match[1]) as T;
	} catch (error) {
		throw new Error(`Invalid ${tag} JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}
