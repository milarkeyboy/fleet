# Shared subagents

The `subagent` tool and TypeScript workflows use one global set of agent
definitions and one subprocess runner. Pi discovers this extension from
`~/.pi/agent/extensions/subagent/index.ts`; run `/reload` after installing it.

## Agent definitions

Create `~/.pi/agent/agents/<name>.md`, or the equivalent `agents/` directory
under a custom Pi agent directory:

```markdown
---
name: reviewer
description: Independently review code changes and report actionable findings.
model: openai-codex/gpt-6.1-sol
thinkingLevel: high
tools: [read, grep, find, ls]
context-file-discovery: true
---
You are an independent reviewer. Inspect the supplied changes and report
concrete findings with file paths.
```

- `name` must match the filename and use lowercase letters, numbers and hyphens.
- `description`, an explicit `provider/model` assignment and a prompt are required.
- `tools` is a non-empty YAML list or comma-separated string drawn from `read`,
  `grep`, `find`, `ls`, `bash`, `edit` and `write`.
- `thinkingLevel` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
  or `max`; omission selects `off`, including for resumed conversations.
- `context-file-discovery` defaults to `true`. Set it to `false` to disable
  automatic `AGENTS.md`/`CLAUDE.md` discovery for the child.

Definitions are global. Each invocation reloads the selected definition;
`/reload` also refreshes the agent descriptions advertised to the parent model.
Invalid definitions produce diagnostics and cannot be selected.

Models and credentials must be available to the child through Pi's built-in
catalogue, global model/authentication files or inherited environment.
Parent-only provider registrations and runtime `--api-key` overrides cannot
supply isolated subprocesses.

## Ad-hoc delegation and skills

Ask Pi to delegate a task, or have a skill instruct it to call:

```json
{
  "agent": "reviewer",
  "task": "Review the authentication changes against these requirements: ..."
}
```

Each `subagent` call runs one fresh, non-persisted conversation in the parent's
working directory. Supply the requirements and relevant context explicitly.
The child receives its global prompt and settings, plus the task.

Skills can describe multi-stage flows using several calls. Codemode can call
the tool directly:

```javascript
const result = await tools.subagent({
  agent: "reviewer",
  task: "Review the current authentication changes and return actionable findings."
});
text(result);
```

Callers choose sequential or concurrent execution and are responsible for
conflicting edits and stale reads. Children share the host working tree.
Workflow's conversation leases protect its own transcripts; ad-hoc calls use
independent conversations and can overlap workflow execution.

Workflow planning and the standalone plan-mode extension block delegation,
including calls through codemode. Leaving planning restores the tool.

## TypeScript execution

A sibling extension can use the shared modules directly from commands, tools or
lifecycle handlers:

```typescript
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { discoverAgents, requireAgent } from "../subagent/agents.ts";
import { runSubagent } from "../subagent/api.ts";
import { createSubprocessModelRegistry, requireExecutableAgents } from "../subagent/models.ts";

const agent = requireAgent(discoverAgents(getAgentDir()), "reviewer");
await requireExecutableAgents([agent], await createSubprocessModelRegistry(signal));
const result = await runSubagent(agent, {
  cwd: ctx.cwd,
  task: "Review the supplied assignment.",
  signal,
});
```

`runSubagent()` applies the shared definition. Callers can supply additional
`instructions`, explicit `skillPaths`, a persistent `sessionFile`, progress
callbacks and process-ownership tracking. The caller owns persistent session
creation, locking, resumption and deletion. Workflow retains those responsibilities,
along with its review protocol, revision limits, diffs and human checkpoints.

Inside another tool's `execute()` handler, Pi also supports
`ctx.executeTool("subagent", { agent, task }, { signal })`. Nested calls pass
through Pi's validation and tool hooks. Command and ordinary lifecycle contexts
use the shared modules directly.

## Execution and results

Children use JSON mode, disable extension/skill/prompt-template discovery and
explicitly load the Bash-policy extension. Workflow supplies selected skill paths;
ad-hoc calls start with an empty skill selection. Context-file discovery follows
the agent definition.

The tool reports progress and accumulated child usage. Model-facing results are
capped at 50 KiB, with full results and failure diagnostics retained in tool
details. Failed model responses, truncated responses and non-zero exits report
failure. Cancellation waits for child shutdown and removes temporary prompts.
On POSIX hosts the runner terminates the child's process group so shell
descendants are included. Session shutdown, reload, tree navigation and forking
cancel active ad-hoc calls.

Subprocesses run with the user's host permissions. Tool selection and the Bash
policy are guardrails; operating-system isolation requires a separate boundary.

## Tests

Run `npm test` in this directory and in `../workflow`. Tests use the installed
Node-based Pi API and deterministic child processes, with no model requests.
The test loader recognises conventional npm/Nix installations and
`PI_PACKAGE_DIR`. Workflow's real-model tests remain opt-in.
