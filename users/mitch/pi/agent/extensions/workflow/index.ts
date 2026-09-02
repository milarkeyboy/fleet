import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverWorkflowContent, scaffoldWorkflowRoles, type WorkflowContent } from "./content.ts";
import { createWorkflowSubprocessModelRegistry, formatWorkflowModels, isProviderModel, isWorkflowRole, isWorkflowThinkingLevel, loadWorkflowModelConfig, requireExecutableWorkflowModels, setWorkflowRoleModel, workflowConfigPath, WORKFLOW_THINKING_LEVELS } from "./config.ts";
import { WorkflowOrchestrator } from "./orchestrator.ts";
import { appendPlanningInstructions, extractWorkflowTodos, resolveSkillTag } from "./planner.ts";
import { isReadOnlyPlanningCommand } from "./safety.ts";
import { cloneState, createWorkflowState, currentTodo, isWorkflowComplete, latestRevision, restoreState, type WorkflowState, type WorkflowTodo } from "./state.ts";
import { clearWorkflowUi, formatWorkflowDiff, todoSummary, updateWorkflowUi } from "./ui.ts";

const ENTRY_TYPE = "workflow-state-v3";
const LEGACY_ENTRY_TYPE = "workflow-state-v1";
const PREVIOUS_ENTRY_TYPE = "workflow-state-v2";
const QUESTIONNAIRE_TOOL = "workflow_questionnaire";
const DIFF_MESSAGE_TYPE = "workflow-diff";
const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls", QUESTIONNAIRE_TOOL];
const DISABLED_PLANNING_TOOLS = new Set(["write", "edit"]);

function textOf(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("\n");
}

