---
name: python
description: Implementing Python code.
---

# Python Development

## Module Preferences

- Prefer `pathlib` over `os` for filesystem manipulation.
- Use the built-in unittest to enable patching and mocking where needed.

## Typing

- Using type annotations where possible.
- Newly written code shall pass pyright type checks.
- Rely on callers of functions providing correct types when they're annotated.
  Don't waste energy on checking the types of values in case a caller has
  ignored the annotations.
- Don't consider passing invalid types in writing unit tests. If a caller
  ignores the type hints, then it can simply be left as undefined behaviour.
  Focus instead on invalid values within those type boundaries.
