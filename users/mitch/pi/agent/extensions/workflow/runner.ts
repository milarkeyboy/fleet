import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface AgentRunOptions {
	cwd: string;
	roleName: string;
	systemPrompt: string;
	task: string;
	skillPaths: string[];
	tools: string[];
	model: string;
	thinkingLevel?: string;
	signal?: AbortSignal;
	onUpdate?: (text: string) => void;
}

export interface AgentRunResult {
	exitCode: number;
	output: string;
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
	messages: unknown[];
}

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
		"--no-session",
		"--no-extensions",
		"--no-skills",
		...options.skillPaths.flatMap((skillPath) => ["--skill", skillPath]),
		"--no-prompt-templates",
		"--no-context-files",
		"--tools", options.tools.join(","),
		"--append-system-prompt", promptPath,
	];
	args.push("--model", options.model);
	if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
	args.push(`Task: ${options.task}`);
	return args;
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-workflow-"));
	const promptPath = path.join(tempDir, `${options.roleName.replace(/[^\w.-]/g, "_")}.md`);
	await writeFile(promptPath, options.systemPrompt, { encoding: "utf8", mode: 0o600 });
	const args = buildAgentArgs(options, promptPath);

	const result: AgentRunResult = { exitCode: 1, output: "", stderr: "", messages: [] };
	try {
		const launch = invocation(args);
		result.exitCode = await new Promise<number>((resolve) => {
			const child = spawn(launch.command, launch.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line);
					if (event.type === "message_end" && event.message) {
						result.messages.push(event.message);
						const text = textFromMessage(event.message);
						if (text) {
							result.output = text;
							options.onUpdate?.(text);
						}
						if (event.message.role === "assistant") {
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
			child.on("error", (error) => { result.stderr += error.message; resolve(1); });
			child.on("close", (code) => { if (buffer.trim()) processLine(buffer); resolve(code ?? 1); });

			const abort = () => {
				child.kill("SIGTERM");
				setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
			};
			if (options.signal?.aborted) abort();
			else options.signal?.addEventListener("abort", abort, { once: true });
		});
		if (result.exitCode !== 0 || result.stopReason === "error") {
			throw new Error(result.errorMessage || result.stderr || `${options.roleName} exited with ${result.exitCode}`);
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
