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

### Writing Code

### Comments and Documentation

- Add comments to explain blocks of code at a high level. Do not simply
  re-state what the code does, aim to focus instead on the "why".
- Prefer comment blocks preceding the code being described over trailing
  comments.
- Avoid restating parts of your instructions or context as if future readers of
  the code, readme, whatever have that conversation at hand. Write prose so
  that someone reading it for the first time without that context will
  understand.
- Don't encode code history in comments. Don't refer to the historical state of
  the code. Only describe what the code currently does and why.
- Refrain from rewording existing comments if they still apply to the new
  changes being made. Only change them if they no longer made sense or didn't
  makse sense to begin with. If a comment can be corrected by simply replacing
  a few words, then do that instead of rewriting the whole thing.

### Writing Tests

Avoid re-implementing the code under test in the test cases. Tests should aim
to be as simple as possible for auditing by inspection. The format of "provide
input, and assert output matches expected output" is the simplest example of
this. Don't "provide input, recalculate expected output using a duplicate
algorithm". Literals (numeric, string) are okay, don't be scared of "magic
numbers".

In satisfying this ethos, it is okay to violate the DRY principle and accept
some duplication between test cases. Simplicity is king.

