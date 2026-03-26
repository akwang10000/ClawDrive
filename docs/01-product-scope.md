# Product Scope

## Product Identity

Working product identity for the rewrite:

- product name: `ClawDrive`
- extension display name: `ClawDrive for VS Code`
- repository/package name: `clawdrive-vscode`
- extension identifier: `wangtuo.clawdrive-vscode`
- configuration prefix: `clawdrive`

OpenClaw remains the upstream natural-language entry point.
ClawDrive is the VS Code-side bridge and orchestration layer.

## Product Goal

`ClawDrive for VS Code` should turn VS Code into a controlled OpenClaw node.

The primary product requirement is:

- OpenClaw can use natural language to drive AI agent workflows inside VS Code
- the extension translates conversational intent into IDE-native task execution
- the user should not need to think in raw `vscode.*` protocol calls for normal assistant workflows

Codex can be the first provider we implement, but it should be treated as the first adapter, not the entire product definition.
The architecture should be provider-capable so Claude or other agent backends can be added later without redefining the core system.

The desired system behavior is:

- OpenClaw can invoke editor and workspace capabilities through explicit `vscode.*` commands.
- The extension operates inside the VS Code extension host, not as an unrestricted shell bridge.
- Unsafe actions are gated by policy, confirmation, or allowlists.
- Long-running agent work is represented as resumable tasks rather than one-shot command calls.

## Current Mainline

The current implemented mainline is narrower than the full product ambition.

Today the repository is organized around this chain:

- OpenClaw enters through `vscode.agent.route`
- ClawDrive chooses between grounded inspect, `analyze`, `plan`, `apply`, `continue`, and `diagnose`
- direct inspect uses VS Code-local read-only capabilities when possible
- long-running reasoning and write orchestration use the stable task surface
- activity, status, and diagnosis surfaces explain progress and failure in plain language

Current grounded inspect coverage includes:

- workspace info
- file reads
- directory listing
- active editor
- diagnostics
- grounded summaries for explicit files and selected directories
- bounded local code-location lookup for explicit tokens such as command ids or symbol names
- grounded extension-wiring audit for `package.json`, source entrypoints, and build entrypoints
- grounded runtime-flow audit for the `route -> task -> provider` chain

Current task-backed coverage includes:

- `analyze`
- `plan`
- `apply`
- continuation and recovery
- explicit approval before local file mutation

Current task execution is still intentionally narrow:

- one provider implementation: Codex CLI
- local structured file mutation only
- no direct provider-side file writes
- no git, terminal, debug, or formatter execution

## Plugin And Provider Boundary

The product stays buildable only if ClawDrive and the provider keep a clear division of labor.

ClawDrive should own the deterministic, local, and policy-sensitive parts:

- natural-language route selection
- grounded local inspection and evidence gathering
- task lifecycle, persistence, and recovery
- approval and local mutation execution
- operator-facing diagnosis and status explanation

The provider should own the reasoning-heavy parts:

- broad analysis
- planning and tradeoff generation
- structured apply proposals
- natural-language synthesis once the relevant evidence is available

This means the product should not assume the provider can reliably self-discover workspace context through shell probing alone.
ClawDrive is expected to supply the stable local footing first when the request can be grounded deterministically.

## Scale Guard

The plugin must not grow into a second full agent runtime.

The intended ceiling for ClawDrive is:

- deterministic local inspection
- bounded routing logic
- bounded local execution
- bounded diagnosis

The plugin should avoid expanding into:

- open-ended repository crawling
- general-purpose search engine behavior
- full language-server replacement behavior
- git/test/debug/terminal orchestration as a default path
- provider-style autonomous reasoning implemented locally

The provider remains the place for open-ended reasoning.
ClawDrive remains the place for controlled local capability, grounding, and orchestration.

## Core User Outcomes

The new repository should support these user-level outcomes:

- ask OpenClaw in natural language to inspect, plan, continue, or implement work in VS Code
- route broad natural-language requests into the appropriate AI agent task flow inside the IDE
- keep raw command names optional rather than required for normal use
- let the user stay in conversation form for common flows such as "look at this", "give me options", "apply it", and "continue"
- inspect the active workspace and files
- read and edit code inside the workspace
- run long-lived planning or implementation tasks through a task API
- see readable activity summaries in the IDE UI

These are split into:

- current mainline: natural-language entry, grounded inspect, task-backed analyze/plan/apply, continuation, diagnosis, activity visibility
- later expansion: symbols and references, language-intelligence surfaces, git/test/debug/terminal actions

## Non-Goals For The First Rewrite Phase

- direct reuse of the old repository structure
- full parity with every old UI surface on day one
- marketplace polish, branding, or publisher migration
- multi-root workspace support
- text/file search commands
- language-intelligence commands such as symbols and references
- git, test, debug, and terminal command families

## Required Security Properties

The new implementation should preserve these high-level properties:

- workspace containment for `path` and `cwd`
- canonical containment should reject escape through symlink or junction resolution
- explicit mutation policy for file writes and other state-changing actions
- terminal execution disabled by default
- terminal execution parsed safely and restricted by basename allowlist
- shell metacharacters and command-substitution style input should not be accepted by the safe terminal path
- CLI paths should be validated as bare executable names or absolute paths, not interpolated shell fragments
- no shell concatenation for external CLI paths or task execution
- webview content protected by a restrictive CSP

## UX Requirements

The new repository should preserve these behavior goals:

- natural-language intent should be the primary user-facing control surface
- raw protocol commands should remain available for debugging and narrow control, but not be the default experience
- analysis should default to read-only behavior
- write-intent should be explicit and governable
- the assistant should usually resolve "continue" or "use the recommended option" without asking for internal task identifiers
- task activity should read like human status, not protocol jargon
- waiting-for-decision states should be obvious in the UI
- failures should surface short, actionable summaries

## Assistant Experience Goals

The rewrite should explicitly optimize for these interaction goals:

- users should feel they are driving an IDE assistant, not a remote procedure catalog
- the system should choose between inspect, analyze, plan, and apply paths with minimal protocol exposure
- provider brand names should be secondary to task intent in normal conversation
- decision points should be presented in plain language with a clear recommended option
- recovery from timeout, cancellation, or interruption should still feel like continuing a task, not debugging a transport layer

## Operator Experience Goals

The extension also needs a strong operator surface inside VS Code.

That includes:

- setup that makes first connection and first provider use understandable
- diagnostics that explain why a node is connected but command execution is unavailable
- activity views that reveal what a task is waiting on
- settings and status surfaces that help an operator confirm the extension is actually in the intended mode

These are product requirements, not post-launch polish.

## Product Boundary

The rewrite is successful only if it supports this chain cleanly:

- OpenClaw conversation
- natural-language intent routing
- VS Code extension task orchestration
- AI agent execution inside VS Code through a provider layer
- readable progress and results back to OpenClaw

If the system only exposes `vscode.*` commands but does not support that conversational chain well, it does not meet the primary requirement.

## Provider Requirement

The rewrite should define a provider abstraction early.

Minimum expectation:

- one stable task model
- one stable task lifecycle
- one stable OpenClaw-facing command surface
- multiple possible provider adapters behind it

Early target providers:

- Codex
- future providers such as Claude

Non-goal:

- baking provider-specific wording, storage shape, or routing assumptions so deeply into the design that a second provider becomes a rewrite

## Carry-Forward Lessons

These conclusions are worth preserving as specification:

- task timeout and user cancellation must be distinct states
- resume-path argument assembly needs compatibility-safe CLI handling
- activity text benefits from a deterministic template layer
- task timeout should default from configuration rather than requiring per-call override
