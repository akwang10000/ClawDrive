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

### Communication Language

- Agents may reason internally in English, but all user-facing questions and answers must be in Chinese.

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
- Canonical internal task modes stay `analyze`, `plan`, and `apply`; command-level compatibility aliases may map external `ask`-style requests onto those modes.
- `interrupted` remains a resumable recovery state and should not be pruned as terminal history.
- Active cancel requests should return a settled post-abort snapshot rather than a stale `running` snapshot.
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

- When bumping the release version, keep `package.json` and `package-lock.json` aligned.
- Package with `npx @vscode/vsce package`.
- Install locally with VS Code CLI from `...\\Microsoft VS Code\\bin\\code.cmd`, not `Code.exe`.
- Keep release packages slim through `.vscodeignore`; do not ship `src/`, `test/`, `out-test/`, `docs/`, or local repo-only files by default.
- Every `npx @vscode/vsce package` build must bump the extension version first.
- Test, selftest, and package entrypoints should rebuild runtime `out/` first so the runnable extension does not lag behind `src/`.

### Activation Policy

- Current activation policy is `onStartupFinished` only.
- Do not keep duplicate `onCommand:*` or `onView:*` activation entries unless startup activation is explicitly removed again.
- Startup should stay light enough that early activation is acceptable; connection remains a separate concern.

## Decision Log

### 2026-04-04

- Decision: Route classification now keeps broad read-only analysis prompts on `analyze` unless option or tradeoff intent is explicit.
- Why: Phrases such as "best next step" or generic read-only investigation wording were still drifting into `plan`, which made route behavior feel wording-sensitive instead of intent-stable.
- Impact: `plan` now requires clearer option/tradeoff language, while architecture/debugging analysis stays on the normal repository-understanding path.

### 2026-04-04

- Decision: `ClaudeCliProvider` quiet-budget extension is now mode-aware, and only `plan` runs receive the long quiet budget.
- Why: Complex planning turns can stay semantically quiet much longer than `analyze` or `apply`, while extending all modes equally made non-plan Claude failures take too long to surface.
- Impact: `plan` keeps extra room for long reasoning turns, but `analyze` and `apply` fail faster on true silent stalls.

### 2026-04-04

- Decision: `ClaudeCliProvider` now prefers a usable captured terminal payload over late fatal trailing runtime stderr on process close.
- Why: Some Claude runs can produce a valid final semantic result and then emit noisy trailing stderr that would otherwise be treated like a terminal runtime failure.
- Impact: Claude tasks settle more consistently once a valid terminal payload exists, while real no-result fatal failures still fail normally.

### 2026-04-04

- Decision: Read-only fallback completions now preserve explicit provider evidence so degraded completion remains distinguishable from clean provider success.
- Why: The task contract intentionally allows bounded local fallback to finish a task, but operators still need enough evidence to tell "provider succeeded" from "provider failed and local fallback completed the work."
- Impact: `completed` remains the lifecycle state for successful degraded fallback, but callers can now rely on `executionHealth`, `runtimeSignals`, and `providerEvidence` together to interpret the outcome.

### 2026-03-31

- Decision: `ClaudeCliProvider` now emits a bounded stall warning and then fails silent runs that never produce output, instead of waiting in `running + clean` until the outer task timeout.
- Why: Real Claude background-task repros can now launch successfully through the bundled CLI path but still hang with no stdout, no `turn.completed`, and no runtime signal, which left operators without diagnostic evidence and delayed read-only fallback or failure handling.
- Impact: Silent Claude analyze/plan/apply runs now degrade and settle earlier with `PROVIDER_RESULT_STALLED` semantics, making OpenClaw repros observable and preventing indefinite clean-looking hangs after synthetic turn start.

### 2026-03-31

- Decision: `ClaudeCliProvider` now auto-discovers the bundled Claude CLI inside installed `Claude Code for VS Code` extension directories when the configured executable name is not found on `PATH`.
- Why: Some environments rely on the extension-bundled native Claude binary plus LiteLLM-style local gateway config, so strict `PATH`-only discovery was incorrectly surfacing `PROVIDER_NOT_READY` even though a valid local CLI runtime was already present.
- Impact: Background Claude tasks still require the Claude CLI runtime semantics, but operators no longer need to manually point `clawdrive.provider.claude.path` at the extension's bundled `claude.exe` in common local VS Code installs.

### 2026-03-30

