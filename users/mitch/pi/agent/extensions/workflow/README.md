# Workflow: planned implement/review/human cycles for pi

`/workflow` turns a plan into sequential, isolated implementer and reviewer runs, then pauses for human approval after every todo. Planning remains conversational in the top-level pi session; the extension does not use a planner subagent or planner role.

## Lifecycle

```text
conversational planning
  → implementer (isolated context)
  → reviewer (fresh, read-only context)
  → one automatic revision when requested
  → human acceptance
  → next todo
```

A todo is complete only after review and explicit human approval.

## Commands

| Command | Purpose |
|---|---|
| `/workflow` or `/workflow on` | Enable conversational, read-only workflow planning |
| `/workflow off` | Leave planning without executing |
| `/workflow execute` | Execute the accepted plan |
| `/workflow status` / `todos` | Show todo state and optional skill assignments |
| `/workflow skills` | List discovered Agent Skills |
| `/workflow skill N NAME\|none` | Assign or clear a todo's primary skill |
| `/workflow models` | Show implementer and reviewer model configuration |
| `/workflow model ROLE PROVIDER/MODEL [LEVEL]` | Configure a role model and optional thinking level |
| `/workflow review` | Show the current checkpoint and approval menu |
| `/workflow approve` | Approve the current todo and start the next |
| `/workflow feedback [text]` | Request a revision followed by another review |
| `/workflow diff [step]` | Show the todo-specific Git diff |
| `/workflow pause` / `resume` | Pause or resume orchestration |
| `/workflow abort` | Abort the current todo |
| `/workflow roles` | Show resolved roles, skills, and diagnostics |
| `/workflow reload` | Reload Markdown customizations |
| `/workflow init` | Copy portable placeholders into the project |
| `/workflow clear` | Clear workflow state |

`pi --workflow` starts with workflow planning enabled.

## Role models

Both subagent roles require explicit global model assignments before execution:

```text
/workflow model implementer openai-codex/gpt-5.6-sol high
/workflow model reviewer openai-codex/gpt-5.6-sol high
/workflow models
```

Configuration is stored in pi's agent directory at `workflow/config.json` (normally `~/.pi/agent/workflow/config.json`). It is deliberately outside repositories and portable Markdown. Subagents never fall back to the top-level model or thinking level.

Before changing todo state, the extension creates a subprocess-equivalent model registry and checks both model availability and authentication. Models registered only by extensions are unavailable because subagents use `--no-extensions`. A top-level `--api-key` is runtime-only and is not inherited; credentials must be available through `/login`/`auth.json`, `models.json`, or the inherited environment.

The exact model and thinking level used are recorded with each implementation and review artifact and shown in todo summaries.

## Planning and optional skills

Planning uses the top-level session's selected model, conversation, context files, and normal system prompt. The extension adds only plan-format instructions and the names and descriptions of currently discovered skills. Planning remains read-only, with `workflow_questionnaire` available for important decisions.

Final plans use numbered todos under `Plan:`. A todo may carry one primary skill tag, but tags are optional:

```markdown
Plan:
1. Update the general TypeScript workflow state.
2. [rust] Implement the Rust parser and focused tests.
3. [python] Update the Python bindings.
```

The planner is told to leave work untagged when no discovered skill applies. Untagged todos execute normally without a primary skill. Tags must use exact discovered skill names. An unknown explicit tag must be resolved interactively or with `/workflow skill N NAME|none` before execution.

Legacy persisted language assignments retain their exact names, while old inferred assignments are cleared.

## Portable roles and Agent Skills

Run `/workflow init` in a trusted project to create:

```text
.agents/
└── workflow/
    └── roles/
        ├── implementer.md
        └── reviewer.md
```

Role files are plain Markdown prompts with no frontmatter, so they can also be supplied directly to other subagent harnesses.

Add any standard Agent Skill at `~/.agents/skills/<name>/SKILL.md` or `.agents/skills/<name>/SKILL.md`; recursive discovery makes it immediately available without TypeScript changes.

Discovery precedence is:

1. user `~/.agents/skills/`
2. trusted project `.agents/skills/`

Project skills override user skills with the same canonical name. `/workflow roles` reports overrides, invalid skills, and duplicate names. Project content is ignored until the project is trusted.

## Context isolation

Every implementer and reviewer is a fresh pi JSON-mode subprocess launched with:

- `--no-session`
- `--no-extensions`
- `--no-skills`, followed by zero or more explicit `--skill` arguments
- `--no-prompt-templates`
- `--no-context-files`
- the role's required configured model and thinking level

The implementer receives only its role, selected primary skill, current todo, relevant paths, concise prerequisite handoffs, and revision feedback. The reviewer receives its role, the selected primary skill, the todo-specific diff, implementation summary, and validation results. Reviewer tools exclude `edit`, `write`, and `bash`.

## Git, review, and persistence

Todos run sequentially in the current working tree. In Git repositories, before/after snapshots use a temporary index and include tracked and untracked non-ignored files without changing the real index or worktree. Outside Git, execution still works but per-todo diffs are unavailable.

A reviewer returns `approve`, `request_changes`, or `escalate`. The first rejection receives one automatic revision and second review; another rejection escalates to the human checkpoint. Human feedback starts a fresh bounded cycle.

Versioned session entries persist todos, primary skills, summaries, model records, review findings, and pending human approval.

## Security

Repository-controlled roles and skills are instructions and may include executable helpers. Project content is loaded only for trusted projects. Review shared Markdown before use. Implementers have normal write and shell tools; reviewers are hard-limited to read/search tools.
