# Workflow Planner Guidance

## Logical Increments

Each todo should encapsulate a single increment that:

- Successfully builds, passes tests, and passes linting.
- Contains all relevant documentation for the increment. This means that any
  information sourced from locations external to the workspace (e.g. Jira
  issues, web pages, etc) should be summarised in the instruction for the
  worker.
- Can be justified in a single git commit message.
- Can easily be reviewed as a stand-alone code diff.

## Refactoring

If work requires the existing codebase to be refactored in some manner, then
aim to perform the refactoring as its own set of todos prior to said work.