function helpText(): string {
	return [
		"/workflow [on|off] — toggle conversational workflow planning",
		"/workflow execute — start or continue sequential delegation",
		"/workflow status|todos — inspect workflow state",
		"/workflow models — inspect implementer and reviewer model configuration",
		"/workflow model <implementer|reviewer> <provider/model> [thinking-level] — configure a role model",
		"/workflow review — inspect and decide the current human checkpoint",
		"/workflow approve — approve the current todo and continue",
		"/workflow feedback [text] — send changes through implement/review again",
		"/workflow diff [step] — show the todo-specific diff",
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
			models: async (ctx) => requireExecutableWorkflowModels(
				await loadWorkflowModelConfig(getAgentDir()),
				await createWorkflowSubprocessModelRegistry(ctx.signal),
			),
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

	async function resolveUnknownSkillRequests(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		const skills = Object.values(getContent(ctx).skills).sort((a, b) => a.name.localeCompare(b.name));
		for (const todo of state.todos.filter((item) => item.skillRequest)) {
			const options = ["No primary skill", ...skills.map((skill) => `${skill.name} — ${skill.description}`)];
			const selected = await ctx.ui.select(`Unknown Agent Skill [${todo.skillRequest}] on todo ${todo.step}: ${todo.text}`, options);
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

	async function approveCurrent(ctx: ExtensionContext): Promise<void> {
		const todo = currentTodo(state);
		if (!todo || todo.status !== "awaiting-user") throw new Error("No todo is awaiting human approval.");
		todo.status = "approved";
		state.currentStep = state.todos.find((item) => item.status === "pending")?.step;
		state.executing = !isWorkflowComplete(state);
		persist();
		update(ctx);
		if (isWorkflowComplete(state)) {
			ctx.ui.notify("Workflow complete. Every todo has implementer, reviewer, and human approval.", "info");
			return;
		}
		ctx.ui.notify(`Todo ${todo.step} approved. Starting the next todo.`, "info");
		await orchestrator.execute(ctx);
	}

	async function requestFeedback(args: string, ctx: ExtensionContext): Promise<void> {
		const todo = currentTodo(state);
		if (!todo || !["awaiting-user", "failed"].includes(todo.status)) throw new Error("No todo is available for human feedback.");
		let feedback = args.trim();
		if (!feedback && ctx.hasUI) feedback = (await ctx.ui.editor(`Changes requested for todo ${todo.step}`, ""))?.trim() ?? "";
		if (!feedback) return;
		await orchestrator.reviseFromHuman(ctx, todo, feedback);
	}

	function showTodoDiff(todo: WorkflowTodo): void {
		const title = `Todo ${todo.step} revision diff`;
		const diff = latestRevision(todo)?.diffPreview ?? "Diff unavailable.";
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
		if (action === "Approve and continue") await approveCurrent(ctx);
		else if (action === "Inspect todo diff") showTodoDiff(todo);
		else if (action === "Request changes") await requestFeedback("", ctx);
		else if (action === "Ask reviewer to reconsider") await requestFeedback("Reconsider the implementation in light of the prior review and perform another independent review. Do not change code unless needed to address a concrete issue.", ctx);
		else if (action === "Pause workflow") { state.paused = true; persist(); update(ctx); }
		else if (action === "Abort workflow") { todo.status = "aborted"; state.executing = false; state.paused = false; persist(); update(ctx); }
	}

	pi.registerTool({
		name: QUESTIONNAIRE_TOOL,
		label: "Workflow Questionnaire",
		description: "Ask one or more decision-point questions while preparing a workflow plan. Use for important scope, design, compatibility, risk, language, or testing choices.",
		executionMode: "sequential",
		parameters: Type.Object({ questions: Type.Array(Type.Object({
			id: Type.String(),
			prompt: Type.String(),
			options: Type.Array(Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) })),
			allowOther: Type.Optional(Type.Boolean()),
		})) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) return { content: [{ type: "text", text: "Workflow questionnaire unavailable without an interactive UI." }], details: { cancelled: true } };
			const answers: Array<{ id: string; answer: string; custom: boolean }> = [];
			for (const question of params.questions) {
				const displayed = question.options.map((option: { label: string; description?: string }) => option.description ? `${option.label} — ${option.description}` : option.label);
				if (question.allowOther !== false) displayed.push("Type a custom answer…");
				const selected = await ctx.ui.select(question.prompt, displayed);
				if (!selected) return { content: [{ type: "text", text: "User cancelled the workflow questionnaire." }], details: { cancelled: true, answers } };
				if (selected === "Type a custom answer…") {
					const custom = (await ctx.ui.input(question.prompt))?.trim() ?? "";
					answers.push({ id: question.id, answer: custom || "(no answer)", custom: true });
				} else {
					const index = displayed.indexOf(selected);
					answers.push({ id: question.id, answer: question.options[index]?.label ?? selected, custom: false });
				}
			}
			return { content: [{ type: "text", text: answers.map((answer) => `${answer.id}: ${answer.custom ? "user wrote" : "user selected"}: ${answer.answer}`).join("\n") }], details: { cancelled: false, answers } };
		},
	});

	pi.registerCommand("workflow", {
		description: "Plan and execute an implement/review/human-approval workflow",
		handler: async (rawArgs, ctx) => {
			try {
				const args = rawArgs.trim();
				const [command = "", ...rest] = args.split(/\s+/);
				const tail = rest.join(" ");
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
				if (command === "status" || command === "todos") {
					const lines = state.todos.map((todo) => `${todo.step}. ${todo.primarySkill ? `[${todo.primarySkill}] ` : ""}${todo.skillRequest ? `[unknown: ${todo.skillRequest}] ` : ""}${todo.status} — ${todo.text}`);
					return ctx.ui.notify(`Workflow: ${state.planning ? "planning" : state.paused ? "paused" : state.executing ? "executing" : "idle"}\n${lines.join("\n") || "No todos."}`, "info");
				}
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
					await resolveUnknownSkillRequests(ctx);
					const unresolved = state.todos.find((todo) => todo.skillRequest);
					if (unresolved) throw new Error(`Todo ${unresolved.step} requests unknown Agent Skill "${unresolved.skillRequest}". Use /workflow skill ${unresolved.step} <name|none>.`);
					if (state.planning) disablePlanning(ctx, false);
					return await orchestrator.execute(ctx);
				}
				if (command === "review") return await reviewCurrent(ctx);
				if (command === "approve") return await approveCurrent(ctx);
				if (command === "feedback") return await requestFeedback(tail, ctx);
				if (command === "diff") {
					const selected = rest[0] ? state.todos.find((todo) => todo.step === Number(rest[0])) : currentTodo(state);
					if (!selected) throw new Error("Todo not found.");
					return showTodoDiff(selected);
				}
				if (command === "pause") { state.paused = true; persist(); update(ctx); return; }
				if (command === "resume") { state.paused = false; persist(); update(ctx); return await orchestrator.execute(ctx); }
				if (command === "abort") { const todo = currentTodo(state); if (todo) todo.status = "aborted"; state.executing = false; state.paused = false; persist(); update(ctx); return; }
				if (command === "clear") { if (state.planning) disablePlanning(ctx, false); state = createWorkflowState(); content = undefined; rebuildOrchestrator(); persist(); clearWorkflowUi(ctx); return ctx.ui.notify("Workflow state cleared.", "info"); }
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

	pi.on("agent_end", async (event, ctx) => {
		if (!state.planning) return;
		const assistant = [...event.messages].reverse().find((message: any) => message?.role === "assistant");
		if (!assistant) return;
		const todos = extractWorkflowTodos(textOf(assistant), getContent(ctx).skills);
		if (!todos.length) return;
		state.todos = todos;
		state.currentStep = todos[0]?.step;
		await resolveUnknownSkillRequests(ctx);
		persist();
		update(ctx);
		ctx.ui.notify(`Workflow plan captured (${todos.length} todos). Review with /workflow todos, then run /workflow execute.`, "info");
	});

	pi.on("session_start", async (_event, ctx) => {
		const saved = ctx.sessionManager.getEntries().filter((entry: any) => entry.type === "custom" && (entry.customType === ENTRY_TYPE || entry.customType === PREVIOUS_ENTRY_TYPE || entry.customType === LEGACY_ENTRY_TYPE)).pop() as { data?: unknown } | undefined;
		state = restoreState(saved?.data) ?? createWorkflowState();
		if (pi.getFlag("workflow") === true) state.planning = true;
		reloadContent(ctx);
		rebuildOrchestrator();
		if (state.planning) enablePlanning(ctx, false);
		else update(ctx);
		const todo = currentTodo(state);
		if (todo?.status === "awaiting-user") ctx.ui.notify(`Workflow resumed at todo ${todo.step}, awaiting your approval. Use /workflow review.`, "info");
	});

	pi.on("session_shutdown", async (_event, ctx) => clearWorkflowUi(ctx));

	rebuildOrchestrator();
}
