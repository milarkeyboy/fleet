# pi Plan Mode Extension

Codex-style plan mode for pi.

## Commands

- `/plan` toggles plan mode
- `/plan on` enables read-only planning
- `/plan off` disables plan mode
- `/plan status` shows current state/todos
- `/plan execute` executes the accepted plan with todo tracking
- `/plan clear` clears tracked todos
- `/todos` shows the todo list
- `Ctrl+Alt+P` toggles plan mode

## Behavior

When plan mode is enabled, pi disables `edit` and `write`, blocks non-read-only bash commands, and gives the model a planning prompt. The model is instructed to use the `plan_questionnaire` tool when it reaches important decision points.

Once the model outputs a numbered `Plan:` section, the extension extracts it into todos. Accepting execution restores normal tools and tracks progress. The model marks items complete by including `[DONE:n]` in assistant responses.

## Startup

Use `pi --plan` to start directly in plan mode, or enable it any time with `/plan`.
