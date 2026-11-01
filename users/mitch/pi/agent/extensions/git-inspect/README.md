# Git inspection

`git_inspect` provides local Git reads for agents with restricted tools. Pi
loads the extension through normal discovery; the shared subagent runner loads
it explicitly when an agent profile lists `git_inspect`.

## Parameters

- `operation`: `status`, `diff`, `log`, `show` or `blame`.
- `revisions`: up to two revisions for `diff`; up to one revision or range for
  `log`, `show` or `blame`. `status` accepts none. Git determines which revision
  forms apply to each operation.
- `paths`: literal paths relative to the working directory. `blame` requires
  exactly one.
- `staged`: compare the index for `diff`; accepts at most one revision.
- `limit`: log entry count, from 1 to 200; defaults to 20.

Examples:

```json
{"operation":"diff","staged":true}
{"operation":"log","paths":["src/parser.ts"],"limit":10}
{"operation":"show","revisions":["HEAD~1:src/parser.ts"]}
{"operation":"blame","revisions":["HEAD"],"paths":["src/parser.ts"]}
```

Without revisions, `diff` compares the worktree with the index, `show` displays
HEAD and `blame` includes worktree changes. Untracked files appear in `status`;
use `read` for their contents.

## Guardrails

Commands run directly with a fixed argument set and structured inputs. Revision
inputs reject option prefixes. Paths use literal pathspecs after `--`.
Pagers, external diffs, text conversion, fsmonitor, clean/process filters,
submodule inspection, replacement objects, lazy fetching and optional index
writes are disabled. Filters are overridden from the effective Git
configuration, so comparisons use content without custom filter conversion.
Inherited command-line configuration in `GIT_CONFIG_PARAMETERS` is ignored.
The working directory comes from the Pi session.

Each Git process has a 30-second timeout and a 64 MiB output capture limit.
Cancellation terminates the process. Output exceeding 2000 lines or 50 KiB is
saved to a private temporary file, with its path returned for `read`.

The extension runs with the user's host permissions. Tool restrictions provide
guardrails; operating-system isolation supplies stronger enforcement, including
protection against concurrent repository configuration changes.

Run `npm test` in this directory. Tests use disposable repositories and the
installed Pi SDK, with model network access disabled.
