# Next Step Plan

## Purpose

This document turns the next development direction into one concrete milestone.

It should answer:

- what to build next
- why it is the next priority
- what is explicitly in and out of scope
- how to validate completion

## Current State

The product mainline is implemented, but the main risk is now cross-layer correctness drift rather than missing happy-path surface area.

What is already in place:

- `vscode.agent.route` is the natural-language entrypoint
- grounded inspect covers explicit files, selected directories, shallow repository structure, extension wiring, runtime-flow audit, and bounded search-lite
- long-running work uses `analyze`, `plan`, `apply`, `continue`, and `diagnose`
- Codex CLI and Claude Code CLI are implemented background providers
- Claude Code for VS Code handoff exists as an explicit route separate from background task execution
- `apply` uses explicit approval before local structured mutation
- diagnostics distinguish connection, callable state, provider readiness, task state, and runtime health

This is enough for repeatable demos and focused operator testing.

The main remaining risk is not missing surface area.
It is correctness drift at the route, provider-finalization, and task-contract boundary.

## Next Milestone

Milestone name:

- Route, Provider, And Task Contract Hardening

Milestone goal:

- make route selection, Claude provider finalization, plan-mode stability, and task-result semantics more predictable before widening product scope again

## Product Reason

This is the highest-leverage next step because:

- route mistakes and task/result mismatches erode trust faster than narrow feature gaps
- Claude provider runs are implemented but still more compatibility-heavy than the stable task contract wants them to be
- `plan` tasks are more likely than `analyze` tasks to degrade or stall under quiet-provider conditions
- docs are now materially behind code reality in provider coverage and degraded-completion semantics

## Boundary Reminder

This milestone is still a hardening pass on the existing mainline, not a scope expansion.

Keep inside ClawDrive:

- deterministic route selection
- deterministic provider finalization and failure normalization
- deterministic task persistence and result semantics
- operator-facing status consistency
- documentation honesty

Do not expand into:

- broader write surfaces
- new public command families
- multi-root workspace support
- repository-scale autonomous reasoning beyond the grounded inspect ceiling

## Scope

### 1. Route Precision

Tighten route selection so broad read-only analysis stays on `analyze` unless option/tradeoff intent is explicit.

Target behavior:

- provider architecture questions stay in inspect or analyze
- explicit options/tradeoffs prompts route to `plan`
- read-only phrasing alone does not imply `plan`
- diagnose remains the path for status, readiness, connection, and failure-debugging prompts

### 2. Claude Provider Finalization

Make Claude provider runs settle around one stable terminal contract.

Target behavior:

- once a usable terminal semantic payload exists, late/noisy runtime conditions do not discard it
- apply retry paths preserve consistent provider evidence
- plan-mode quiet budgets are explicit and mode-aware
- provider failures still surface clearly when there is no usable result

### 3. Task Result Semantics

Clarify what successful degraded completion means without widening lifecycle states.

Target behavior:

- bounded local fallback may still finish as `completed`
- degraded completion is made explicit via `executionHealth`, `runtimeSignals`, and `providerEvidence`
- callers can distinguish provider success from provider-failed-but-locally-completed results

### 4. Documentation Alignment

Bring command/task docs back to current reality.

Target behavior:

- docs stop claiming Codex is the only implemented provider
- docs distinguish background providers from Claude Code handoff
- docs explain degraded `completed` results honestly
- repo decision logs stay aligned with the hardening work

## Work Packages

Implementation should be split into these work packages:

1. Route classifier hardening

- narrow `plan` detection to explicit option/tradeoff intent
- add regression tests for analyze/plan/diagnose boundary prompts

2. Claude provider hardening

- normalize finalization around usable terminal payloads
- keep apply retry paths but align their evidence shape
- make quiet budgets mode-aware instead of uniformly extended

3. Task semantics hardening

- preserve fallback evidence on degraded completion
- add regression tests for `completed + degraded fallback` semantics

4. Documentation alignment

- update routing docs
- update task semantics docs
- update command-surface docs
- record settled repo-level decisions in `AGENTS.md`

5. Validation

- keep routing/provider/task regression tests green
- keep the full test suite green

## Sequence

Recommended implementation order:

1. classifier hardening
2. Claude provider finalization hardening
3. fallback/result semantics hardening
4. regression tests
5. documentation updates

## Explicitly Not In Scope

Do not expand into these areas in this milestone:

- broader `apply` operation types
- git/test/debug/terminal workflows
- provider feature parity beyond stabilizing the existing Codex and Claude paths
- new repository indexing or language-intelligence features

Also avoid these failure modes:

- overfitting route rules to one prompt wording
- adding new lifecycle states when existing state + health + evidence can express the result clearly
- discarding usable terminal provider payloads because of late noisy runtime conditions
- using hardening work as an excuse to widen command surface

## Acceptance

This milestone is successful when:

- provider-architecture prompts no longer drift into `plan` or `diagnose`
- explicit option/tradeoff prompts route to `plan`
- Claude runs with usable terminal payloads settle consistently despite late stderr/runtime noise
- `plan` tasks have explicit quieter budgets than other modes
- read-only fallback completes as degraded `completed` or degraded `waiting_decision` with clear evidence
- docs no longer claim Codex is the only implemented provider

## Validation Checklist

Automated checks should cover:

- analyze/plan/diagnose route boundary prompts
- Claude apply schema-retry and empty-output retry behavior
- Claude finalization behavior when late stderr appears after a usable payload exists
- degraded fallback semantics in task results
- existing grounded inspect and provider-backed task tests still pass

Operator checks should cover:

- a provider-architecture question reads like normal repository analysis, not diagnosis
- a plan prompt still yields options with a recommended choice
- a degraded fallback result is visibly distinguishable from a clean provider completion
- Claude Code handoff remains separate from background provider semantics

## After This Milestone

After this milestone, the next likely branch is one of:

- broader operator UX cleanup and state visibility
- more grounded inspect refinements at repository scale
- wider apply capability once the task contract is stable enough
