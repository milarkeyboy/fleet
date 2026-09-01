# Bash policy

This extension is a deterministic deny policy for agent-issued `bash` tool
calls. It is a guardrail, not a sandbox: accepted commands execute on the
host with the current user's normal permissions.

## Denied operations

The policy denies selected textual forms of these operation categories:

- privilege escalation
- host and service management
- destructive Git operations
- catastrophic recursive deletion
- host-level package installation

Commands are checked before the `bash` tool executes. The first matching rule
in source order determines the reported category, so the result is stable and
auditable. Leading whitespace and common shell command boundaries are handled;
shell line continuations are normalized before matching.

## Limits

This is text matching, not shell parsing or OS enforcement. The rules recognize
only selected textual forms: for example, `git -C repo push`,
`/usr/bin/git push`, and `command git push` are not matched by the direct
`git push` rule. Obfuscated or indirect execution may also evade the policy.
It does not confine filesystem, network, or process access, and other tools,
interactive user commands, or commands that do not match the rules remain
available. Do not treat a policy allow as approval for an unsafe operation;
review consequential commands.
