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

## Break By Default

Unless explicitly asked, make breaking changes to keep the codebase as small as
possible. Don't keep existing features alive if they're in conflict with the
newly requested changes.

## YAGNI

Take a "you ain't gonna need it" approach. Only plan for the feature(s) or
change(s) being requested. Avoid unnecessary customisation points or
"nice-to-haves".
