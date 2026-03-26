# Next Step Plan

## Purpose

This document turns the next development direction into one concrete milestone.

It should answer:

- what to build next
- why it is the next priority
- what is explicitly in and out of scope
- how to validate completion

## Current State

The current mainline is working in this shape:

- `vscode.agent.route` is the natural-language entrypoint
- grounded inspect covers explicit files, selected directories, and extension-wiring checks
- long-running work uses `analyze`, `plan`, `apply`, `continue`, and `diagnose`
- `apply` uses explicit approval before local structured mutation
- diagnostics distinguish connection, callable state, provider readiness, task state, and runtime health

This is enough for repeatable demos and focused operator testing.

It is not yet enough for strong repository-scale understanding without careful prompting.

## Next Milestone

Milestone name:

- Grounded Repository Inspect Expansion

Milestone goal:

- make repository-understanding prompts rely less on provider shell probing and more on deterministic local inspection before escalating to `analyze`

## Product Reason

This is the highest-leverage next step because:

- it strengthens the most reliable part of the current product
- it directly addresses the earlier "answers are directionally right but not grounded enough" problem
- it reduces unnecessary provider friction for common audit and explanation requests
- it improves both user experience and debugging confidence

## Boundary Reminder

This milestone is intentionally a plugin-layer expansion, not a provider replacement.

What should move into ClawDrive:

- deterministic local evidence gathering
- bounded shallow inspection
- route decisions about when local grounding is enough

What should stay in the provider:

- broad reasoning
- synthesis across ambiguous evidence
- planning and proposal generation
- open-ended repository understanding after local grounding is exhausted

The goal is to make the provider start from better evidence, not to make the plugin impersonate the provider.

## Scope

### 1. Directory Follow-Through

Add one more shallow layer after the current directory summary.

Target behavior:

- a directory summary can nominate one or two relevant child directories
- the router can inspect one more level before escalating to provider analysis
- this remains deterministic and bounded, not an open-ended crawl

Examples:

- "Look at `src` and explain the main modules."
- "Summarize the repository structure."

### 2. Grounded Repository Audit Templates

Add deterministic inspect paths for high-frequency repository questions.

Target prompts:

- summarize project layout
- explain the main runtime entry flow
- compare declared surface versus implementation hints
- explain how route, task service, and provider fit together

Behavior rule:

- prefer local reads and shallow directory inspection first
- escalate to `analyze` only when the request still needs iterative reasoning

### 3. Conservative Search-Lite Support

Add a narrow local helper to support grounded inspect.

Allowed scope:

- likely file lookup by name
- exact text lookup for known tokens such as command ids, entrypoints, or exported symbols

Not allowed scope:

- unrestricted shell search
- arbitrary regex exploration as a public behavior

Contract rule:

- this remains an internal route-time helper only
- it does not introduce a new public command surface
- it does not change the product non-goal against general-purpose text or file search commands

### 4. Route Escalation Tightening

Refine route rules so the system is clearer about when local grounding is enough.

Target behavior:

- explicit file and directory requests stay local
- shallow repository audit requests start local
- provider-backed `analyze` starts only after local evidence is insufficient or the question is clearly broader than local summarization

## Work Packages

Implementation should be split into these work packages:

1. Classifier and routing expansion

- add new deterministic patterns for repository-layout and entry-flow prompts
- keep route behavior explainable and testable

2. Grounded inspect helpers

- add shallow repository-summary helpers
- add search-lite helpers used only by grounded inspect

3. Response shaping

- keep responses short and human-readable
- make it obvious when the answer is grounded in local files versus escalated analysis

4. Documentation and validation

- update routing docs
- update natural-language calling docs
- update validation goals when new grounded-inspect coverage is real

## Sequence

Recommended implementation order:

1. search-lite helper
2. shallow repository-summary helper
3. route classification and escalation rules
4. response shaping
5. tests
6. documentation updates

## Explicitly Not In Scope

Do not expand into these areas in this milestone:

- new public command families
- git/test/debug/terminal workflows
- broader `apply` operation types
- multi-root workspace support
- provider parity beyond Codex
- full repository indexing
- broad language-intelligence surfaces such as references or symbol graphs

Also avoid these failure modes:

- turning search-lite into an unrestricted search surface
- recursively inspecting the whole repository by default
- moving provider-style reasoning rules into the plugin
- adding route branches that are too heuristic to debug predictably
- letting internal search-lite semantics become an implied public feature contract

## Acceptance

This milestone is successful when:

- prompts like "summarize this repository structure" can return a more grounded answer than a generic checklist
- prompts like "look at src and explain the main modules" prefer local inspection before provider analysis
- prompts like "where is `vscode.agent.route` wired up" can find likely files through bounded local search support
- route decisions remain predictable and debuggable
- the response still stays short and human-readable

## Validation Checklist

Automated checks should cover:

- direct routed summaries still work for explicit file prompts
- directory summaries can inspect one more relevant level without becoming broad scans
- search-lite can find likely files by exact token or filename
- provider-backed `analyze` still works when local grounding is not enough
- route classification prefers grounded inspect for shallow repository audit prompts

Operator checks should cover:

- OpenClaw can ask for repository structure in ordinary language
- the returned answer is based on local evidence first
- failure mode remains understandable when grounded inspect is insufficient and provider analysis takes over

## After This Milestone

After this milestone, the next likely branch is one of:

- richer repository-aware inspect and explanation
- broader operator UX cleanup such as dashboard simplification and clearer state refresh
- wider apply capability after the inspect foundation is strong enough
