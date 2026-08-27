/**
 * Codex-style Plan Mode for pi.
 *
 * A read-only planning loop that encourages the agent to investigate first,
 * ask questionnaire-style clarifying questions at decision points, emit a
 * numbered plan, and then execute it with todo/progress tracking.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { extractTodoItems, isSafeReadOnlyCommand, markCompletedSteps, type TodoItem } from "./utils.ts";

const PLAN_TOOL = "plan_questionnaire";
const PLAN_DISABLED_TOOLS = new Set(["edit", "write"]);
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", PLAN_TOOL];

interface PlanModeState {
  enabled: boolean;
  executing: boolean;
  todos: TodoItem[];
  toolsBeforePlanMode?: string[];
}

function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function todoLines(todos: TodoItem[]): string[] {
  return todos.map((t) => `${t.step}. ${t.completed ? "✓" : "☐"} ${t.text}`);
}

export default function planMode(pi: ExtensionAPI): void {
  let enabled = false;
  let executing = false;
  let todos: TodoItem[] = [];
  let toolsBeforePlanMode: string[] | undefined;

  pi.registerFlag("plan", {
    description: "Start pi in read-only plan mode",
    type: "boolean",
    default: false,
  });

  function persist(): void {
    pi.appendEntry("plan-mode", { enabled, executing, todos, toolsBeforePlanMode } satisfies PlanModeState);
  }

  function updateUi(ctx: ExtensionContext): void {
    if (executing && todos.length > 0) {
      const done = todos.filter((t) => t.completed).length;
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 plan ${done}/${todos.length}`));
      ctx.ui.setWidget(
        "plan-mode-todos",
        todos.map((t) => {
          if (t.completed) return ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(t.text));
          return ctx.ui.theme.fg("muted", "☐ ") + t.text;
        }),
      );
      return;
    }

    ctx.ui.setWidget("plan-mode-todos", undefined);
    ctx.ui.setStatus("plan-mode", enabled ? ctx.ui.theme.fg("warning", "⏸ plan") : undefined);
  }

  function enablePlanTools(): void {
    const previous = toolsBeforePlanMode ?? pi.getActiveTools();
    toolsBeforePlanMode = previous;
    pi.setActiveTools(unique([...previous.filter((t) => !PLAN_DISABLED_TOOLS.has(t)), ...PLAN_MODE_TOOLS]));
  }

  function restoreTools(): void {
    if (toolsBeforePlanMode) pi.setActiveTools(toolsBeforePlanMode);
    toolsBeforePlanMode = undefined;
  }

  function setPlanMode(next: boolean, ctx: ExtensionContext): void {
    enabled = next;
    executing = false;
    if (enabled) {
      todos = [];
      enablePlanTools();
      ctx.ui.notify("Plan mode enabled: write/edit disabled; use the questionnaire at decision points.", "info");
    } else {
      restoreTools();
      ctx.ui.notify("Plan mode disabled.", "info");
    }
    updateUi(ctx);
    persist();
  }

  async function executePlan(ctx: ExtensionContext): Promise<void> {
    if (todos.length === 0) {
      ctx.ui.notify("No plan todos found yet. Ask for a numbered 'Plan:' first.", "warning");
      return;
    }
    enabled = false;
    executing = true;
    restoreTools();
    updateUi(ctx);
    persist();

    const list = todoLines(todos).join("\n");
    pi.sendMessage({ customType: "plan-mode-todo-list", content: `**Plan todo list:**\n\n${list}`, display: true }, { deliverAs: "followUp" });
    pi.sendUserMessage(
      `Execute the accepted plan. Work through the todo list in order.\n\n${todos.map((t) => `${t.step}. ${t.text}`).join("\n")}\n\nAfter fully completing a todo, include [DONE:n] for that todo number in your assistant response.`,
      { deliverAs: "followUp" },
    );
  }

  pi.registerTool({
    name: PLAN_TOOL,
    label: "Plan Questionnaire",
    description:
      "Ask the user one or more multiple-choice questions during plan mode when an important requirement, scope, risk, or implementation decision needs user input. Always provide clear options and allow a custom answer when appropriate.",
    executionMode: "sequential",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          id: Type.String({ description: "Stable short id, e.g. scope, api, risk" }),
          prompt: Type.String({ description: "Question to ask the user" }),
          options: Type.Array(
            Type.Object({
              label: Type.String({ description: "Option shown to the user" }),
              description: Type.Optional(Type.String({ description: "Why/when this option is appropriate" })),
            }),
          ),
          allowOther: Type.Optional(Type.Boolean({ description: "Offer a free-form answer option; defaults to true" })),
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return { content: [{ type: "text", text: "Questionnaire unavailable: no interactive UI." }], details: { cancelled: true } };
      }

      const answers: Array<{ id: string; answer: string; custom: boolean }> = [];
      for (const q of params.questions) {
        const options = q.options.map((o: { label: string; description?: string }) => o.description ? `${o.label} — ${o.description}` : o.label);
        if (q.allowOther !== false) options.push("Type a custom answer…");
        const choice = await ctx.ui.select(q.prompt, options);
        if (!choice) return { content: [{ type: "text", text: "User cancelled the questionnaire." }], details: { cancelled: true, answers } };
        if (choice === "Type a custom answer…") {
          const custom = await ctx.ui.input(q.prompt);
          answers.push({ id: q.id, answer: custom?.trim() || "(no answer)", custom: true });
        } else {
          answers.push({ id: q.id, answer: choice.replace(/ — .*/, ""), custom: false });
        }
      }

      return {
        content: [{ type: "text", text: answers.map((a) => `${a.id}: ${a.custom ? "user wrote" : "user selected"}: ${a.answer}`).join("\n") }],
        details: { cancelled: false, answers },
      };
    },
  });

  pi.registerCommand("plan", {
    description: "Toggle/read Codex-style plan mode. Args: on, off, status, execute, clear",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on") return setPlanMode(true, ctx);
      if (arg === "off") return setPlanMode(false, ctx);
      if (arg === "execute") return executePlan(ctx);
      if (arg === "clear") {
        todos = [];
        executing = false;
        updateUi(ctx);
        persist();
        return ctx.ui.notify("Plan todos cleared.", "info");
      }
      if (arg === "status") {
        const state = enabled ? "planning" : executing ? "executing" : "off";
        return ctx.ui.notify(`Plan mode: ${state}${todos.length ? `\n${todoLines(todos).join("\n")}` : ""}`, "info");
      }
      return setPlanMode(!enabled, ctx);
    },
  });

  pi.registerCommand("todos", {
    description: "Show the current plan todo list",
    handler: async (_args, ctx) => ctx.ui.notify(todos.length ? todoLines(todos).join("\n") : "No plan todos yet.", "info"),
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Toggle plan mode",
    handler: async (ctx) => setPlanMode(!enabled, ctx),
  });

  pi.on("tool_call", async (event) => {
    if (!enabled) return;
    if (PLAN_DISABLED_TOOLS.has(event.toolName)) {
      return { block: true, reason: "Plan mode is read-only. Accept/execute the plan or run /plan off before modifying files." };
    }
    if (event.toolName === "bash" && !isSafeReadOnlyCommand(String(event.input.command ?? ""))) {
      return { block: true, reason: `Plan mode blocked non-read-only bash command: ${event.input.command}` };
    }
  });

  pi.on("context", async (event) => {
    return {
      messages: event.messages.filter((m: any) => {
        if (!enabled && m?.customType === "plan-mode-context") return false;
        if (!executing && m?.customType === "plan-execution-context") return false;
        const text = messageText(m);
        if (!enabled && text.includes("[PLAN MODE ACTIVE]")) return false;
        if (!executing && text.includes("[EXECUTING ACCEPTED PLAN]")) return false;
        return true;
      }),
    };
  });

  pi.on("before_agent_start", async () => {
    if (enabled) {
      return {
        message: {
          customType: "plan-mode-context",
          display: false,
          content: `[PLAN MODE ACTIVE]
You are in Codex-style plan mode. Investigate safely and do not change files.

Rules:
- Do not call edit/write or otherwise modify files.
- Bash is limited to read-only inspection commands.
- Identify important decision points: scope ambiguity, API/design choices, migrations, compatibility risks, test strategy, destructive steps, or user preference tradeoffs.
- At those decision points, use the ${PLAN_TOOL} tool with concise options. Prefer batching related questions.
- Once enough information is gathered, produce a final numbered plan under exactly this header:

Plan:
1. ...
2. ...

Keep steps actionable and ordered. Do not execute the plan until the user accepts it.`,
        },
      };
    }

    if (executing && todos.length > 0) {
      return {
        message: {
          customType: "plan-execution-context",
          display: false,
          content: `[EXECUTING ACCEPTED PLAN]
Current todo list:
${todoLines(todos).join("\n")}

Execute incomplete todos in order. Include [DONE:n] in your response only after todo n is complete.`,
        },
      };
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    if (executing) return;
    if (!enabled) return;

    const lastAssistant = [...event.messages].reverse().find((m: any) => m?.role === "assistant");
    if (!lastAssistant) return;
    const extracted = extractTodoItems(messageText(lastAssistant));
    if (extracted.length === 0) return;
    todos = extracted;
    persist();

    const choice = ctx.hasUI
      ? await ctx.ui.select("Plan ready", ["Execute the plan and track todos", "Stay in plan mode", "Ask the agent to refine the plan"])
      : undefined;

    if (choice?.startsWith("Execute")) return executePlan(ctx);
    if (choice?.startsWith("Ask")) {
      const refinement = await ctx.ui.editor("What should be changed in the plan?", "");
      if (refinement?.trim()) pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!executing || todos.length === 0 || event.message?.role !== "assistant") return;
    if (markCompletedSteps(messageText(event.message), todos) > 0) updateUi(ctx);
    if (todos.every((t) => t.completed)) {
      pi.sendMessage({ customType: "plan-complete", content: `**Plan complete.** ✓\n\n${todoLines(todos).join("\n")}`, display: true }, { triggerTurn: false });
      executing = false;
    }
    updateUi(ctx);
    persist();
  });

  pi.on("session_start", async (_event, ctx) => {
    enabled = pi.getFlag("plan") === true;
    const stateEntry = ctx.sessionManager
      .getEntries()
      .filter((e: any) => e.type === "custom" && e.customType === "plan-mode")
      .pop() as { data?: PlanModeState } | undefined;

    if (stateEntry?.data) {
      enabled = stateEntry.data.enabled ?? enabled;
      executing = stateEntry.data.executing ?? false;
      todos = stateEntry.data.todos ?? [];
      toolsBeforePlanMode = stateEntry.data.toolsBeforePlanMode;
    }

    if (enabled) enablePlanTools();
    updateUi(ctx);
  });
}
