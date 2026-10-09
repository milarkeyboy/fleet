import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverWorkflowContent, scaffoldWorkflowRoles, type WorkflowContent } from "./content.ts";
import { createWorkflowSubprocessModelRegistry, formatWorkflowModels, isProviderModel, isWorkflowRole, isWorkflowThinkingLevel, loadWorkflowModelConfig, requireExecutableWorkflowModels, setWorkflowRoleModel, workflowConfigPath, WORKFLOW_THINKING_LEVELS } from "./config.ts";
import { diffForHumanCheckpoint } from "./git.ts";
import { WorkflowOrchestrator } from "./orchestrator.ts";
import { appendPlanningInstructions, formatWorkflowPlan, resolveSkillTag, submitWorkflowPlan } from "./planner.ts";
import { isReadOnlyPlanningCommand } from "./safety.ts";
import { WorkflowSessionStore } from "./sessions.ts";
import { cloneState, createWorkflowState, currentTodo, isWorkflowComplete, restoreWorkflowBranch, markWorkflowInterrupted, WORKFLOW_ENTRY_TYPE as ENTRY_TYPE, type WorkflowState, type WorkflowTodo } from "./state.ts";
import { clearWorkflowUi, formatWorkflowDiff, todoSummary, updateWorkflowUi, workflowStatusSummary } from "./ui.ts";

const QUESTIONNAIRE_TOOL = "questionnaire";
const SUBMIT_PLAN_TOOL = "workflow_submit_plan";
const DIFF_MESSAGE_TYPE = "workflow-diff";
const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls", QUESTIONNAIRE_TOOL, SUBMIT_PLAN_TOOL];
const DISABLED_PLANNING_TOOLS = new Set(["write", "edit"]);

