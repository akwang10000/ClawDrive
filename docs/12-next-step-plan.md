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

Status note: this milestone is now completed through the route/provider/task contract hardening plan in `docs/superpowers/plans/2026-04-30-route-provider-task-contract-hardening.md`. The next recommended milestone is broader operator UX cleanup and state visibility, while keeping the stabilized task contract unchanged.

What is already in place:

- `vscode.agent.route` is the natural-language entrypoint
- grounded inspect covers explicit files, selected directories, shallow repository structure, extension wiring, runtime-flow audit, and bounded search-lite
- long-running work uses `analyze`, `plan`, `apply`, `continue`, and `diagnose`
- Codex CLI and Claude Code CLI are implemented background providers
- Claude Code for VS Code handoff exists as an explicit route separate from background task execution
- `apply` uses explicit approval before local structured mutation
- diagnostics distinguish connection, callable state, provider readiness, task state, and runtime health

This is enough for repeatable demos and focused operator testing.

The main remaining risk is now operator clarity: users and maintainers need better visibility into task state, degraded results, handoff boundaries, and recovery options without reading raw lifecycle payloads.

## Next Milestone

Milestone name:

- Operator UX And State Visibility

Milestone goal:

- make task state, provider health, degraded fallback, and recovery paths easier to understand from the existing command and activity surfaces without changing the stabilized task contract

## Product Reason

This is the highest-leverage next step because:

- the route/provider/task contract is now more stable, so the next trust gap is how clearly that contract is surfaced to operators
- degraded-but-useful results need to be visibly distinguishable from clean provider completions
- handoff, diagnose, continue, decision, approval, and cancellation paths should be easy to understand without inspecting raw JSON
- better state visibility improves focused testing before expanding write surfaces or new command families

## Boundary Reminder

This milestone is a UX and observability pass on the existing mainline, not a task-contract redesign.

Keep inside ClawDrive:

- clearer task and provider status presentation
- clearer degraded-result and fallback messaging
- clearer recovery actions for waiting, interrupted, failed, and degraded tasks
- documentation and operator guidance that match implemented behavior

Do not expand into:

- broader write surfaces
- new public command families
- multi-root workspace support
- repository-scale autonomous reasoning beyond the grounded inspect ceiling
- new provider lifecycle states when existing state, health, signals, and evidence are sufficient

## Scope

### 1. Task State Visibility

Improve how current task lifecycle and execution health are presented to operators.

Target behavior:

- users can tell whether a task is running, waiting, completed, degraded, failed, cancelled, or interrupted
- degraded completion is summarized as useful-but-fallback-backed rather than as a silent success
- provider evidence remains diagnostic context and does not leak into normal output unless it helps explain degraded behavior

### 2. Recovery And Continuation UX

Make next actions obvious for resumable or recoverable tasks.

Target behavior:

- waiting decision and waiting approval states show the expected user action
- interrupted and failed states show whether continue, diagnose, or restart is the safer next step
- cancellation and recovery messages stay plain-language and task-oriented

### 3. Provider And Handoff Clarity

Keep background provider execution and Claude VS Code handoff visually and textually distinct.

Target behavior:

- provider readiness and runtime-health diagnostics are easy to find
- handoff commands are presented as handoff-only, not background provider execution
- diagnose output distinguishes connection, readiness, task state, and runtime signals

### 4. Documentation Alignment

Keep operator docs aligned with the current UX contract.

Target behavior:

- docs explain how to interpret task health and degraded fallback
- docs explain when to continue, diagnose, cancel, or start a new task
- docs continue to avoid implying unsupported write or provider capabilities

## Work Packages

Implementation should be split into these work packages:

1. Task state presentation review

- audit current activity view, command responses, and result summaries for unclear state or health wording
- identify the smallest wording or presentation changes that improve operator understanding

2. Recovery action clarity

- review waiting, interrupted, failed, cancelled, and degraded task flows
- make recommended next actions consistent across route responses and task result surfaces

3. Provider and handoff visibility

- verify diagnose and handoff messaging reflect the stabilized provider contract
- keep Claude VS Code handoff separate from background task-provider status

4. Documentation alignment

- update operator-facing docs affected by UX wording changes
- keep command-surface, routing, and task-semantics docs consistent with implemented behavior

5. Validation

- run focused tests for any changed task/status behavior
- run lightweight docs and packaging checks for docs-only changes

## Sequence

Recommended implementation order:

1. audit current operator-facing task/status output
2. tighten wording and presentation for task health and recovery actions
3. verify provider diagnose and handoff clarity
4. update docs to match any wording changes
5. run focused validation

## Explicitly Not In Scope

Do not expand into these areas in this milestone:

- broader `apply` operation types
- git/test/debug/terminal workflows
- new provider feature parity work
- new repository indexing or language-intelligence features
- new lifecycle states or task result schema changes unless a concrete operator-blocking issue requires them

Also avoid these failure modes:

- hiding degraded fallback behind generic success wording
- exposing raw provider evidence where plain-language summaries are enough
- treating Claude VS Code handoff as a background task provider
- using UX cleanup as an excuse to widen command surface

## Acceptance

This milestone is successful when:

- task lists, status responses, and result summaries make lifecycle and execution health easy to distinguish
- degraded fallback results are visibly different from clean provider completions
- waiting, interrupted, failed, cancelled, and degraded tasks present clear next actions
- provider readiness/runtime health and Claude VS Code handoff are described consistently
- docs remain aligned with the implemented command and task behavior

## Validation Checklist

Automated checks should cover:

- focused tests for any changed task/status behavior
- existing grounded inspect and provider-backed task tests for unchanged contract behavior
- docs/package checks for documentation-only changes

Operator checks should cover:

- a clean provider completion reads as a normal completed task
- a degraded fallback result explains that bounded local fallback produced the useful result
- a waiting task clearly asks for a decision or approval
- a failed or interrupted task points to diagnose, continue, or restart as appropriate
- Claude Code handoff remains visibly separate from background provider execution

## After This Milestone

After this milestone, the next likely branch is one of:

- more grounded inspect refinements at repository scale
- wider apply capability once the operator surfaces and task contract are stable enough
- targeted provider compatibility improvements based on observed operator friction