- Decision: `Claude Code for VS Code` support is a handoff-only route within `vscode.agent.route` plus a local `clawdrive.openInClaudeCode` helper, not a long-running `TaskProvider`.
- Why: The documented VS Code integration exposes an IDE handoff surface that can open Claude and prefill a prompt, but it does not provide a stable third-party background task contract equivalent to the CLI-backed providers.
- Impact: `codex` and `claude` remain the only background task providers; explicit Claude VS Code requests now open Claude Code with a prefilled prompt and return an immediate direct-result acknowledgement instead of entering `vscode.agent.task.*`.

### 2026-03-30

- Decision: Alternate built-in provider fallback is now an explicit operator option instead of an always-on readiness behavior.
- Why: Some environments need strict provider selection semantics, especially when `claude` means a specific local plugin/runtime expectation rather than “any Claude-capable backend”.
- Impact: Default behavior is now strict again: the selected provider must be ready or the task stays `PROVIDER_NOT_READY`; operators can opt into automatic fallback only by enabling the dedicated setting.

### 2026-03-30

- Decision: Provider selection is now a stable `codex | claude` configuration boundary, with Claude Code integrated as a separate provider implementation instead of extending the Codex-specific runtime.
- Why: The task model and approval boundary are provider-agnostic, but Codex CLI assumptions in config, settings, diagnostics, and task startup needed to be split before Claude Code could be supported safely.
- Impact: `clawdrive.provider.kind` now routes long-running tasks to either Codex or Claude Code, settings expose separate executable/model fields for each, and task semantics stay on the existing `analyze` / `plan` / `apply` contract.

### 2026-03-30

- Decision: TaskService now keeps a service-level hard-transport watchdog for active provider runs, so `turn.started` tasks that record unrecovered hard transport warnings are aborted and normalized even if the provider promise itself never settles.
- Why: Some real OpenClaw repros still observed `running + degraded` after `turn.started` plus `missing-content-type` or closed-channel warnings, which means provider-side early-failure logic alone was not a sufficient containment boundary.
- Impact: Read-only analyze/plan tasks with stuck hard transport breakage now still fail or fall back to bounded local results within a short window instead of depending entirely on provider-side finalization behavior; this is a safety net and does not change the public `vscode.agent.task.*` surface.

### 2026-03-30

- Decision: Hard post-turn transport breaks such as `missing-content-type`, `UnexpectedContentType`, or closed result streams now use a shorter failure grace than the generic task timeout-derived budget.
- Why: Default 300s task budgets were leaving even simple read-only tasks degraded and `running` for roughly 25 seconds after downstream transport failure before they failed or fell back, which looked like a regression even though the plugin eventually settled them.
- Impact: Simple analyze/plan tasks with unrecovered hard transport breakage now fail or fall back within a much shorter bounded window, while softer transport degradation still keeps the broader grace budget.

### 2026-03-30

- Decision: Post-turn transport warnings now require semantic recovery such as final output or `turn.completed`; generic todo/tool item activity no longer suppresses early transport failure handling by itself.
- Why: Some read-only tasks emitted downstream transport-closed warnings, kept producing low-level item traffic, and stayed degraded for too long before settling even though the transport had likely already broken semantically.
- Impact: Read-only analyze/plan runs fall back or fail faster after real post-turn transport breakage instead of waiting behind non-semantic provider activity, reducing long `running + degraded` windows on simple tasks.

### 2026-03-30

- Decision: Provider runtime isolation now exposes an experimental `raw` policy level plus configurable forced-off Codex startup features for task runs.
- Why: Some provider-backed diagnostics need a controlled way to test whether failures are caused by the plugin's derived task environment versus the source Codex home and startup feature set.
- Impact: Default behavior stays on `safe`/`extended`, but operators can now opt into `raw` source `CODEX_HOME` reuse and can clear the forced-off feature list for targeted experiments without changing the remote task command surface.

### 2026-03-30

- Decision: Read-only `analyze`/qualifying `plan` task runs may complete via bounded local workspace fallback after provider transport/stall/finalization failures instead of always ending as terminal failure.
- Why: Complex repository-debug prompts can still lose the provider result after `turn.started` even when the plugin already has enough deterministic local evidence to produce a useful bounded report or reading plan.
- Impact: Transport-backed read-only failures can settle as degraded local results with retained runtime-signal evidence; `apply` stays provider/approval-driven, and the remote `vscode.agent.task.*` surface remains unchanged.

### 2026-03-30

