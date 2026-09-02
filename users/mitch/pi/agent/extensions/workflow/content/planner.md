# Workflow Planner Guidance

## Logical Increments

Each todo should encapsulate a single increment that:

- Successfully builds, passes tests, and passes linting.
- Contains all relevant documentation for the increment.
- Can be justified in a single git commit message.
- Can easily be reviewed as a stand-alone code diff.

## Implementers In Mind

Treat each todo as being able to be completed by different, isolated workers.
One should not need to read multiple todos to know how to complete any one
given task.

## Refactoring

If work requires the existing codebase to be refactored in some manner, then
aim to perform the refactoring as its own set of todos prior to said work.

