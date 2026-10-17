import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Usage } from "@earendil-works/pi-ai";
import { updateAssistant } from "./transcript.ts";

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
	onEvent?: (event: Record<string, any>) => void;
	onStderr?: (text: string) => void;
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
	usage?: Usage;
}

export class AgentRunError extends Error {
	readonly result: AgentRunResult;
	constructor(message: string, result: AgentRunResult) { super(message); this.result = result; }
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
	if (typeof options.sessionFile !== "string" || !path.isAbsolute(options.sessionFile)) throw new Error("An absolute native session path is required.");
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
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const promptPath = path.join(tempDir, `${options.roleName.replace(/[^\w.-]/g, "_")}.md`);
	const result: AgentRunResult = { exitCode: 1, output: "", stderr: "", messages: [] };
	let partial: Record<string, any> | undefined;
	const notify = (callback: (() => unknown) | undefined) => {
		try {
			const value = callback?.();
			if (value && typeof (value as PromiseLike<unknown>).then === "function") void Promise.resolve(value).catch(() => {});
		} catch { /* Progress observer failures are isolated from worker execution. */ }
	};
	const update = (text: string) => notify(() => options.onUpdate?.(text));
	try {
		options.signal?.throwIfAborted();
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
				let event: any;
				try { event = JSON.parse(line); }
				catch { return; }
				if (!event || typeof event !== "object" || Array.isArray(event)) return;
				notify(() => options.onEvent?.(structuredClone(event)));
				if (event.type === "compaction_end" && event.result?.usage) result.usage = addUsage(result.usage, event.result.usage);
				if (event.type === "tool_execution_start") update(`Running ${event.toolName}`);
				if (event.type === "message_start" && event.message?.role === "assistant") partial = structuredClone(event.message);
				if (event.type === "message_update") {
					partial ??= { role: "assistant", content: [], stopReason: "pending" };
					updateAssistant(partial, event);
					result.output = textFromMessage(partial);
					if (event.assistantMessageEvent?.type === "text_delta") update(event.assistantMessageEvent.delta);
				}
				if (event.type === "message_end" && event.message) {
					result.messages.push(event.message);
					const text = textFromMessage(event.message);
					if (text) update(text);
					if (event.message.role === "assistant") {
						result.output = text;
						result.stopReason = event.message.stopReason;
						result.errorMessage = event.message.errorMessage;
						if (event.message.usage) result.usage = addUsage(result.usage, event.message.usage);
						partial = undefined;
					}
				}
			};
			child.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			const stderr = (text: string) => { result.stderr += text; notify(() => options.onStderr?.(text)); };
			child.stderr.on("data", (data) => stderr(data.toString()));
			child.on("error", (error) => stderr(error.message));
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
		if (partial) {
			result.stopReason = "error";
			result.errorMessage ??= `${options.roleName} exited before completing its response.`;
		}
		if (result.exitCode !== 0 || !result.output.trim() || result.stopReason === "error" || result.stopReason === "aborted" || result.stopReason === "length") {
			throw new AgentRunError(result.errorMessage || result.stderr || `${options.roleName} ended with ${result.stopReason ?? `exit code ${result.exitCode}`} and ${result.output.trim() ? "partial output" : "no output"}.`, result);
		}
		return result;
	} catch (error) {
		if (partial) {
			result.messages.push(partial);
			result.output = textFromMessage(partial);
			if (partial.usage) result.usage = addUsage(result.usage, partial.usage as Usage);
		}
		if (options.signal?.aborted) result.stopReason = "aborted";
		if (error instanceof AgentRunError) throw error;
		result.errorMessage = error instanceof Error ? error.message : String(error);
		throw new AgentRunError(result.errorMessage, result);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

function addUsage(total: Usage | undefined, next: Usage): Usage {
	return {
		input: (total?.input ?? 0) + next.input,
		output: (total?.output ?? 0) + next.output,
		cacheRead: (total?.cacheRead ?? 0) + next.cacheRead,
		cacheWrite: (total?.cacheWrite ?? 0) + next.cacheWrite,
		...(total?.cacheWrite1h !== undefined || next.cacheWrite1h !== undefined ? { cacheWrite1h: (total?.cacheWrite1h ?? 0) + (next.cacheWrite1h ?? 0) } : {}),
		...(total?.reasoning !== undefined || next.reasoning !== undefined ? { reasoning: (total?.reasoning ?? 0) + (next.reasoning ?? 0) } : {}),
		totalTokens: (total?.totalTokens ?? 0) + next.totalTokens,
		cost: {
			input: (total?.cost.input ?? 0) + next.cost.input,
			output: (total?.cost.output ?? 0) + next.cost.output,
			cacheRead: (total?.cost.cacheRead ?? 0) + next.cost.cacheRead,
			cacheWrite: (total?.cost.cacheWrite ?? 0) + next.cost.cacheWrite,
			total: (total?.cost.total ?? 0) + next.cost.total,
		},
	};
}
