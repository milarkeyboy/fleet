import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, requireAgent } from "./agents.ts";
import { getConversationService, type ConversationOwner } from "./api.ts";
import { createSubprocessModelRegistry, requireExecutableAgents } from "./models.ts";
import type { AgentRunResult } from "./runner.ts";
import { showSubagents } from "./viewer.ts";

const OUTPUT_LIMIT = 50 * 1024;
function bounded(text: string): string {
	if (Buffer.byteLength(text) <= OUTPUT_LIMIT) return text;
	const suffix = "\n[Output truncated; full result is retained in tool details.]";
	const prefix = new TextDecoder().decode(Buffer.from(text).subarray(0, OUTPUT_LIMIT - Buffer.byteLength(suffix)), { stream: true });
	return prefix + suffix;
}

export default function subagentExtension(pi: ExtensionAPI): void {
	const found = discoverAgents(getAgentDir());
	const service = getConversationService(path.join(getAgentDir(), "subagents"));
	const active = new Map<AbortController, { parent: string; done: Promise<unknown> }>();
	let viewer: { controller: AbortController; done: Promise<void> } | undefined;
	const owner = (ctx: ExtensionContext): ConversationOwner => ({ parentSessionId: ctx.sessionManager.getSessionId(), creator: "adhoc", cwd: ctx.cwd });

	pi.registerTool({
		name: "subagent", label: "Subagent",
		description: [
			"Delegate a task to a global subagent. Omit handle for a new conversation; supply an owned handle to continue one.",
			"Conversations persist until explicitly deleted. Use subagent_list after resuming the parent to find existing handles.",
			"Supply all necessary context in the task; children share the working tree. Avoid conflicting concurrent work.",
			"Available agents:", ...Object.values(found.agents).map((agent) => `${agent.name}: ${agent.description}`), ...found.diagnostics,
		].join("\n"),
		parameters: Type.Object({
			agent: Type.String({ minLength: 1, description: "Global agent definition to use for this invocation" }),
			task: Type.String({ minLength: 1, description: "Self-contained assignment and relevant context" }),
			handle: Type.Optional(Type.String({ description: "Owned conversation handle from an earlier invocation" })),
		}),
		outputSchema: Type.Object({ handle: Type.String(), output: Type.String(), error: Type.Optional(Type.String()) }),
		async execute(_id, params, signal, onUpdate, ctx) {
			const controller = new AbortController();
			const combined = AbortSignal.any([controller.signal, signal, ctx.signal].filter((value): value is AbortSignal => value !== undefined));
			const creator = owner(ctx);
			const done = (async () => {
				combined.throwIfAborted();
				const agent = requireAgent(discoverAgents(getAgentDir()), params.agent);
				if (params.handle) service.get(creator, params.handle);
				await requireExecutableAgents([agent], await createSubprocessModelRegistry(combined));
				combined.throwIfAborted();
				const handle = params.handle ?? service.create(creator, `${agent.name}: ${params.task.split("\n")[0].slice(0, 120)}`);
				let result: AgentRunResult | undefined;
				let error: string | undefined;
				try {
					result = await service.run(creator, handle, agent, {
						task: params.task, signal: combined,
						onUpdate(text) { onUpdate?.({ content: [{ type: "text", text: bounded(text) }], details: { handle } }); },
					});
				} catch (failure) {
					error = (failure instanceof Error ? failure.message : String(failure)) || "Subagent invocation failed.";
					result = (failure as { result?: AgentRunResult })?.result;
				}
				const output = bounded(result?.output ?? "");
				return {
					content: [{ type: "text" as const, text: bounded(`Subagent handle: ${handle}\n\n${error ? `${error}\n\n` : ""}${result?.output ?? ""}`) }],
					structuredContent: { handle, output, ...(error ? { error } : {}) },
					details: { handle, result }, usage: result?.usage, ...(error ? { isError: true } : {}),
				};
			})();
			active.set(controller, { parent: creator.parentSessionId, done });
			try { return await done; } finally { active.delete(controller); }
		},
	});
	pi.registerTool({
		name: "subagent_list", label: "List Subagents",
		description: "List the current parent's owned ad-hoc conversations, including handles retained across restarts. Workflow conversations are managed by workflow and remain visible in /subagents.",
		annotations: { readOnlyHint: true },
		parameters: Type.Object({}),
		outputSchema: Type.Object({ conversations: Type.Array(Type.Object({ handle: Type.String(), label: Type.String(), status: Type.String() }, { additionalProperties: true })) }),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const conversations = service.list(owner(ctx));
			return {
				content: [{ type: "text", text: bounded(JSON.stringify(conversations, null, 2)) }],
				structuredContent: JSON.parse(JSON.stringify({ conversations })), details: undefined,
			};
		},
	});
	pi.registerTool({
		name: "subagent_delete", label: "Delete Subagent",
		description: "Permanently delete an owned ad-hoc conversation and its transcript. Active conversations must finish or be stopped first. Workflow-owned conversations cannot be deleted through this tool.",
		annotations: { destructiveHint: true },
		parameters: Type.Object({ handle: Type.String({ minLength: 1 }) }),
		outputSchema: Type.Object({ handle: Type.String(), deleted: Type.Boolean() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const deleted = service.delete(owner(ctx), params.handle);
			return {
				content: [{ type: "text", text: deleted ? `Deleted subagent ${params.handle}.` : `Subagent ${params.handle} is already absent.` }],
				structuredContent: { handle: params.handle, deleted }, details: undefined,
			};
		},
	});

	async function open(ctx: ExtensionContext): Promise<void> {
		if (viewer) return viewer.done;
		const parent = ctx.sessionManager.getSessionId();
		const controller = new AbortController();
		const done = showSubagents(ctx, {
			list: () => service.listParent(parent), inspect: (handle) => service.inspect(parent, handle),
			subscribe: (listener) => service.subscribe(parent, listener),
		}, controller.signal);
		viewer = { controller, done };
		try { await done; } finally { if (viewer?.done === done) viewer = undefined; }
	}
	pi.registerCommand("subagents", { description: "Inspect the current parent's subagent conversations", handler: (_args, ctx) => open(ctx) });
	pi.registerShortcut(Key.ctrlAlt("a"), { description: "Inspect subagent conversations", handler: open });

	async function stop(_event: unknown, ctx: ExtensionContext): Promise<void> {
		viewer?.controller.abort();
		await viewer?.done;
		const parent = ctx.sessionManager.getSessionId();
		const owned = [...active.entries()].filter(([, invocation]) => invocation.parent === parent);
		for (const [controller] of owned) controller.abort();
		await Promise.allSettled(owned.map(([, invocation]) => invocation.done));
	}
	pi.on("session_shutdown", stop);
	pi.on("session_before_switch", stop);
	pi.on("session_before_tree", stop);
	pi.on("session_before_fork", stop);
}
