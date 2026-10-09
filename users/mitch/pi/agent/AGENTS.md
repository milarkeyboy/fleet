# Agent Context

## Communication Style

When writing documentation or interacting in a discussion:

- Use British English.
- Be concise, avoiding unnecessary descriptors or flavour text.
- Avoid deictic language.
- Don't describe something by stating what it isn't; avoid statements like "X
  is not a Y", and prefer "X is a Z because..."

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
  to do one thing. Exceptions apply to comments (see below).

### Writing Code

### Comments and Documentation

- Add comments to explain blocks of code at a high level. Don't describe each
  individual operation within a block, but rather what their sum achieves and
  (most importantly) why it's being done.

  Instead of this:
  ```python
  # Loop over the archive paths and check each one is safe to copy.
  for argument, source, destination in copied_archive_paths():
      if not file_io.is_copy_safe(source, destination):
          parser.error(
              f"{argument} cannot be safely copied to --output"
          )
  ```

  Aim for this:
  ```python
  # Validate the config archive destination early, before reconstruction begins.
  # This is done here to catch input errors early rather than later in the processing.
  for argument, source, destination in copied_archive_paths():
  ```

- Prefer comment blocks preceding the code being described over trailing
  comments.
- Avoid restating parts of your instructions or context as if future readers of
  the code, readme, whatever have that conversation at hand. Write prose so
  that someone reading it for the first time without that context will
  understand.
- Don't encode code history in comments, only describe the current state of
  the code.
- Refrain from rewording existing comments if they still apply to the new
  changes being made. Only change them if they no longer made sense or didn't
  makes sense to begin with. If a comment can be corrected by simply replacing
  a few words, then do that instead of rewriting the whole thing.

### Writing Tests

Avoid re-implementing the code under test within the test cases. Tests should
aim to be as simple as possible for auditing by inspection. The format of
"provide input, and assert output matches expected output" is the simplest
example of this. Don't "provide input, recalculate expected output using a
duplicate algorithm". Literals (numeric, string) are okay, don't be scared of
"magic numbers".

In satisfying this ethos, it is okay to violate the DRY principle and accept
some duplication between test cases. Simplicity is king.

For each test case, describe what it is the test is verifying in a
comment/docstring/description (language dependent). Don't state what steps the
test takes, but rather what behaviour is being verified.

Test cases should have a single purpose. Don't add tests for new behaviour by
piggy-backing a previously written test case if that new behaviour is not
covered under the purpose of said test.

Test fixtures or suites should also have comments and/or documentation that
describe their scope e.g. what parts of the code are covered by the test cases
in the fixture.

Aim to name and describe the module/fixture/suite containing the test cases as
generic, even if the test cases contained within are only testing one part of
the behaviour. That way, other test cases that exercise the same unit under test
can be added later without invalidating scope of the containing
module/fixture/suite.

Unless explicitly asked, don't add tests for things that aren't supported. Even
in cases where you've taken functionality out or made a breaking change, there's
no need to test that the old way is no longer supported.
