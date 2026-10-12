# Workflow: human design, agent implementation and review

`/workflow` executes sequential todos in a Git working tree. Planning uses the
normal top-level Pi conversation. Each executed todo starts with human design
editing, followed by isolated implementation and review agents.

## Lifecycle

```text
conversational planning
  → human design editing
  → design review → human design acceptance
  → implementation → code review ↔ automatic code revisions
  → human code acceptance
  → next todo's design editing
```

An empty design diff skips the design reviewer and still requires human
confirmation. Review verdicts are advisory; acceptance is an explicit human
command. Forced execution from a later todo marks skipped work completed manually.

See the [concise diagrams and design rules](design/README.md).

## Human-owned design

Entering design captures a Git baseline. Edit repository files using an external
editor, then request review. The changes since entering the phase identify the
design, including Markdown, Doxygen, signatures and types. Earlier edits remain
repository context. Design changes may temporarily break compilation.

Agents receive the human design diffs and instructions to preserve the design.
Ownership relies on instructions and review; implementers retain normal write
and shell tools. The human chooses the design material through their edits.

```text
/workflow execute
# Edit design files, or leave the design unchanged.
/workflow design-review
/workflow diff
/workflow design-approve
# Inspect implementation and code review.
/workflow review
/workflow approve
```

Design review checks consistency, feasibility, missing decisions, scope and
testability. Code review checks implementation quality and conformance to the
accepted design. Both reviewers have read/search tools only.

Further design edits can be submitted with `design-review` again. All reviews
in a design phase share its original baseline and role conversation.
`design-feedback` asks the reviewer to reconsider, with optional human feedback.
Changes made during review or before acceptance require another review.

## Changing design or scope

Use `/workflow design` before editing design during implementation. The extension
stops and awaits the active worker, preserves partial work and enters human
editing. After acceptance, the implementer reconciles retained work against the
revised contract. Code review also receives earlier implementation diffs so
retained work is reassessed.

Implementers and code reviewers report structured `design` or `plan` blockers
when a human decision is needed. Blockers bypass automatic revisions and pause
at a change checkpoint. Choose `design` or `replan` to resolve them. Ordinary code
feedback remains within the accepted design and plan scope.

`/workflow replan` stops workers and enters conversational amendment in the
top-level session. The agent submits a proposal through `workflow_submit_plan`
with the current `baseRevision`, stable todo `id` values and `affectedIds`.
Status lists the identities and staged proposal. Submission leaves the accepted
plan unchanged; `/workflow plan-approve` accepts it and `/workflow plan-reject`
retains the accepted plan.

Amendments:

- Retain existing todo identities; omit `id` for newly added work.
- Confirm every changed or otherwise affected unfinished todo in `affectedIds`.
  New todos are affected automatically.
- Keep completed todos at the beginning, unchanged and in their existing order.
  Add corrective todos when completed work needs changing.
- Preserve plan history, results and role conversations when splitting or
  reordering unfinished work.
- Invalidate affected approvals and require renewed design acceptance.
  Unaffected checkpoints remain available.

Affected design edits already made remain available for review against the
amended plan. Older requirements and findings remain historical where the new
assignment supersedes them.

## Commands

| Command | Purpose |
|---|---|
| `/workflow [on\|off]` | Toggle initial conversational planning with local write guards |
| `/workflow execute [step]` | Enter design, resume interrupted work, or skip to a later pending todo |
| `/workflow design` | Enter or return to human design editing after stopping workers |
| `/workflow design-review` | Review design changes, or prepare an empty-phase confirmation |
| `/workflow design-feedback [text]` | Ask the design reviewer to reconsider |
| `/workflow design-approve` | Accept the design checkpoint and start implementation |
| `/workflow replan` | Amend the accepted plan in the top-level conversation |
| `/workflow plan-approve\|plan-reject` | Decide a plan amendment |
| `/workflow review` | Show code results and the human acceptance menu |
| `/workflow approve` | Accept code and enter the next todo's design phase |
| `/workflow feedback [text]` | Request code revisions followed by review |
| `/workflow diff [step]` | Show phase-labelled design or code-checkpoint changes |
| `/workflow status\|todos` | Show the canonical plan, identities, phases and proposed amendment |
| `/workflow pause\|resume` | Stop and await workers, or explicitly resume orchestration |
| `/workflow abort` | Abort the current todo |
| `/workflow models` | Show all three role model assignments |
| `/workflow model ROLE PROVIDER/MODEL [LEVEL]` | Configure a role model and thinking level |
| `/workflow skills` / `skill N NAME\|none` | Inspect or assign optional primary skills |
| `/workflow roles` | Show resolved roles, skills and diagnostics |
| `/workflow init` | Scaffold portable role prompts in the trusted project |
| `/workflow clear` | Stop workers and clear workflow state |

`pi --workflow` enables initial planning. Use `replan` once work has started.
Commands work without an interactive UI; optional dialogues require UI support.

## Models and review allowance

Configure every subagent explicitly:

```text
/workflow model implementer openai-codex/gpt-5.6-sol high
/workflow model design-reviewer openai-codex/gpt-5.6-sol high
/workflow model code-reviewer openai-codex/gpt-5.6-sol high
```

Settings live outside repositories at
`<agent-dir>/workflow/config.json`, normally `~/.pi/agent/workflow/config.json`:

