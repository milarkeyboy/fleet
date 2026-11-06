---
name: commit-message
description: Write or revise Git commit messages. Load when drafting commit messages, committing changes, or rewording commit history.
---

# Git commit messages

Inspect the full diff before writing. Keep each commit focused on one purpose;
suggest splitting independently useful changes into separate commits.

## Format

Follow Chris Beam's recommendations:

- Use a capitalised, imperative subject of at most 50 characters.
- Omit the subject's trailing full stop.
- Separate the subject and body with a blank line.
- Wrap the body at 72 characters and separate paragraphs with blank lines.

## Subject Line

### Micro-X Work

When working on a Micro-X Jira issue, prefix the subject line with the Jira work
item number in square brackets:

```
[ABC-123] Fix crashes during login
```

Do not include this prefix in the subject line's character limit.

## Body

### Features

For commits that add new functionality, give a short summary of why the change
is needed and what value it's bringing.

### Fixes, Refactors, Clean-ups

For fixes, refactors, and clean-ups explain the change in this order:

1. Describe the problem and its impact in past tense. Lead with what
   users/operators/developers experienced when viewing the system as a black
   box.
2. Explain the underlying cause in past tense. Include enough technical detail
   to connect the cause to the impact. Lead into this explanation with a joining
   phrase like "This was caused by ..." or "Such failures were the result of..."
   or similar.
3. Describe the fix, resulting behaviour, and benefits in present tense. Lead
   into this description with a joining phrase like "To address this, the job
   now reads the password through standard input..." or similar.

Keep the explanation proportional to the change. Separating into paragraphs is
not a requirement; if all of those points fit neatly into one paragraph, do so.

Explain why it was worth making; avoid narrating the diff or listing unrelated
improvements.

### Justification

Where possible, refer to evidence that supports the existence of the defect and
its impact. Distinguish observed impact from possible consequences: an error
message alone does not establish functional failure or lost performance. State
any limits of the evidence.

In the absence of evidence, refer to best practices, known paradigms, and
design principles as justification.