- Decision: Read-only `analyze` and `plan` provider runs now prepend a bounded deterministic local workspace snapshot to the provider prompt before any shell exploration is attempted.
- Why: Complex repository-understanding tasks were frequently entering `turn.started` and then stalling while Codex tried to discover basic workspace structure via shell/tool probing, especially on Windows or degraded transport paths.
- Impact: Provider-backed read-only tasks start with local evidence such as workspace root, top-level entries, package metadata, and key source subdirectories, reducing unnecessary early shell probing and making complex repository-debug prompts less dependent on runtime command exploration.

### 2026-03-30

- Decision: Read-only prompts that say `do not modify` or equivalent no longer imply `plan` by themselves and no longer block direct `analyze` task starts.
- Why: Negative write phrasing was being misread as positive write intent, which pushed read-only debugging requests into the wrong mode or rejected valid `analyze` runs.
- Impact: Route and direct `vscode.agent.task.start` calls preserve read-only analysis intent more reliably; explicit options/tradeoff requests still route to `plan`, and explicit write requests still require `apply`.

### 2026-03-30

- Decision: Unrecovered post-turn transport fallback warnings now retain transport-specific failure attribution even if a broader stall/turn timeout is the terminal path; read-only analyze/plan prompts also ask for an early progress item before long investigation.
- Why: Complex read-only tasks could emit downstream reconnect/stream-close warnings and then still end as a generic turn stall after a long silent period, which obscured the likely root cause and left operators with less actionable evidence.
- Impact: Failed runs surface transport breakage more consistently, and provider prompts nudge Codex to emit observable progress earlier on long multi-step read-only tasks.

### 2026-03-30

- Decision: Quiet `plan` turns now get a wider mode-aware turn-completion timeout after `turn.started`, instead of sharing the generic timeout budget used by other modes.
- Why: Some complex read-only plan runs can remain semantically quiet for longer than the generic 60%-of-task timeout window before they emit the first usable result, which was surfacing as false `PROVIDER_TURN_STALLED` failures.
- Impact: Complex plan tasks have more room to finish a long quiet turn before failing, while non-plan modes and the overall task timeout remain unchanged.

### 2026-03-29

- Decision: Transport degradation after `turn.started` can now fail a task early with a transport-specific provider failure instead of waiting for the broader turn-stall timeout.
- Why: Real downstream proxy/relay failures were surfacing as `PROVIDER_TURN_STALLED` after several minutes even when Codex had already emitted a transport fallback/body-decode warning that strongly indicated the turn would not recover.
- Impact: Long-running tasks now fail faster and more accurately as `PROVIDER_TRANSPORT_FAILED` when the transport breaks after turn start and no semantic recovery follows; operator diagnostics also retain fallback detail for failed transport runs.

### 2026-03-29

- Decision: The `ClawDrive: Dashboard` surface now includes recent tracked task visibility plus local task management for cancel and terminal-task deletion.
- Why: Operators need one primary console surface where they can see plugin-tracked task state and clear old finished tasks without switching to the separate activity tree.
- Impact: Dashboard semantics are no longer limited to connect/settings/diagnose; it now shows the latest tracked tasks, allows cancel for active/resumable tasks, allows delete only for completed/failed/cancelled tasks, and does not expand the remote `vscode.agent.task.*` command surface.

### 2026-03-29

- Decision: External selftest now drives gateway and node calls through the official OpenClaw CLI surfaces instead of a private raw WebSocket client.
- Why: The gateway handshake and control-plane client identity contract drifted enough that the old raw selftest client was being rejected with `INVALID_REQUEST`, while the operator CLI surface remained the stable path that real users and automation already invoke.
- Impact: `npm run selftest` now validates the same `openclaw nodes ...` and `openclaw gateway call ...` paths operators use, reduces protocol drift risk, and follows local OpenClaw config without maintaining a separate gateway implementation.

### 2026-03-29

- Decision: Quiet `plan` turns now get a wider pre-result stall warning budget before the first usable output arrives.
- Why: Healthy complex read-only plan runs can stay silent for well over 30 seconds before producing the first structured result, and the generic warning budget was downgrading successful end-to-end tasks during selftest.
- Impact: Complex plan tasks are less likely to finish with false `PROVIDER_RESULT_STALL_WARNING` degradation, while true long silent stalls still fail on the existing plan-specific failure budget.

### 2026-03-29

- Decision: Non-interactive provider prompts now explicitly forbid `request_user_input` and require a best-effort single-response result instead.
- Why: Provider plan/analyze runs were sometimes attempting interactive follow-up input during unattended task execution, which produced avoidable runtime warnings and downgraded otherwise successful tasks.
- Impact: Unattended task runs stay on the stable `analyze`/`plan`/`apply` contract without trying to open an unsupported interactive input path mid-run.

