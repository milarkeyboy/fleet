# Workflow: planned implement/review/human cycles for pi

`/workflow` turns a plan into sequential, isolated implementer and reviewer
runs, then pauses for human approval after every todo. Planning remains
conversational in the top-level pi session; the extension does not use a planner
subagent or planner role.

## Lifecycle

```text
conversational planning
  → implementer (isolated context)
  → reviewer (separate, read-only conversation)
  → one automatic revision when requested
  → human acceptance
     ↳ feedback → implementer → reviewer (repeat as needed)
  → next todo
```

A todo is complete after review and explicit human approval, or when the user
explicitly marks it completed manually by forcing execution from a later todo.

## Commands

| Command | Purpose |
|---|---|
| `/workflow` or `/workflow on` | Enable conversational, read-only workflow planning |
| `/workflow off` | Leave planning without executing |
| `/workflow execute [step]` | Execute the accepted plan, or cancel the active run and continue from a later pending todo |
| `/workflow status` / `todos` | Show todo state and optional skill assignments |
| `/workflow skills` | List discovered Agent Skills |
| `/workflow skill N NAME\|none` | Assign or clear a todo's primary skill |
| `/workflow models` | Show implementer and reviewer model configuration |
| `/workflow model ROLE PROVIDER/MODEL [LEVEL]` | Configure a role model and optional thinking level |
| `/workflow review` | Show the current checkpoint and approval menu |
| `/workflow approve` | Approve the current todo and start the next |
| `/workflow feedback [text]` | Request a revision followed by another review |
| `/workflow diff [step]` | Show net changes since the previous human checkpoint |
| `/workflow pause` / `resume` | Pause or resume orchestration |
| `/workflow abort` | Abort the current todo |
| `/workflow roles` | Show resolved roles, skills, and diagnostics |
| `/workflow init` | Copy portable role placeholders into the project |
| `/workflow clear` | Clear workflow state |

`pi --workflow` starts with workflow planning enabled.

## Role models

Both subagent roles require explicit global model assignments before execution:

```text
/workflow model implementer openai-codex/gpt-5.6-sol high
/workflow model reviewer openai-codex/gpt-5.6-sol high
/workflow models
```

Configuration is stored in pi's agent directory at `workflow/config.json`
(normally `~/.pi/agent/workflow/config.json`). It is deliberately outside
repositories and portable Markdown. Subagents never fall back to the top-level
model or thinking level. An omitted role thinking level selects `off`, including
when reopening a conversation that previously used another level.

Before changing todo state, the extension creates a subprocess-equivalent model
registry and checks both model availability and authentication. Models
registered only by extensions are unavailable because subagents use
`--no-extensions`. A top-level `--api-key` is runtime-only and is not inherited;
credentials must be available through `/login`/`auth.json`, `models.json`, or
the inherited environment.

The exact model and thinking level used are recorded with each implementation
and review artefact and shown in todo summaries.

## Planning and optional skills

Planning uses the top-level session's selected model, conversation, context
files, and normal system prompt. While planning is active, the extension appends
the bundled `content/planner.md`, typed-submission instructions, and the names
and descriptions of currently discovered skills. Planning remains read-only,
with the shared `questionnaire` tool available for important decisions.

The planner submits its final plan through `workflow_submit_plan` as native todo
objects containing a title, an instructions array, and an optional primary
skill. The extension does not parse an assistant Markdown response. Every
requirement needed during implementation or review must be included in the
instructions array because subagents do not inherit the planning conversation.

One deterministic formatter renders those objects as the canonical plan shown by
the submission tool, `/workflow status`, and `/workflow todos`. The same
formatter supplies the complete plan and current todo to both subagent roles.
Role protocols, workflow statuses, human feedback, implementation results, and
diffs are additional context rather than part of the canonical plan. This
guarantees delivery of the reviewed plan text, not model compliance with it.

The planner is told to leave the primary skill unset when no discovered skill
applies. Untagged todos execute normally. Skill values must use exact discovered
names. An unknown explicit skill must be resolved interactively or with
`/workflow skill N NAME|none` before execution.

Workflow state uses version 6. Older workflows require a new plan; their state
and subagent conversations are not migrated.

## Portable roles and Agent Skills

Run `/workflow init` in a trusted project to create:

```text
.agents/
└── workflow/
    └── roles/
        ├── implementer.md
        └── reviewer.md
```

Role files are plain Markdown prompts with no frontmatter, so they can also be
supplied directly to other subagent harnesses.

Add any standard Agent Skill at `~/.agents/skills/<name>/SKILL.md` or
`.agents/skills/<name>/SKILL.md`; recursive discovery makes it immediately
available without TypeScript changes.

Discovery precedence is:

1. user `~/.agents/skills/`
2. trusted project `.agents/skills/`

Project skills override user skills with the same canonical name. `/workflow
roles` reports overrides, invalid skills, and duplicate names. Project content
is ignored until the project is trusted.

## Execution and policy

Pi and workflow subagents execute in the host working tree. Bash commands run
on the host with the invoking user's normal permissions; there is no Gondolin
VM or QEMU boundary in the current configuration. File tools likewise operate
on the host workspace.

The bash-policy extension is enabled for top-level sessions and is explicitly
loaded by each workflow subprocess. It denies selected textual forms of
high-risk bash commands before execution: privilege escalation, host
management, destructive Git operations (including direct matched forms of
`git push`), catastrophic deletion, and selected global package-install
forms. Its matching is deterministic: rules are evaluated in fixed source
order and the first match supplies the denial category.