function helpText(): string {
	return [
		"/workflow [on|off] — toggle conversational workflow planning",
		"/workflow execute [step] — start, continue, or force execution from a later todo",
		"/workflow status|todos — inspect workflow state",
		"/workflow models — inspect implementer and reviewer model configuration",
		"/workflow model <implementer|reviewer> <provider/model> [thinking-level] — configure a role model",
		"/workflow review — inspect and decide the current human checkpoint",
		"/workflow approve — approve the current todo and continue",
		"/workflow feedback [text] — send changes through implement/review again",
		"/workflow diff [step] — show changes since the previous human checkpoint",
		"/workflow skills — list discovered Agent Skills",
		"/workflow skill <step> <name|none> — assign or clear a primary skill",
		"/workflow pause|resume|abort — control execution",
		"/workflow roles — inspect Markdown content",
		"/workflow init — scaffold portable workflow roles in .agents/",
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
		state.updatedAt = Date.now();
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
			sessions: (ctx) => new WorkflowSessionStore(path.join(getAgentDir(), "workflow", "sessions"), ctx.sessionManager.getSessionId(), ctx.cwd),
			models: async (ctx, signal) => {
				// Reload a single configuration snapshot for each execution or resumption.
				const config = await loadWorkflowModelConfig(getAgentDir());
				return requireExecutableWorkflowModels(config, await createWorkflowSubprocessModelRegistry(signal ?? ctx.signal));
			},
		});
	}

	function enablePlanning(ctx: ExtensionContext, notify = true): void {
		if (!state.toolsBeforePlanning) state.toolsBeforePlanning = pi.getActiveTools();
		pi.setActiveTools([...READ_ONLY_TOOLS]);
		state.planning = true;
		state.executing = false;
		state.paused = false;
		getContent(ctx);
		persist();
		update(ctx);
		if (notify) ctx.ui.notify("Workflow planning enabled. File modifications are disabled.", "info");
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

	async function scaffold(ctx: ExtensionContext): Promise<void> {
		if (!ctx.isProjectTrusted()) throw new Error("Trust this project before creating project workflow content.");
		if (ctx.hasUI) {
			const ok = await ctx.ui.confirm("Initialize workflow Markdown?", `Copy portable placeholders into ${path.join(ctx.cwd, ".agents")} without overwriting existing files?`);
			if (!ok) return;
		}
		const agents = path.join(ctx.cwd, ".agents");
		await scaffoldWorkflowRoles(agents);
		reloadContent(ctx);
		ctx.ui.notify(`Workflow role placeholders initialized under ${agents}. Existing files were preserved.`, "info");
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
		const todo = currentTodo(state);
		if (!todo || todo.status !== "awaiting-user") throw new Error("No todo is awaiting human approval.");
		if (orchestrator.isRunning()) throw new Error("Wait for the workflow worker to finish before approving.");
		todo.status = "approved";
		state.currentStep = state.todos.find((item) => item.status === "pending")?.step;
		state.executing = false;
		persist();
		orchestrator.cleanupTodos(ctx, [todo]);
		persist();
		update(ctx);
		if (isWorkflowComplete(state)) {
			ctx.ui.notify("Workflow complete. Every todo is approved or completed manually.", "info");
			return;
		}
		ctx.ui.notify(`Todo ${todo.step} approved. Starting the next todo.`, "info");
		await orchestrator.execute(ctx);
	}

	async function requestFeedback(args: string, ctx: ExtensionContext): Promise<void> {
		const todo = currentTodo(state);
		if (!todo || !["awaiting-user", "failed", "interrupted"].includes(todo.status)) throw new Error("No todo is available for human feedback.");
		let feedback = args.trim();
		if (!feedback && ctx.hasUI) feedback = (await ctx.ui.editor(`Changes requested for todo ${todo.step}`, ""))?.trim() ?? "";
		if (!feedback) return;
		if (currentTodo(state) !== todo) throw new Error("Workflow changed while awaiting feedback. Review the current todo first.");
		await orchestrator.reviseFromHuman(ctx, todo, feedback);
	}

	async function showTodoDiff(todo: WorkflowTodo, ctx: ExtensionContext): Promise<void> {
		const title = `Todo ${todo.step} changes since previous human checkpoint`;
		const diff = (await diffForHumanCheckpoint(ctx.cwd, todo)).preview;
		pi.sendMessage({
			customType: DIFF_MESSAGE_TYPE,
			content: `${title}\n\n${diff}`,
			display: true,
			details: { title, diff },
		}, { triggerTurn: false });
	}

	async function reviewCurrent(ctx: ExtensionContext): Promise<void> {
		const todo = currentTodo(state);
		if (!todo) throw new Error("There is no current todo.");
		ctx.ui.notify(todoSummary(todo), "info");
		if (!ctx.hasUI || todo.status !== "awaiting-user") return;
		const action = await ctx.ui.select("Human acceptance", ["Approve and continue", "Inspect todo diff", "Request changes", "Ask reviewer to reconsider", "Pause workflow", "Abort workflow"]);
		if (currentTodo(state) !== todo) throw new Error("Workflow changed while awaiting review. Review the current todo first.");
		if (action === "Approve and continue") await approveCurrent(ctx);
		else if (action === "Inspect todo diff") await showTodoDiff(todo, ctx);
		else if (action === "Request changes") await requestFeedback("", ctx);
		else if (action === "Ask reviewer to reconsider") await requestFeedback("Reconsider the implementation in light of the prior review and perform another independent review. Do not change code unless needed to address a concrete issue.", ctx);
		else if (action === "Pause workflow") { state.paused = true; persist(); update(ctx); }
		else if (action === "Abort workflow") await abortCurrent(ctx);
	}

	pi.registerTool({
		name: SUBMIT_PLAN_TOOL,
		label: "Submit Workflow Plan",
		description: "Submit the final workflow plan as typed todos. Every implementation and review requirement must be included in each todo's instructions array.",
		executionMode: "sequential",
		parameters: Type.Object({
			todos: Type.Array(Type.Object({
				title: Type.String({ minLength: 1 }),
				instructions: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
				primarySkill: Type.Optional(Type.String({ minLength: 1 })),
			}), { minItems: 1, maxItems: 40 }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!state.planning) throw new Error("Workflow plans can only be submitted while workflow planning is active.");
			const original = state;
			const replacement = { ...createWorkflowState(), planning: true, ownerSessionId: ctx.sessionManager.getSessionId(), goal: state.goal, toolsBeforePlanning: state.toolsBeforePlanning };
			submitWorkflowPlan(replacement, params.todos, getContent(ctx).skills);
			await resolveUnknownSkillRequests(ctx, replacement.todos);
			_signal?.throwIfAborted();
			if (state !== original) throw new Error("Workflow changed while awaiting plan input. Submit the plan again.");
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
				if (!command) return state.planning ? disablePlanning(ctx) : enablePlanning(ctx);
				if (command === "on") return enablePlanning(ctx);
				if (command === "off") return disablePlanning(ctx);
				if (command === "help") return ctx.ui.notify(helpText(), "info");
				if (command === "init") return await scaffold(ctx);
				if (command === "roles") {
					const found = getContent(ctx);
					return ctx.ui.notify([
						...Object.entries(found.roles).map(([name, role]) => `${name}: ${role.source} — ${role.filePath}`),
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
					const agentDir = getAgentDir();
					const config = await loadWorkflowModelConfig(agentDir);
					return ctx.ui.notify(`${formatWorkflowModels(config)}\nconfig: ${workflowConfigPath(agentDir)}`, "info");
				}
				if (command === "model") {
					const [role, model, thinkingLevel] = rest;
					if (!role || !model || rest.length > 3 || !isWorkflowRole(role)) {
						throw new Error("Usage: /workflow model <implementer|reviewer> <provider/model> [thinking-level]");
					}
					if (!isProviderModel(model)) throw new Error("Model must use a provider/model identifier.");
					if (thinkingLevel !== undefined && !isWorkflowThinkingLevel(thinkingLevel)) {
						throw new Error(`Thinking level must be one of: ${WORKFLOW_THINKING_LEVELS.join(", ")}.`);
					}
					const agentDir = getAgentDir();
					const config = await setWorkflowRoleModel(role, model, thinkingLevel, agentDir);
					return ctx.ui.notify(`Workflow model updated.\n${formatWorkflowModels(config)}\nconfig: ${workflowConfigPath(agentDir)}`, "info");
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
					return targetStep === undefined ? await orchestrator.execute(ctx) : await orchestrator.executeFrom(ctx, targetStep);
				}
				if (command === "review") return await reviewCurrent(ctx);
				if (command === "approve") return await approveCurrent(ctx);
				if (command === "feedback") return await requestFeedback(tail, ctx);
				if (command === "diff") {
					const selected = rest[0] ? state.todos.find((todo) => todo.step === Number(rest[0])) : currentTodo(state);
					if (!selected) throw new Error("Todo not found.");
					return await showTodoDiff(selected, ctx);
				}
				if (command === "pause") { state.paused = true; persist(); update(ctx); return; }
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
		if (DISABLED_PLANNING_TOOLS.has(event.toolName)) return { block: true, reason: "Workflow planning is read-only. Use /workflow execute after accepting the plan." };
		if (event.toolName === "bash" && !isReadOnlyPlanningCommand(String((event.input as any).command ?? ""))) {
			return { block: true, reason: "Workflow planning blocked a non-read-only shell command." };
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!state.planning) return;
		if (!state.goal && event.prompt.trim()) state.goal = event.prompt.trim();
		const found = getContent(ctx);
		return { systemPrompt: appendPlanningInstructions(event.systemPrompt, found.planner, found.skills) };
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
		if (state.planning) enablePlanning(ctx, false);
		else update(ctx);
		if (restored.replanReason) ctx.ui.notify(restored.replanReason, "warning");
		const todo = currentTodo(state);
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
