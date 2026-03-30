# Development Rules

## Purpose

This document records the working rules for building `ClawDrive for VS Code`.

It is not a product spec.
It exists to keep implementation, verification, and documentation aligned as the new repository grows.

## Working Principles

1. Make the smallest safe change that fully resolves the task.
2. Keep implementation, tests, and documentation aligned in the same work pass when practical.
3. Prefer stable, reusable helpers for security-sensitive logic.
4. Do not let transport progress masquerade as product completion.
5. Record new repeated engineering rules here instead of relying on chat history.

## Product-Aware Delivery Rule

Every meaningful implementation step should be checked against the actual product goal:

- OpenClaw natural language
- routed through ClawDrive
- into VS Code-native agent workflows
- with readable progress and results back

If a change only improves protocol coverage but does not improve that chain, treat it as secondary.

## Clean-Room Rule

This repository is a clean-room rewrite.

Allowed:

- using the old repository for behavior analysis
- preserving requirements, acceptance criteria, and protocol observations
- re-expressing design conclusions in new wording

Not allowed:

- copying source files
- copying tests line-for-line
- copying README, design, or product text verbatim
- translating old implementation structure directly into the new repository

## Verification Rule

Before considering a task complete:

1. run the smallest relevant verification step
2. confirm the edited files still match the documented behavior
3. note any testing gaps explicitly if full verification was not possible

Typical verification examples:

- `npm run compile`
- `npm test` so runtime `out/` and test output stay in sync
- targeted tests once they exist
- extension host launch for bootstrap and UX checks

## Documentation Rule

Update docs when any of these change:

- user-facing workflow
- task semantics
- provider behavior
- security constraints
- setup or diagnosis flow

Do not leave behavior changes documented only in commit messages or chat.

## Security Rule

For security-sensitive areas:

- prefer one shared rule path over duplicated checks
- keep workspace containment consistent for both `path` and `cwd`
- keep mutation policy consistent across direct commands and task execution
- avoid shell concatenation for provider or terminal execution

## Operator Experience Rule

Operator usability is part of the product bar.

When adding a new subsystem, also ask:

- how an operator knows it is connected
- how an operator knows it is callable
- how an operator knows the provider is ready
- how failures will be diagnosed without reading source code

## Completion Rule

Before stopping after a completed task:

1. review the changed files
2. run relevant verification
3. make sure the runnable `out/` build is refreshed before handing off or packaging
4. update docs if behavior or workflow changed
5. prepare the repository for commit and push

If push is blocked by authentication, permissions, or network state, record the blocker clearly.
