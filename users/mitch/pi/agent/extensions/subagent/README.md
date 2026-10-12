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

## Conversation lifecycle

A handle identifies a durable conversation. Each invocation launches a short-lived
Pi subprocess, while the handle remains available for later invocations. Omitting
a handle creates a fresh conversation; supplying a handle continues its history.

Conversations belong to a parent session, creator and working directory.
The service owns native session files, metadata, locks and transcript observation
under `<agent-dir>/subagents/`. Handles expose no storage paths. Completing,
failing or cancelling a run, closing Pi and switching sessions preserve the
conversation. Only its creator explicitly deletes it; there is no automatic pruning.

Workflow owns its role handles and deletes them after todo completion or explicit
discard. Ad-hoc tools manage the parent's separate ad-hoc handles. Both kinds
appear in the viewer for that parent. Forking a parent creates a different owner;
it grants no authority to continue or delete the original parent's conversations.

## Ad-hoc tools and skills

`subagent({ agent, task, handle? })` delegates one task. The selected definition
is supplied on each invocation, so a conversation can continue with a different
agent profile. Supply requirements and relevant context explicitly.

The result includes `handle`, bounded `output` and an optional `error`.
The handle also appears in the textual result. Codemode receives structured data:

```javascript
const first = await tools.subagent({
  agent: "worker",
  task: "Investigate the authentication failure and explain the cause."
});
text(first);
const followUp = await tools.subagent({
  agent: "worker",
  handle: first.handle,
  task: "Apply the proposed fix and validate it."
});
text(followUp);
```

- `subagent_list({})` returns the current parent's owned ad-hoc conversations.
  Use it after resuming a parent to discover earlier handles.
- `subagent_delete({ handle })` permanently deletes an owned ad-hoc conversation.
  Active runs must finish or be stopped first. Workflow owns deletion of its handles.

Skills can describe flows using these tools. Callers choose sequential or
concurrent execution and remain responsible for conflicting edits and stale
reads in the shared host worktree. Runs on the same handle are exclusive.
Planning modes block delegation and conversation deletion, including codemode calls.

## Read-only TUI

Open `/subagents` or press `Ctrl+Alt+A` while idle or working. The picker lists
the current parent and its saved subagent conversations, including workflow role
conversations during human review. Selecting the parent returns to its normal UI.
Selecting a child opens a full-screen transcript without switching Pi sessions.

| Control | Behaviour |
|---|---|
| Up/Down, Enter | Select a conversation |
| Up/Down, PageUp/PageDown | Scroll a transcript |
| Home | Go to the beginning and pause following |
| End | Follow the newest output |
| `o` or the tools-expansion key (normally Ctrl+O) | Expand/collapse tool arguments and results |
| `t` or the thinking-toggle key (normally Ctrl+T) | Expand/collapse recorded thinking |
| `i` | Expand/collapse delegated and recorded system instructions |
| Escape or Ctrl+C | Transcript → picker → parent |

Messages and tool activity update live. Scrolling upwards pauses following;
reaching the bottom or pressing End resumes it. Provider-exposed thinking is
shown when available; withheld reasoning cannot be reconstructed. A deleted
conversation already on screen remains readable until the view closes.

The viewer sends no prompts, controls no subprocesses and changes no session
files. Closing it leaves execution running. It is available in terminal mode;
other modes receive a notification. Reload and session changes close the viewer
and release subscriptions.

## TypeScript lifecycle API

A sibling extension can create and reuse its own handles:

```typescript
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { discoverAgents, requireAgent } from "../subagent/agents.ts";
import { getConversationService } from "../subagent/api.ts";
import { createSubprocessModelRegistry, requireExecutableAgents } from "../subagent/models.ts";

const service = getConversationService(path.join(getAgentDir(), "subagents"));
const owner = {
  parentSessionId: ctx.sessionManager.getSessionId(),
  creator: "my-extension",
  cwd: ctx.cwd,
};
const agent = requireAgent(discoverAgents(getAgentDir()), "reviewer");
await requireExecutableAgents([agent], await createSubprocessModelRegistry(signal));
const handle = service.create(owner, "Review authentication");
const result = await service.run(owner, handle, agent, {
  task: "Review the supplied assignment.",
  signal,
});
// Persist handle in caller state for later invocations; delete when policy requires.
service.delete(owner, handle);
```

`run()` accepts additional `instructions`, explicit `skillPaths`, progress
callbacks and an abort signal. `get()` and `hasHistory()` validate owned handles.
`list()` lists a creator's conversations, and `deleteOwned()` releases its
conversations, including allocations interrupted before caller-state persistence.
`acquire()` provides explicit group coordination where callers require several
conversations to execute sequentially, as workflow does.

`listParent()`, `inspect()` and `subscribe()` supply read-only observations
across creators for the parent viewer. Live state is shared across independent
Pi extension loads. Integrations need no viewer-specific events or file access.

Inside another tool's `execute()` handler,
`ctx.executeTool("subagent", { agent, task, handle }, { signal })` also works
through Pi's validation and tool hooks.

## Execution, recovery and privacy

Children use native session files and JSON mode. They disable extension, skill
and prompt-template discovery and explicitly load Bash policy. Workflow supplies
selected skill paths; ad-hoc calls start with an empty skill selection.
Context-file discovery follows the agent definition.

The tool reports accumulated child usage. Textual output is capped at 50 KiB;
full results remain in tool details and the transcript. Model errors, truncated
responses and non-zero exits report failure while retaining the handle and
available partial output. Native history and recovery data reconcile streamed
messages with completed records.

Closing or changing the parent stops active ad-hoc children and preserves their
handles. Workflow stops its own invocations. On POSIX hosts cancellation
terminates the process group, including shell descendants. After abrupt exits,
live workers and unresolved launch fences block unsafe reuse or deletion.
Inspect the reported lease path before manual recovery.

Transcripts can contain prompts, file contents, command output and secrets exposed
to the model. Managed files are private and ignored by Git. Subprocesses retain
the user's host permissions; tool restrictions and Bash policy are guardrails,
with operating-system isolation supplied separately.

## Tests

Run `npm test` in this directory and `../workflow`. Tests use the installed
Node-based Pi API and deterministic subprocess peers without model requests.
The loader recognises npm/Nix installations and `PI_PACKAGE_DIR`.
Workflow's real-model tests remain opt-in.

The lifecycle API uses opaque conversation handles. Workflow state version 9
also records human design checkpoints and plan amendments. Existing workflows
need a new plan; earlier transcripts remain untouched. Ad-hoc runs made before durable handles were introduced cannot be
reconstructed retrospectively.
