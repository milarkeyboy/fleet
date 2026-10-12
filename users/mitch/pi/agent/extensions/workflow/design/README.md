# Human-owned design

Every todo enters human design editing before implementation. Git snapshots
capture changes since entering the phase. Earlier edits remain repository context.

The human's changes identify the design, including Markdown, Doxygen, signatures
and types. Agents preserve design intent, explicit contracts and documentation
through instructions and review. Skeleton completion, including constructors
and members, is implementation work unless explicit constraints forbid it.
No file classification or edit restrictions are used. Design changes may
temporarily break compilation.

Design review is read-only and advisory. Explicit human acceptance starts
implementation. An empty design diff requires human confirmation and skips the
design reviewer. Later edits invalidate the reviewed checkpoint.

Design or plan blockers stop automatic code revisions. Stop and await active
workers before human editing, retain partial work, and reconcile it after
accepting the revised design. Code review covers retained implementation work.
Human `feedback` can instead clarify a misunderstanding and resume implementation
and code review under the existing accepted design. Actual contract changes use
design review; scope changes use replanning.

Planning uses the top-level conversation. Amendments require human acceptance,
preserve stable todo identities and history, and invalidate explicitly affected
unfinished work. Changes to completed work use corrective todos.

Execution requires Git. Phase checkpoints, findings and approvals survive
restart; workers resume only on explicit commands.

## Diagrams

- [Main path](todo-lifecycle.puml)
- [Return to design](design-revision.puml)
- [Plan amendment](plan-amendment.puml)

Separate design controls: `design`, `design-review`, `design-feedback` and
`design-approve`. Code controls remain `review`, `feedback` and `approve`.
`replan` enters conversational amendment; `plan-approve` accepts a submitted
amendment and `plan-reject` retains the accepted plan.
