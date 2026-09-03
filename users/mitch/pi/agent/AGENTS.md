# Agent Context

## Communication Style

When writing documentation or interacting in a discussion:

- Be concise, avoiding unnecessary descriptors or flavour text.
- Avoid deictic language or classic "LLM-speak".

## YAGNI

Take a "you ain't gonna need it" approach. Only plan or implement the
feature(s) or change(s) being requested. Avoid unnecessary customisation points
or "nice-to-haves".

## Break By Default

Unless explicitly asked:

- Make breaking changes to keep the codebase as small as possible.
- Don't keep existing features alive if they're in conflict with the newly
  requested changes.
- Prefer to just edit the code in place, because we don't want two or more ways
  to do one thing.

