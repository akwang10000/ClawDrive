# AGENTS.md

## Purpose

This file records repo-level agent decisions that should remain stable across turns.

Update this file when one of these changes:

- public command surface
- routing rules or task semantics
- plugin/provider boundary
- packaging and release conventions
- any decision that future work should treat as settled unless explicitly revised

Add new entries at the top of the decision log.

## Current Working Agreements

### Product Mainline

- The main user-facing entrypoint is `vscode.agent.route`.
- Long-running lifecycle stays on `vscode.agent.task.*`.
- The normal chain is `OpenClaw -> vscode.agent.route -> inspect/analyze/plan/apply/continue`.

### Plugin vs Provider Boundary

- ClawDrive owns deterministic local inspection, routing, task lifecycle, approval, local mutation, and diagnosis.
- The provider owns broad reasoning, planning, and structured apply proposals.
- The plugin should not become a second full agent runtime.

### Grounded Inspect Scope

- Grounded inspect should prefer fixed local evidence before provider escalation.
- Current grounded inspect coverage includes:
  - explicit file summaries
  - selected directory summaries
  - shallow repository summaries with one-level follow-through
  - bounded internal search-lite for exact token lookup
  - extension-wiring audit
  - runtime-flow audit for the `route -> task -> provider` chain
- Search-lite is internal only and must not become a new public command surface.

### Task Model

- Stable task modes are `analyze`, `plan`, and `apply`.
- Current apply is intentionally narrow:
  - explicit approval required
  - provider proposes structure, but does not write files directly
  - local executor performs only controlled structured mutations
- Unsupported write surfaces remain out of scope for now:
  - delete
  - rename
  - git
  - terminal
  - debug
  - formatter

### Packaging

- Extension version is now `0.1.13`.
- When bumping the release version, keep `package.json` and `package-lock.json` aligned.
- Package with `npx @vscode/vsce package`.
- Install locally with VS Code CLI from `...\\Microsoft VS Code\\bin\\code.cmd`, not `Code.exe`.
- Keep release packages slim through `.vscodeignore`; do not ship `src/`, `test/`, `out-test/`, `docs/`, or local repo-only files by default.

### Activation Policy

- Current activation policy is `onStartupFinished` only.
- Do not keep duplicate `onCommand:*` or `onView:*` activation entries unless startup activation is explicitly removed again.
- Startup should stay light enough that early activation is acceptable; connection remains a separate concern.

## Decision Log

### 2026-03-26

- Extended task snapshots/results with provider evidence for diagnosis:
  - keep `sawTurnStarted`, `sawTurnCompleted`, `outputFileStatus`, `finalMessageSource`, `lastAgentMessagePreview`, and a bounded `stdoutEventTail`
  - use this evidence to diagnose complex prompt hangs without adding new public commands
- Diagnostics now surface "turn.started but no output" stalls even without runtime signals, so `clean + running` no longer hides stuck tasks.
- Added provider stall handling for long-running tasks:
  - if a task reaches `turn.started` and then stays silent for too long, emit a degraded runtime signal before failing with `PROVIDER_RESULT_STALLED`
  - if a final `agent_message` is already captured after `turn.completed`, allow provider-side early finalization instead of waiting for the child process to linger until task timeout
- Added internal operator command `clawdrive.selftest` to run local self-tests without going through the Gateway surface.
- Running-task health must reflect provider stall warnings; avoid leaving obviously stuck tasks in `clean + running`.
- Hardened Codex provider finalization:
  - prefer schema/output-file payloads when present
  - fall back to the last streamed `agent_message` when the output file is empty or missing
  - accept embedded JSON inside prose/fenced replies as a bounded parse fallback
- Added provider-side finalization stall protection:
  - if Codex emits `turn.completed` but no final result arrives within the provider grace window, fail with `PROVIDER_FINALIZATION_STALLED`
  - treat this as a provider finalization problem, not a generic long-running task
- Kept task state machine unchanged; this milestone improves provider result capture and failure explanation without adding new public commands.
- Promoted grounded inspect beyond explicit files:
  - shallow repository summaries
  - bounded code-location lookup
  - runtime-flow audit
- Kept all of the above inside the existing `vscode.agent.route` surface instead of adding new public commands.
- Reaffirmed that broad or ambiguous repository understanding still escalates to provider-backed `analyze`.
- Standardized local packaging version to `0.1.13`.
- Added `.vscodeignore` so local VSIX packages ship runtime assets only instead of source, tests, and repo-only docs.
- Defaulted `clawdrive.autoConnect` to `false` for new installs.
- Moved provider readiness probing off the synchronous startup path; startup now restores task state first and refreshes provider status in the background.
- Simplified activation policy to `onStartupFinished` only so startup and fallback activation paths no longer overlap.

## Next Entry Template

Use this format for future entries:

```md
### YYYY-MM-DD

- Decision:
- Why:
- Impact:
```
