import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverWorkflowContent, type WorkflowContent } from "./content.ts";
import { formatWorkflowModels, loadWorkflowConfig, loadWorkflowExecution, resolveWorkflowAgents } from "./config.ts";
import { diffForHumanCheckpoint, diffTrees, requireWorktreeSnapshot } from "./git.ts";
import { WorkflowOrchestrator } from "./orchestrator.ts";
import { amendmentPlanningInstructions, applyWorkflowAmendment, appendPlanningInstructions, formatWorkflowPlan, resolveSkillTag, stageWorkflowAmendment, submitWorkflowPlan } from "./planner.ts";
import { isReadOnlyPlanningCommand } from "./safety.ts";
import { WorkflowSessionStore } from "./sessions.ts";
import { cloneState, createWorkflowState, currentTodo, isWorkflowComplete, restoreWorkflowBranch, markWorkflowInterrupted, WORKFLOW_ENTRY_TYPE as ENTRY_TYPE, type WorkflowState, type WorkflowTodo } from "./state.ts";
import { clearWorkflowUi, formatWorkflowDiff, todoSummary, updateWorkflowUi, workflowStatusSummary } from "./ui.ts";

const QUESTIONNAIRE_TOOL = "questionnaire";
const SUBMIT_PLAN_TOOL = "workflow_submit_plan";
const DIFF_MESSAGE_TYPE = "workflow-diff";
const LOCAL_PLANNING_TOOLS = ["read", "bash", "grep", "find", "ls", "download_file", QUESTIONNAIRE_TOOL, SUBMIT_PLAN_TOOL];
const MCP_ACCESS_TOOLS = new Set(["codemode", "tool_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
const DISABLED_PLANNING_TOOLS = new Set(["write", "edit", "subagent", "subagent_delete"]);

function helpText(): string {
	return [
		"/workflow [on|off] — toggle conversational workflow planning",
		"/workflow execute [step] — start, continue, or force execution from a later todo",
		"/workflow status|todos — inspect workflow state",
		"/workflow models — inspect agent model configuration",
		"/workflow design — enter or return to human design editing",
		"/workflow design-review — review design changes, or confirm an empty phase",
		"/workflow design-feedback [text] — ask the design reviewer to reconsider",
		"/workflow design-approve — accept design and start implementation",
		"/workflow replan — amend the accepted plan in the top-level conversation",
		"/workflow plan-approve|plan-reject — decide a proposed amendment",
		"/workflow review — inspect and decide the current human checkpoint",
		"/workflow approve — approve the current todo and continue",
		"/workflow feedback [text] — clarify an escalation or request code revisions",
		"/workflow diff [step] — show changes since the previous human checkpoint",
		"/workflow skills — list discovered Agent Skills",
		"/workflow skill <step> <name|none> — assign or clear a primary skill",
		"/workflow pause|resume|abort — control execution",
		"/workflow roles — inspect Markdown content",
		"/workflow clear — clear workflow state",
	].join("\n");
}

export default function workflowExtension(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<{ title: string; diff: string }>(DIFF_MESSAGE_TYPE, (message, { outputPad }, theme) => {
		if (!message.details) return undefined;
		return new Text(`${theme.fg("accent", theme.bold(message.details.title))}\n${formatWorkflowDiff(message.details.diff, theme)}`, outputPad, 0);
	});

	let state = createWorkflowState();
	let content: WorkflowContent | undefined;
	let orchestrator: WorkflowOrchestrator;
	let transitioning = false;

	pi.registerFlag("workflow", { description: "Start in conversational workflow planning mode", type: "boolean", default: false });

	function persist(): void {
		state.updatedAt = Math.max(Date.now(), state.updatedAt + 1);
		pi.appendEntry(ENTRY_TYPE, cloneState(state));
	}

	function update(ctx: ExtensionContext): void {
		updateWorkflowUi(ctx, state);
	}

	function reloadContent(ctx: ExtensionContext): WorkflowContent {
		content = discoverWorkflowContent(ctx.cwd, ctx.isProjectTrusted());
		return content;
	}

	function getContent(ctx: ExtensionContext): WorkflowContent {
		return content ?? reloadContent(ctx);
	}

	function rebuildOrchestrator(): void {
		orchestrator = new WorkflowOrchestrator(state, {
			persist,
			updateUi: update,
			content: () => {
				if (!content) throw new Error("Workflow Markdown content has not been loaded.");
				return content;
			},
			sessions: (ctx) => new WorkflowSessionStore(path.join(getAgentDir(), "subagents"), ctx.sessionManager.getSessionId(), ctx.cwd),
			models: async (ctx, signal) => {
				// Reload a single configuration snapshot for each execution or resumption.
				return loadWorkflowExecution(getAgentDir(), signal ?? ctx.signal);
			},
		});
	}

	function enablePlanning(ctx: ExtensionContext, notify = true): void {
		if (orchestrator.isRunning()) throw new Error("Stop execution with /workflow replan before planning.");
		if (!state.amending && state.todos.some((todo) => todo.status !== "pending")) throw new Error("Use /workflow replan to amend work already started.");
		const activeTools = pi.getActiveTools();
		state.toolsBeforePlanning ??= activeTools;
		// Preserve MCP access from both the live tool set and a resumed planning session.
		// Deferred tools keep their configured exposure and are reached through their gateways.
		const mcpTools = [...activeTools, ...state.toolsBeforePlanning].filter((name) => name.startsWith("mcp__") || MCP_ACCESS_TOOLS.has(name));
		pi.setActiveTools([...new Set([...LOCAL_PLANNING_TOOLS, ...mcpTools])]);
		state.planning = true;
		state.executing = false;
		state.paused = false;
		getContent(ctx);
		persist();
		update(ctx);
		if (notify) ctx.ui.notify("Workflow planning enabled. Built-in file modifications are disabled; MCP remains available.", "info");
	}

	function disablePlanning(ctx: ExtensionContext, notify = true): void {
		state.planning = false;
		if (state.toolsBeforePlanning) pi.setActiveTools(state.toolsBeforePlanning);
		state.toolsBeforePlanning = undefined;
		persist();
		update(ctx);
		if (notify) ctx.ui.notify("Workflow planning disabled.", "info");
	}

	async function resolveUnknownSkillRequests(ctx: ExtensionContext, todos = state.todos): Promise<void> {
		if (!ctx.hasUI) return;
		const skills = Object.values(getContent(ctx).skills).sort((a, b) => a.name.localeCompare(b.name));
		for (const todo of todos.filter((item) => item.skillRequest)) {
			const options = ["No primary skill", ...skills.map((skill) => `${skill.name} — ${skill.description}`)];
			const selected = await ctx.ui.select(`Unknown Agent Skill [${todo.skillRequest}] on todo ${todo.step}: ${todo.title}`, options);
			if (!selected) continue;
			if (selected !== "No primary skill") {
				todo.primarySkill = selected.split(" — ", 1)[0];
				todo.skillSource = "user";
			} else {
				todo.primarySkill = undefined;
				todo.skillSource = undefined;
			}
			todo.skillRequest = undefined;
		}
	}

	async function abortCurrent(ctx: ExtensionContext): Promise<void> {
		if (transitioning) throw new Error("A workflow transition is already in progress.");
		transitioning = true;
		const original = state;
		const todo = currentTodo(state);
		try {
			await orchestrator.stop();
			if (state !== original) throw new Error("Workflow changed while stopping. Retry the command.");
			if (todo) { todo.status = "aborted"; todo.checkpoint = undefined; }
			state.executing = false;
			state.paused = false;
			persist();
			if (todo) orchestrator.cleanupTodos(ctx, [todo]);
			persist(); update(ctx);
		} finally { rebuildOrchestrator(); transitioning = false; }
	}

	async function replaceWorkflow(ctx: ExtensionContext, replacement: WorkflowState): Promise<void> {
		if (transitioning) throw new Error("A workflow transition is already in progress.");
		transitioning = true;
		const original = state;
		try {
			await orchestrator.stop();
			if (state !== original) throw new Error("Workflow changed while stopping. Retry the command.");
			state.discarding = true;
			persist();
			orchestrator.cleanupWorkflow(ctx);
			state = replacement;
			persist(); update(ctx);
		} finally { rebuildOrchestrator(); transitioning = false; }
	}

	async function approveCurrent(ctx: ExtensionContext): Promise<void> {
		if (transitioning) throw new Error("A workflow transition is already in progress.");
		const todo = currentTodo(state);
		if (!todo || todo.status !== "awaiting-user") throw new Error("No todo is awaiting human approval.");
		if (orchestrator.isRunning()) throw new Error("Wait for the workflow worker to finish before approving.");
		const original = state, active = orchestrator, version = state.updatedAt;
		// Keep acceptance and transcript cleanup atomic with respect to other commands.
		transitioning = true;
		try {
			await active.checkCodeAcceptance(ctx);
			if (state !== original || orchestrator !== active || state.updatedAt !== version || currentTodo(state) !== todo
				|| todo.status !== "awaiting-user" || state.amending) throw new Error("Workflow changed while awaiting code acceptance. Review the current todo first.");
			todo.status = "approved";
			state.currentStep = undefined;
			state.currentStep = currentTodo(state)?.step;
			state.executing = false;
			persist();
			active.cleanupTodos(ctx, [todo]);
			persist();
			update(ctx);
		} finally { transitioning = false; }
		if (isWorkflowComplete(state)) {
			ctx.ui.notify("Workflow complete. Every todo is approved or completed manually.", "info");
			return;
		}
		ctx.ui.notify(`Todo ${todo.step} approved. Starting the next todo.`, "info");
		await orchestrator.execute(ctx);
	}

	async function replan(ctx: ExtensionContext): Promise<void> {
		if (!state.todos.length) throw new Error("Submit an initial plan first.");
		transitioning = true;
		try {
			await orchestrator.stop();
			rebuildOrchestrator();
			orchestrator.checkIdle(ctx);
			state.amending = true;
			enablePlanning(ctx);
		} finally { transitioning = false; }
	}

	async function decidePlan(ctx: ExtensionContext, accept: boolean): Promise<void> {
		if (!state.amending) throw new Error("No plan amendment is active.");
		const original = state, active = orchestrator, amendment = state.pendingAmendment;
		transitioning = true;
		try {
			if (accept) {
				await active.reconcileCheckpoints(ctx, state.todos.filter((todo) => amendment?.affectedIds.includes(todo.id)));
				if (state !== original || orchestrator !== active || state.pendingAmendment !== amendment || !state.amending) throw new Error("Workflow changed while accepting the plan amendment. Review the current proposal first.");
				applyWorkflowAmendment(state);
			} else { state.pendingAmendment = undefined; state.amending = false; }
			disablePlanning(ctx, false);
			persist(); update(ctx);
		} finally { transitioning = false; }
		if (accept) await orchestrator.execute(ctx);
		else ctx.ui.notify("Accepted plan retained. Use /workflow execute to continue.", "info");
	}

	async function enterDesign(ctx: ExtensionContext): Promise<void> {
		transitioning = true;
		try {
			await orchestrator.stop();
			rebuildOrchestrator();
			if (state.planning) disablePlanning(ctx, false);
			await orchestrator.enterDesign(ctx);
		} finally { transitioning = false; }
	}

	async function pauseWorkflow(ctx: ExtensionContext): Promise<void> {
		transitioning = true;
		try {
			await orchestrator.stop();
			state.paused = true;
			state.executing = false;
			persist(); update(ctx);
		} finally { rebuildOrchestrator(); transitioning = false; }
	}

	async function designFeedback(args: string, ctx: ExtensionContext): Promise<void> {
		const todo = currentTodo(state);
		if (!todo || todo.designAccepted !== undefined || !todo.designs.length) throw new Error("No design is available for feedback.");
		const version = state.updatedAt;
		let feedback = args.trim();
		if (!feedback && ctx.hasUI) feedback = (await ctx.ui.editor("Design review feedback", ""))?.trim() ?? "";
		if (!feedback) return;
		if (currentTodo(state) !== todo || state.updatedAt !== version) throw new Error("Workflow changed while awaiting feedback.");
		await orchestrator.reviewDesign(ctx, feedback);
	}

	async function requestFeedback(args: string, ctx: ExtensionContext): Promise<void> {
		const todo = currentTodo(state);
		if (!todo || todo.designAccepted === undefined || !["awaiting-user", "awaiting-change", "failed", "interrupted"].includes(todo.status)) throw new Error("No code is available for human feedback.");
		const version = state.updatedAt;
		let feedback = args.trim();
		if (!feedback && ctx.hasUI) feedback = (await ctx.ui.editor(`${todo.status === "awaiting-change" ? "Implementation clarification" : "Changes requested"} for todo ${todo.step}`, ""))?.trim() ?? "";
		if (!feedback) return;
		if (currentTodo(state) !== todo || state.updatedAt !== version) throw new Error("Workflow changed while awaiting feedback. Review the current todo first.");
		await orchestrator.reviseFromHuman(ctx, todo, feedback);
	}

	async function showTodoDiff(todo: WorkflowTodo, ctx: ExtensionContext): Promise<void> {
		const designPhase = todo.designAccepted === undefined && todo.designs.length > 0;
		const title = `Todo ${todo.step}: ${designPhase ? "human design changes" : "code checkpoint changes"}`;
		const diff = designPhase
			? (await diffTrees(ctx.cwd, todo.designs.at(-1)!.baselineTree, await requireWorktreeSnapshot(ctx.cwd))).preview
			: (await diffForHumanCheckpoint(ctx.cwd, todo)).preview;
		pi.sendMessage({
			customType: DIFF_MESSAGE_TYPE,
			content: `${title}\n\n${diff}`,
			display: true,
			details: { title, diff },
		}, { triggerTurn: false });
	}

	async function reviewCurrent(ctx: ExtensionContext): Promise<void> {
		const todo = currentTodo(state);
		if (!todo || todo.designAccepted === undefined) throw new Error("No code is available for review. Use /workflow design-review.");
		const version = state.updatedAt;
		ctx.ui.notify(todoSummary(todo), "info");
		const escalated = todo.status === "awaiting-change";
		if (!ctx.hasUI || (!escalated && todo.status !== "awaiting-user")) return;
		const actions = escalated
			? ["Clarify implementation", "Return to design", "Amend plan", "Inspect todo diff", "Pause workflow", "Abort workflow"]
			: ["Approve and continue", "Inspect todo diff", "Request changes", "Ask reviewer to reconsider", "Pause workflow", "Abort workflow"];
		const action = await ctx.ui.select(escalated ? "Human clarification" : "Human acceptance", actions);
		if (currentTodo(state) !== todo || state.updatedAt !== version) throw new Error("Workflow changed while awaiting review. Review the current todo first.");
		if (action === "Approve and continue") await approveCurrent(ctx);
		else if (action === "Inspect todo diff") await showTodoDiff(todo, ctx);
		else if (action === "Request changes" || action === "Clarify implementation") await requestFeedback("", ctx);
		else if (action === "Return to design") await enterDesign(ctx);
		else if (action === "Amend plan") await replan(ctx);
		else if (action === "Ask reviewer to reconsider") await requestFeedback("Reconsider the implementation in light of the prior review and perform another independent review. Do not change code unless needed to address a concrete issue.", ctx);
		else if (action === "Pause workflow") await pauseWorkflow(ctx);
		else if (action === "Abort workflow") await abortCurrent(ctx);
	}

	pi.registerTool({
		name: SUBMIT_PLAN_TOOL,
		label: "Submit Workflow Plan",
		description: "Submit an initial workflow plan or stage a plan amendment. Amendments require baseRevision, existing todo IDs and affectedIds; human acceptance uses /workflow plan-approve. Include every implementation and review requirement in todo instructions.",
		executionMode: "sequential",
		parameters: Type.Object({
			baseRevision: Type.Optional(Type.Integer({ minimum: 1 })),
			affectedIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			todos: Type.Array(Type.Object({
				id: Type.Optional(Type.String({ minLength: 1 })),
				title: Type.String({ minLength: 1 }),
				instructions: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
				primarySkill: Type.Optional(Type.String({ minLength: 1 })),
			}), { minItems: 1, maxItems: 40 }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!state.planning) throw new Error("Workflow plans can only be submitted while workflow planning is active.");
			const original = state;
			if (state.amending) {
				if (params.baseRevision === undefined || params.affectedIds === undefined) throw new Error("Amendments require baseRevision and affectedIds.");
				stageWorkflowAmendment(state, params.todos, params.baseRevision, params.affectedIds, getContent(ctx).skills);
				persist(); update(ctx);
				const plan = workflowStatusSummary(state);
				return { content: [{ type: "text", text: plan }], details: { plan }, terminate: true };
			}
			const version = state.updatedAt;
			const replacement = { ...createWorkflowState(), planning: true, ownerSessionId: ctx.sessionManager.getSessionId(), goal: state.goal, toolsBeforePlanning: state.toolsBeforePlanning };
			submitWorkflowPlan(replacement, params.todos, getContent(ctx).skills);
			await resolveUnknownSkillRequests(ctx, replacement.todos);
			_signal?.throwIfAborted();
			if (state !== original || state.updatedAt !== version) throw new Error("Workflow changed while awaiting plan input. Submit the plan again.");
			await replaceWorkflow(ctx, replacement);
			const plan = formatWorkflowPlan(state.todos);
			return {
				content: [{ type: "text", text: plan }],
				details: { plan, todoCount: state.todos.length },
				terminate: true,
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", `Submit workflow plan (${args.todos?.length ?? 0} todos)`), 0, 0);
		},
		renderResult(result, _options, _theme) {
			const details = result.details as { plan?: string } | undefined;
			return new Text(details?.plan ?? "Workflow plan was not captured.", 0, 0);
		},
	});

	pi.registerCommand("workflow", {
		description: "Plan and execute an implement/review/human-approval workflow",
		handler: async (rawArgs, ctx) => {
			try {
				const args = rawArgs.trim();
				const [command = "", ...rest] = args.split(/\s+/);
				const tail = rest.join(" ");
				if (transitioning) throw new Error("A workflow transition is already in progress.");
				if (state.discarding && !["clear", "status", "todos", "on", "off"].includes(command)) throw new Error("Workflow cleanup is unfinished. Run /workflow clear before continuing.");
				if (state.amending && !["replan", "plan-approve", "plan-reject", "status", "todos", "help", "diff", "models", "roles", "skills", "clear"].includes(command)) throw new Error("Finish the amendment with /workflow plan-approve or plan-reject.");
				if (command === "replan") return await replan(ctx);
				if (command === "plan-approve") return await decidePlan(ctx, true);
				if (command === "plan-reject") return await decidePlan(ctx, false);
				if (!command) return state.planning ? disablePlanning(ctx) : enablePlanning(ctx);
				if (command === "on") return enablePlanning(ctx);
				if (command === "off") return disablePlanning(ctx);
				if (command === "help") return ctx.ui.notify(helpText(), "info");
				if (command === "roles") {
					const found = getContent(ctx);
					return ctx.ui.notify([
						...Object.entries(resolveWorkflowAgents(getAgentDir(), await loadWorkflowConfig(getAgentDir()))).map(([role, agent]) => `${role} → ${agent.name}: ${agent.filePath}`),
						...Object.entries(found.skills).map(([name, skill]) => `${name}: ${skill.source} — ${skill.filePath}`),
						...(found.diagnostics.length ? ["Diagnostics:", ...found.diagnostics.map((message) => `- ${message}`)] : []),
					].join("\n"), "info");
				}
				if (command === "skills") {
					if (rest.length) throw new Error("Usage: /workflow skills");
					const found = getContent(ctx);
					const lines = Object.values(found.skills).sort((a, b) => a.name.localeCompare(b.name)).map((skill) => `${skill.name} (${skill.source}) — ${skill.description}`);
					return ctx.ui.notify(lines.join("\n") || "No Agent Skills discovered.", "info");
				}
				if (command === "models") {
					if (rest.length) throw new Error("Usage: /workflow models");
					return ctx.ui.notify(formatWorkflowModels(resolveWorkflowAgents(getAgentDir(), await loadWorkflowConfig(getAgentDir()))), "info");
				}
				if (command === "status" || command === "todos") return ctx.ui.notify(workflowStatusSummary(state), "info");
				if (command === "skill") {
					const step = Number(rest[0]);
					const requested = rest[1]?.trim().toLowerCase();
					const todo = state.todos.find((item) => item.step === step);
					if (!todo || !requested || rest.length !== 2) throw new Error("Usage: /workflow skill <step> <name|none>");
					if (requested === "none") {
						todo.primarySkill = undefined;
						todo.skillSource = undefined;
						todo.skillRequest = undefined;
						persist(); update(ctx);
						return ctx.ui.notify(`Todo ${step} will run without a primary skill.`, "info");
					}
					const skill = resolveSkillTag(requested, getContent(ctx).skills);
					if (!skill) throw new Error(`Unknown Agent Skill "${requested}". Use /workflow skills to list available skills.`);
					todo.primarySkill = skill; todo.skillSource = "user"; todo.skillRequest = undefined; persist(); update(ctx);
					return ctx.ui.notify(`Todo ${step} assigned to ${skill}.`, "info");
				}
				if (command === "execute") {
					if (rest.length > 1 || (rest[0] !== undefined && !/^\d+$/.test(rest[0]))) throw new Error("Usage: /workflow execute [step]");
					const targetStep = rest[0] === undefined ? undefined : Number(rest[0]);
					const target = targetStep === undefined ? undefined : state.todos.find((todo) => todo.step === targetStep);
					const original = state;
					await resolveUnknownSkillRequests(ctx, targetStep === undefined ? state.todos : target ? [target] : []);
					if (state !== original) throw new Error("Workflow changed while awaiting skill input. Retry the command.");
					const unresolvedTodo = targetStep === undefined
						? state.todos.find((todo) => todo.skillRequest)
						: target?.skillRequest ? target : undefined;
					if (unresolvedTodo) throw new Error(`Todo ${unresolvedTodo.step} requests unknown Agent Skill "${unresolvedTodo.skillRequest}". Use /workflow skill ${unresolvedTodo.step} <name|none>.`);
					if (state.planning) disablePlanning(ctx, false);
					if (targetStep !== undefined) {
						// Fence cancellation and state changes, then release the guard before the new run.
						transitioning = true;
						try { await orchestrator.prepareFrom(ctx, targetStep); }
						finally { transitioning = false; }
					}
					return await orchestrator.execute(ctx);
				}
				if (command === "design") return await enterDesign(ctx);
				if (command === "design-review") return await orchestrator.reviewDesign(ctx);
				if (command === "design-feedback") return await designFeedback(tail, ctx);
				if (command === "design-approve") return await orchestrator.approveDesign(ctx);
				if (command === "review") return await reviewCurrent(ctx);
				if (command === "approve") return await approveCurrent(ctx);
				if (command === "feedback") return await requestFeedback(tail, ctx);
				if (command === "diff") {
					const selected = rest[0] ? state.todos.find((todo) => todo.step === Number(rest[0])) : currentTodo(state);
					if (!selected) throw new Error("Todo not found.");
					return await showTodoDiff(selected, ctx);
				}
				if (command === "pause") return await pauseWorkflow(ctx);
				if (command === "resume") { state.paused = false; persist(); update(ctx); return await orchestrator.execute(ctx); }
				if (command === "abort") return await abortCurrent(ctx);
				if (command === "clear") {
					const tools = state.toolsBeforePlanning;
					await replaceWorkflow(ctx, createWorkflowState());
					if (tools) pi.setActiveTools(tools);
					content = undefined;
					clearWorkflowUi(ctx);
					return ctx.ui.notify("Workflow state cleared.", "info");
				}
				ctx.ui.notify(helpText(), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("tool_call", async (event) => {
		if (!state.planning) return;
		if (DISABLED_PLANNING_TOOLS.has(event.toolName)) return { block: true, reason: "Workflow planning blocks file modifications, subagent delegation and conversation deletion. Use /workflow execute after accepting the plan." };
		if (event.toolName === "bash" && !isReadOnlyPlanningCommand(String((event.input as any).command ?? ""))) {
			return { block: true, reason: "Workflow planning blocked a non-read-only shell command." };
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!state.planning) {
			const todo = currentTodo(state);
			if (todo?.designAccepted === undefined && todo?.designs.length) return { systemPrompt: `${event.systemPrompt}\n\nWorkflow design is human-owned. Advise and discuss; preserve repository files. The human edits and requests review with /workflow design-review.\n\nCurrent checkpoint:\n${todoSummary(todo)}` };
			return;
		}
		if (!state.goal && event.messageType !== "custom" && event.prompt.trim()) state.goal = event.prompt.trim();
		const found = getContent(ctx);
		return { systemPrompt: appendPlanningInstructions(event.systemPrompt, `${found.planner}${state.amending ? `\n\n${amendmentPlanningInstructions(state)}` : ""}`, found.skills) };
	});

	async function restoreSession(ctx: ExtensionContext): Promise<void> {
		if (state.toolsBeforePlanning) pi.setActiveTools(state.toolsBeforePlanning);
		const restored = restoreWorkflowBranch(ctx.sessionManager.getEntries(), ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId());
		state = restored.state;
		markWorkflowInterrupted(state);
		reloadContent(ctx);
		rebuildOrchestrator();
		// Finish a persisted terminal transition before allowing new work after a restart.
		try {
			if (state.discarding) {
				orchestrator.cleanupWorkflow(ctx);
				state = { ...createWorkflowState(), ownerSessionId: ctx.sessionManager.getSessionId() };
				rebuildOrchestrator();
				persist();
			} else {
				const finished = state.todos.filter((todo) => ["approved", "completed-manually", "aborted"].includes(todo.status) && todo.sessions);
				if (finished.length) { orchestrator.cleanupTodos(ctx, finished); persist(); }
			}
		} catch (error) {
			ctx.ui.notify(`Workflow cleanup needs attention: ${String(error)}`, "error");
		}
		if (pi.getFlag("workflow") === true || restored.replanReason) state.planning = true;
		if (state.planning && (state.amending || !state.todos.some((todo) => todo.status !== "pending"))) enablePlanning(ctx, false);
		else { state.planning = false; update(ctx); }
		if (restored.replanReason) ctx.ui.notify(restored.replanReason, "warning");
		const todo = currentTodo(state);
		if (todo && ["design-editing", "awaiting-design"].includes(todo.status)) ctx.ui.notify(`Workflow resumed at todo ${todo.step}: ${todo.status}. Use /workflow design-review or design-approve.`, "info");
		if (todo?.status === "awaiting-user") ctx.ui.notify(`Workflow resumed at todo ${todo.step}, awaiting your approval. Use /workflow review.`, "info");
		if (todo?.status === "interrupted") { persist(); ctx.ui.notify(todo.error!, "warning"); }
	}

	pi.on("session_start", async (_event, ctx) => restoreSession(ctx));
	pi.on("session_before_tree", async () => {
		await orchestrator.stop();
		rebuildOrchestrator();
	});
	pi.on("session_before_fork", async () => {
		await orchestrator.stop();
		rebuildOrchestrator();
	});
	pi.on("session_tree", async (_event, ctx) => restoreSession(ctx));

	pi.on("session_shutdown", async (_event, ctx) => {
		transitioning = true;
		try { await orchestrator.stop(); }
		finally { clearWorkflowUi(ctx); }
	});

	rebuildOrchestrator();
}
