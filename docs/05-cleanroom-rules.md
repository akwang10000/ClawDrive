# Clean-Room Rules

## Purpose

These rules define what can be carried into the new repository and what must be re-created.

Reference repository for behavior and requirement extraction only:

- `https://github.com/akwang10000/openclaw-vscode.git`

## Allowed Inputs

You may carry forward:

- product goals
- observed protocol behavior
- command inventories
- bug reports and failure modes
- acceptance criteria
- implementation priorities
- your own newly written specifications in this directory

## Disallowed Carry-Forward

Do not copy into the new repository:

- source files from the reference repository
- partial source snippets from the reference repository
- tests translated line-for-line from the reference repository
- existing README, design, execution-rules, or changelog wording
- icons, screenshots, GIFs, or package metadata from the reference repository

## Safe Way To Reuse Knowledge

Use this pattern:

1. observe current behavior
2. restate it as a neutral requirement
3. implement a new solution from scratch
4. write fresh tests against the new implementation

## Examples

Allowed:

- "task timeout must not be reported as cancellation"
- "resume-path CLI arguments must be assembled compatibly"
- "activity text should use deterministic lifecycle templates"

Not allowed:

- copying the old task provider file and only renaming variables
- copying old tests and changing import paths
- copying old command descriptions into the new README

## Review Rule

Before importing any text or code into the new repository, ask:

- is this an abstract requirement or a concrete old expression?
- can the same idea be rewritten from first principles?
- would this still exist if the old repository vanished?

If the answer depends on the old expression, rewrite it.