### 2026-03-29

- Decision: Generic `PROVIDER_RUNTIME_STDERR` noise is ignored once `turn.completed` has arrived and a usable final result is already captured.
- Why: Late plugin or process-exit stderr such as `Exit code: 1` was downgrading otherwise successful provider tasks to `warning` even though the semantic result was already complete.
- Impact: Completed tasks stay `clean` when only residual post-result stderr appears; real degraded or fatal runtime signals still surface normally.

### 2026-03-28

- Decision: Non-interactive Codex task exec/resume now always pass `--skip-git-repo-check`, even when a workspace root is present.
- Why: Provider-backed tasks should not be blocked by Codex directory trust or repository-gate checks; recent OpenClaw runs were being rejected before task execution with "Not inside a trusted directory" despite the workspace path being valid.
- Impact: Task startup no longer depends on Codex's local trust/git-repo gate for the current workspace, reducing another non-semantic source of startup failure.

### 2026-03-29

- Decision: Provider prompts now steer Windows read-only shell probes to cmd.exe built-ins (dir/type/findstr) and avoid PowerShell cmdlets by default.
- Why: Codex command policy was blocking PowerShell directory probes in unattended tasks; steering to trusted built-ins reduces policy blocks while keeping read-only probing available.
- Impact: Provider-backed tasks are less likely to degrade with command policy warnings on Windows while still allowing minimal read-only shell exploration.

### 2026-03-29

- Decision: Added configurable provider sandbox mode (`read-only`, `workspace-write`, `danger-full-access`) surfaced in settings and forwarded to Codex exec runs.
- Why: Operators need explicit control over how much command execution is permitted to reduce degraded runs or intentionally expand capabilities.
- Impact: Task runs can be tuned between strict read-only, workspace write, or full-access sandboxing without code changes.

### 2026-03-29

- Decision: Windows task runs set `windows.sandbox=unelevated` instead of the previous `none` override.
- Why: Codex config currently accepts only `elevated` or `unelevated`; `none` is a hard parse error, and the unelevated sandbox avoids UAC prompts for unattended execution.
- Impact: Windows tasks avoid UAC elevation prompts without breaking config parsing.

### 2026-03-28

- Decision: For `plan` tasks, the post-turn stall failure threshold is widened relative to other modes, while warnings remain time-bounded.
- Why: Real complex read-only plan runs can stay quiet for long stretches after `turn.started` yet still complete; a single global stall failure threshold was killing those tasks prematurely.
- Impact: Plan tasks tolerate longer no-output windows before failing, reducing false `PROVIDER_RESULT_STALLED` while still allowing hard failures for true stalls.

### 2026-03-28

- Decision: Windows sandbox helper failures now emit a dedicated degraded runtime signal.
- Why: Sandbox helper errors were being lumped into generic stderr noise, obscuring the real cause of slow or blocked shell execution during tasks.
- Impact: Operator diagnostics can distinguish Windows sandbox constraints from model/transport stalls.

### 2026-03-28

- Decision: Post-turn stall warnings now use a wider budget once Codex has already emitted `item.*` work/progress events after `turn.started`.
- Why: Real complex read-only plan runs can stay visibly silent for well over 30 seconds between todo/tool updates and the final structured result while still succeeding normally; the old warning threshold was misclassifying those healthy long steps as output stalls.
- Impact: Complex provider-backed tasks are less likely to show false `PROVIDER_RESULT_STALL_WARNING` health degradation during legitimate long-running reasoning/execution phases, while truly silent post-turn stalls still warn on the tighter path.

### 2026-03-28

- Decision: Codex task runs now materialize a derived task `CODEX_HOME` even under `extended`, copying auth/model-provider config from the source home but stripping task-unsafe `[features]` and `[mcp_servers.*]` sections before execution.
- Why: Raw source `CODEX_HOME` was inheriting stale feature keys and remote helper/plugin state into non-interactive task runs, which aligned with intermittent `missing-content-type` transport warnings and plugin sync noise.
- Impact: `extended` still preserves operator auth and upstream model-provider settings, but task executions no longer run directly out of the raw source Codex home.

### 2026-03-28

- Decision: Non-interactive Codex task args now disable `multi_agent`, `plugins`, `apps`, and `shell_snapshot`; provider status refresh is also single-flight.
- Why: Local repro showed these startup features add remote plugin sync and shell snapshot noise in task mode, while concurrent startup/task refreshes could launch duplicate provider probes.
- Impact: Task runs are narrower and less noisy, and startup no longer races multiple provider probes for the same readiness check.

