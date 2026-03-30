# Next Step Plan

## Purpose

This document turns the next development direction into one concrete milestone.

It should answer:

- what to build next
- why it is the next priority
- what is explicitly in and out of scope
- how to validate completion

## Current State

The previous milestone, grounded repository inspect expansion, is now effectively implemented:

- `vscode.agent.route` is the natural-language entrypoint
- grounded inspect covers explicit files, selected directories, shallow repository structure, extension wiring, runtime-flow audit, and bounded search-lite
- long-running work uses `analyze`, `plan`, `apply`, `continue`, and `diagnose`
- `apply` uses explicit approval before local structured mutation
- diagnostics distinguish connection, callable state, provider readiness, task state, and runtime health

This is enough for repeatable demos and focused operator testing.

The main remaining risk is not missing surface area.
It is correctness drift at the route and task-contract boundary.

## Next Milestone

Milestone name:

- Routing And Task Contract Hardening

Milestone goal:

- make route selection and task lifecycle behavior more predictable for real operator use before widening product scope again

## Product Reason

This is the highest-leverage next step because:

- the current product bar is now limited more by edge-case correctness than by missing happy-path capability
- route mistakes and task-state mismatches erode trust faster than narrow feature gaps
- this keeps the grounded inspect slice reliable before any broader apply or provider expansion
- it gives operators a cleaner contract for cancellation, recovery, and diagnosis

## Boundary Reminder

This milestone is still a hardening pass on the existing mainline, not a scope expansion.

Keep inside ClawDrive:

- deterministic route selection
- deterministic task persistence and recovery semantics
- operator-facing status consistency

Do not expand into:

- broader write surfaces
- new public command families
- provider parity work
- repository-scale autonomous reasoning beyond the grounded inspect ceiling

## Scope

### 1. Diagnose Route Precision

Tighten diagnose routing so it only matches explicit debugging intent.

Target behavior:

- provider architecture questions should stay in inspect or analyze
- generic mentions of `provider` should not force a diagnose route
- diagnose remains the path for status, readiness, connection, and failure-debugging prompts

### 2. Active Cancellation Settlement

Make task cancellation return a settled task snapshot instead of a stale in-flight snapshot.

Target behavior:

- cancelling a running task should return after the post-abort state is visible
- the common result should be `cancelled`
- command callers should not see `running` after a successful cancel request

### 3. Interrupted Task Retention

Keep interrupted tasks resumable even when terminal history is pruned.

Target behavior:

- `interrupted` remains a recovery state, not terminal history
- history pruning should apply to completed/failed/cancelled tasks
- restart recovery should not create resumable tasks that are then immediately pruned away

### 4. Grounded Inspect Refinement

Continue small precision fixes around the grounded inspect mainline.

Target behavior:

- route rules stay explainable
- grounded inspect keeps winning the shallow cases it already owns
- fixes should prefer bounded local evidence over broader provider escalation

## Work Packages

Implementation should be split into these work packages:

1. Route classifier hardening

- remove broad false-positive diagnose matches
- add regression tests for architecture-style prompts

2. Task service consistency

- wait for active cancel settlement
- keep resumable interrupted tasks out of terminal-history pruning

3. Documentation alignment

- update routing docs
- update task semantics docs
- record settled repo-level decisions in `AGENTS.md`

4. Validation

- add automated checks for route precision, cancel settlement, and interrupted retention
- keep the full test suite green

## Sequence

Recommended implementation order:

1. classifier hardening
2. task cancellation settlement
3. interrupted retention change
4. regression tests
5. documentation updates

## Explicitly Not In Scope

Do not expand into these areas in this milestone:

- broader `apply` operation types
- git/test/debug/terminal workflows
- multi-root workspace support
- provider parity beyond Codex
- new repository indexing or language-intelligence features

Also avoid these failure modes:

- overfitting route rules to one prompt wording
- treating resumable states as disposable terminal history
- returning command snapshots before lifecycle transitions actually settle
- using hardening work as an excuse to widen command surface

## Acceptance

This milestone is successful when:

- prompts like "Explain the provider contract in this repo" no longer route to diagnose
- cancelling a running task returns a settled snapshot instead of `running`
- interrupted tasks remain available for `continue` even when terminal history is pruned
- route and task behavior remain predictable and debuggable

## Validation Checklist

Automated checks should cover:

- generic provider-architecture prompts route to analyze instead of diagnose
- active cancellation returns a `cancelled` snapshot
- interrupted task snapshots survive pruning while terminal history is trimmed
- existing grounded inspect and provider-backed task tests still pass

Operator checks should cover:

- a cancelled task reads as cancelled immediately in normal command results
- restart recovery still leaves interrupted tasks resumable
- diagnosis remains focused on status and failure debugging rather than stealing normal architecture questions

## After This Milestone

After this milestone, the next likely branch is one of:

- broader operator UX cleanup and state visibility
- more grounded inspect refinements at repository scale
- wider apply capability once the task contract is stable enough
