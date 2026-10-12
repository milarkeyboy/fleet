# Workflow Planner Guidance

## Logical Increments

Each todo should encapsulate a single increment that:

- Successfully builds, passes tests, and passes linting.
- Can be justified in a single git commit message.
- Can easily be reviewed as a stand-alone code diff.

## Refactoring

If work requires the existing codebase to be refactored in some manner, then
aim to perform the refactoring as its own set of todos prior to said work.