### 2026-03-28

- Decision: Provider finalization now preserves a captured final result even if the Codex child exits non-zero afterward, while pre-turn transport warnings still fail fast if no semantic progress ever begins.
- Why: Late plugin/telemetry exits should not discard a valid result that was already captured, but transport failures before `thread.started`/`turn.started` should still resolve promptly instead of hanging until the outer task timeout.
- Impact: Result-bearing runs are more likely to complete successfully despite noisy late exits, and pre-turn transport breakage surfaces as an earlier provider failure instead of a generic long timeout.

### 2026-03-28

- Decision: Transport runtime warnings such as `missing-content-type` remain degraded evidence, but no longer force early provider failure on their own.
- Why: Complex Codex runs can emit transient downstream transport warnings and still recover to a valid final result; treating the warning itself as terminal was killing recoverable runs before normal stall, exit, or finalization logic had a chance to complete.
- Impact: Provider-backed tasks now keep running after degraded transport warnings unless a real terminal condition occurs, while diagnostics still preserve the warning for operator triage.

### 2026-03-27

- Decision: `vscode.agent.task.start` now accepts compatibility mode aliases while keeping the canonical internal task model unchanged.
- Why: Direct task callers often use more common agent vocabulary such as `ask` and `edit`; rejecting those modes creates avoidable protocol friction even when the intended behavior is already representable by `analyze` or `apply`.
- Impact: External callers may use `ask`/`chat`/`analysis`/`analyse` for `analyze` and `edit` for `apply`, while storage, lifecycle, and provider code still run on the stable `analyze`/`plan`/`apply` contract.

### 2026-03-27

- Decision: Runtime `out/` must be rebuilt on test, selftest, and package entrypoints instead of relying on manual compile discipline.
- Why: The extension runs from `out/`, while tests also build `out-test/`; without an automatic guard, source fixes can pass tests while the shipped runtime still behaves like the old build.
- Impact: `npm test`, `npm run selftest`, and VS Code packaging now compile runtime output first, keeping source, tests, and runnable artifacts aligned by default.

### 2026-03-27

- Decision: Diagnose routing now requires explicit status/failure intent; a generic mention of `provider` is not enough.
- Why: Architecture and contract questions about the provider were being misrouted into diagnosis instead of inspect/analyze.
- Impact: Prompts such as "Explain the provider contract" stay on the normal repository-understanding path, while status/debug prompts still route to diagnose.

### 2026-03-27

- Decision: Active task cancellation now waits for the post-abort state to settle before returning, and `interrupted` is excluded from terminal-history pruning.
- Why: Returning a stale `running` snapshot after cancel and pruning resumable `interrupted` tasks both weaken the task contract.
- Impact: Cancel callers see the settled lifecycle state, and interrupted tasks remain available for continuation across restart and history pruning.

### 2026-03-27

- Decision: Transport runtime warnings now trigger a bounded grace period and then fail the task if no result is produced.
- Why: Complex plan runs can hang after `turn.started` with transport errors; we must force terminal failure instead of leaving `running`.
- Impact: Tasks end as failed with `PROVIDER_TRANSPORT_FAILED` when transport closes and no output arrives within the grace window.

### 2026-03-27

- Decision: Harden Codex CLI finalization by preferring output-file results with stable read retries, and add degraded plan option extraction when JSON is missing.
- Why: Complex plan prompts can stall after `turn.started` with missing output; we need deterministic finalization and a safe fallback.
- Impact: `TaskProviderEvidence` gains `finalizationPath`, provider results can complete with degraded plan options instead of hanging, and output-file reads are retried for stability.

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
- Added `.vscodeignore` so local VSIX packages ship runtime assets only instead of source, tests, and repo-only docs.
- Defaulted `clawdrive.autoConnect` to `false` for new installs.
- Moved provider readiness probing off the synchronous startup path; startup now restores task state first and refreshes provider status in the background.
- Simplified activation policy to `onStartupFinished` only so startup and fallback activation paths no longer overlap.

### 2026-03-27

- Decision: Add `clawdrive.provider.policyLevel` with `safe` (default, isolated CODEX_HOME) and `extended` (derived task CODEX_HOME seeded from the source home).
- Why: Reduce policy friction for read-only probing without removing the default safety boundary.
- Impact: Operators can opt into broader provider permissions; extended mode preserves auth and model-provider config while still stripping task-unsafe sections before execution.

## Next Entry Template

Use this format for future entries:

```md
### YYYY-MM-DD

- Decision:
- Why:
- Impact:
```