```json
{
  "implementer": {
    "model": "openai-codex/gpt-5.6-sol",
    "thinkingLevel": "high",
    "context-file-discovery": false
  },
  "design-reviewer": {
    "model": "openai-codex/gpt-5.6-sol",
    "thinkingLevel": "high"
  },
  "code-reviewer": {
    "model": "openai-codex/gpt-5.6-sol",
    "thinkingLevel": "high"
  },
  "max-review-cycles": 2
}
```

`context-file-discovery` defaults to `true` independently for each role.
Setting it to `false` passes Pi's `--no-context-files`; role prompts, the plan
and assigned skills are still supplied. An omitted thinking level selects `off`.

`max-review-cycles` is a positive safe integer, defaulting to `2`. It counts the
initial implement/code-review cycle. Code feedback starts a fresh allowance;
design review always returns to the human. Configuration reloads before each
execution, resumption or feedback round and stays fixed during automatic code
revisions. Model availability and authentication are checked before workers run.

Subagents use `--no-extensions`, so models require availability through Pi's
built-in catalogue or global `models.json`. Credentials come from login/auth
storage, model configuration or inherited environment. Top-level `--api-key`
overrides remain runtime-only. Artefacts record the model and thinking level used.

The previous `reviewer` assignment and role file are replaced by explicit
`design-reviewer` and `code-reviewer` settings and prompts. Configure both roles
and move any personalised code-review guidance to `code-reviewer.md`.

## Planning, roles and skills

Initial plans use typed `workflow_submit_plan` todos with a title, complete
instructions and an optional primary skill. Subagents receive the complete
canonical plan and current assignment, rather than the planning conversation.
External requirements should therefore be summarised in todo instructions.

Planning blocks built-in `edit` and `write` and restricts Bash to read-only
commands, including nested calls through `codemode`. MCP integrations, resource
access, `questionnaire` and temporary attachment downloads remain available.
MCP operations retain their server permissions, including any external writes.

Role Markdown customises personality and review preferences. Required workflow
instructions, result schemas and routing rules are supplied by the extension's
TypeScript protocols, independently of the customised Markdown.

`/workflow init` creates plain Markdown personality prompts under `.agents/workflow/roles/`:

```text
implementer.md
design-reviewer.md
code-reviewer.md
```

Role precedence is bundled, user `~/.agents/workflow/roles/`, then trusted project
`.agents/workflow/roles/`. Standard skills are discovered recursively under
`~/.agents/skills/` and trusted project `.agents/skills/`; project skills override
matching user names. Untagged todos run normally. Unknown selected skills require
resolution before execution. Role and skill Markdown should be reviewed before
trusting a project.

## Persistence and recovery

Each todo owns separate persisted role conversations. Revisions and retries
reuse them; subsequent todos start fresh conversations. Each invocation uses a
short-lived Pi JSON subprocess with `--session`, `--no-extensions`, `--no-skills`
and explicit selected skills, plus `--no-prompt-templates`. The host bash-policy
extension is loaded explicitly.

Authoritative system snapshots preserve the current plan, assignment, human
requirements and accepted design through compaction. Historical conversations
remain available, while the current snapshot governs superseded requirements.
Workers inspect current files; reviewers reassess independently of earlier verdicts.

Git snapshots use a temporary index and include tracked and untracked non-ignored
files under the working directory, preserving the real index and worktree.
Implementation revisions have separate before/after diffs from human design
phases. Code checkpoint diffs cover automatic cycles since the latest human code
feedback or design acceptance. Earlier implementation diffs remain review context.

State version 7 persists design and implementation history, plan amendments,
approvals, models, session references and recovery checkpoints. Older workflows
require a fresh plan; retained parent-session history and old conversations remain
available for inspection.

Private transcripts live under `<agent-dir>/workflow/sessions/<workflow-id>/`.
Stable todo identities keep paths valid after reordering. A persisted lease
prevents concurrent workers and blocks resumption while a surviving child exists.
Ambiguous interrupted launches require inspection of the reported lock path.

Quit, reload and pause stop and await workers. Restart marks in-flight work
interrupted and waits for explicit resumption. Interrupted implementation
reconciles existing edits; completed implementation can resume directly at code
review. Design review retains its baseline and feedback. Editing files after a
review invalidates that acceptance checkpoint.

Stopping preserves worktree edits. Code approval, manual completion and abort
remove finished todo transcripts while retaining summaries. Clearing or replacing
an initial plan removes its managed conversations; amendments preserve them.
Missing or invalid established transcripts require explicit recovery through a
fresh plan. Divergent parent-session histories and forks require new workflows;
other histories' transcripts remain untouched.

## Execution policy and tests

Agents run on the host with the invoking user's permissions. Implementers have
normal filesystem and Bash access. The bash-policy extension denies selected
textual forms of high-risk commands; its deterministic matching provides a
command guardrail. Review consequential commands because accepted commands can
still affect the host.

Run `npm test` in the extension directory. Tests use deterministic subprocess
peers and temporary Git workspaces. Real Pi SDK session and compaction checks run
when the installed SDK is available. Real-model tests are opt-in and incur usage:

```sh
PI_WORKFLOW_E2E=1 PI_WORKFLOW_E2E_MODEL=provider/model npm test
```