The policy is only a guardrail, not a sandbox or complete security boundary.
It uses text matching rather than a shell parser, so command prefixes such as
`git -C repo push`, `/usr/bin/git push`, and `command git push`, as well as
obfuscation and indirect execution, may evade it. It does not restrict
filesystem, network, or process access, and accepted commands can affect the
host. Review consequential commands and do not infer safety from the absence
of a denial. The Gondolin source remains under `extensions/gondolin` for
possible future re-enablement, but it is excluded from extension discovery in
the current settings.

## Context isolation

Each todo owns two persisted Pi conversations: one implementer and one reviewer.
Automatic revisions, human feedback and retries reopen the same role conversation.
The next todo starts new conversations. Each invocation uses a short-lived Pi
JSON-mode subprocess launched with:

- `--session <role-session-file>`
- `--no-extensions`
- `--no-skills`, followed by zero or more explicit `--skill` arguments
- `--no-prompt-templates`
- the role's required configured model and thinking level

Subagents retain Pi's normal context-file discovery, including applicable user
and project `AGENTS.md` files. Both roles receive the complete canonical
workflow plan and a separate status list marking each todo as approved,
completed manually, current, upcoming, or aborted. The plan is a scope boundary:
implementers must not absorb upcoming work, and reviewers must flag scope
leakage without requesting work assigned to later todos.

Both roles receive an authoritative system-prompt snapshot containing the complete
plan, current assignment and chronological human feedback for the current todo.
Pi preserves that system snapshot through compaction while summarising older
conversation messages. Earlier requirements remain in force unless later human
feedback explicitly supersedes them. Explicit human revision requirements can
override the plan boundary.

Initial implementer messages include relevant paths and concise prerequisite
handoffs. Follow-ups identify the current revision and supply the latest reviewer
findings. Reviewer messages supply the current revision's diff, implementation
summary and validation results. Both roles inspect current files rather than
assuming earlier reads remain accurate. Reviewers reassess changes independently
of their earlier verdicts. Reviewer tools exclude `edit`, `write`, and `bash`.

## Git, review, and persistence

Todos run sequentially in the current working tree. In Git repositories,
before/after snapshots use a temporary index and include tracked and untracked
non-ignored files without changing the real index or worktree. Outside Git,
execution still works but per-todo diffs are unavailable.

`/workflow execute N` forces execution from later pending todo `N`. Any
unfinished earlier todos are persisted as `completed-manually`, the active
implementer or reviewer is terminated, and execution starts at `N` after
subprocess cleanup. This is intended for changes made directly by the user;
manually completed todos remain visible to later subagents but have no generated
implementation handoff.

A reviewer returns `approve`, `request_changes`, or `escalate`. The first
rejection receives one automatic revision and second review; another rejection
escalates to the human checkpoint. Human feedback starts a fresh bounded cycle.

Every acceptance checkpoint summary includes the chronological history for that
todo: human feedback followed by the implementer and reviewer response for each
revision, plus the files changed in each revision. This history is retained
across session restarts, so later feedback rounds do not hide earlier summaries.

Each reviewer invocation supplies the current automatic revision's diff; earlier
diffs remain historical context in its conversation. At human
acceptance, Inspect todo diff and `/workflow diff` show the net Git diff since
the previous human checkpoint. The first checkpoint starts at the todo's initial
baseline; human feedback starts a new checkpoint before the next implementer
runs. The human therefore sees changes from every automatic implement/review
cycle since they last reviewed or supplied feedback. These checkpoint diffs are
persisted, and older sessions reconstruct them from their retained tree
snapshots when possible.

Versioned session entries persist todos, primary skills, chronological revision
summaries, model records, review findings, pending human approval, manual
completion state, role-session references and execution checkpoints.

### Storage, interruption and cleanup

Role transcripts are private files under
`<agent-dir>/workflow/sessions/<workflow-id>/`, normally within `~/.pi/agent/`.
The managed directory records its parent-session ownership. A workflow-wide lease
prevents concurrent workers from writing the same conversations.

Orderly quit or reload stops and awaits the active subprocess, preserving
unfinished conversations. On restart, in-flight todos are marked `interrupted`;
use `/workflow execute` or `/workflow resume` to continue explicitly. A completed
implementation can proceed directly to review. An interrupted implementer
reconciles existing edits, and its diff retains the original pre-invocation
baseline. Files remain in the working tree; stopping a workflow does not undo
changes.

After an abrupt parent exit, a surviving worker blocks resumption and cleanup
until it exits. Stale leases can be reclaimed once both recorded processes have
exited. An interruption during lock acquisition or child launch requires manual
inspection of the lock path reported in the error before removing that lock.

Approval, manual completion and abort delete the finished todo's role transcripts.
Clearing or replacing a plan deletes that workflow's transcripts after workers
stop. Summaries, feedback and cached diffs remain in retained parent-session
entries; small ownership metadata files remain in the managed directory.
Missing or invalid established transcripts cause an error rather than silently
starting an empty conversation. Clear the workflow and submit a new plan to
recover.

Resumption supports linear parent-session history. Navigating to a divergent
history or forking the parent requires a new plan. The extension preserves the
other history's transcripts and refuses to reuse or delete them from the new
history.

## Tests

Run `npm test` in the extension directory. Tests use deterministic subprocess
peers and temporary workspaces. When a Node-based Pi installation is available on
`PATH`, session-format and compaction checks also run against its real SDK without
calling a provider.

Real-model isolation and conversational-continuity tests are opt-in:

```sh
PI_WORKFLOW_E2E=1 PI_WORKFLOW_E2E_MODEL=provider/model npm test
```

These tests use configured credentials and incur model usage.

## Security

Repository-controlled planner prompts, roles, and skills are instructions and
may include executable helpers. Project content is loaded only for trusted
projects. Review shared Markdown before use. Implementers have normal write and
shell tools; reviewers are hard-limited to read/search tools.
