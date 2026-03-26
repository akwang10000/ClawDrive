# Documentation Map

## Why This Exists

The repository docs now cover both:

- current implemented mainline behavior
- longer-term product direction

This index makes it easier to tell which document to read first and which documents describe current reality versus roadmap intent.

## Read In This Order

### 1. Product And Current Mainline

- [01-product-scope.md](01-product-scope.md)

Read this first when you need to answer:

- what ClawDrive is
- what the current mainline is
- what is implemented now versus later expansion
- what belongs in the plugin versus the provider

### 2. Runtime And Surface

- [02-node-protocol.md](02-node-protocol.md)
- [03-command-surface.md](03-command-surface.md)

Read these when you need to answer:

- what the VS Code node advertises
- what command surface is stable today
- which task modes and lifecycle states are real now

### 3. Routing And Task Model

- [06-intent-routing.md](06-intent-routing.md)
- [08-task-semantics.md](08-task-semantics.md)
- [10-natural-language-calling.md](10-natural-language-calling.md)
- [10-natural-language-calling.zh-CN.md](10-natural-language-calling.zh-CN.md)

Read these when you need to answer:

- how `vscode.agent.route` should behave
- when requests should use grounded inspect versus task execution
- how `analyze`, `plan`, `apply`, `continue`, and `diagnose` are supposed to feel

### 4. Validation And Operations

- [07-validation-goals.md](07-validation-goals.md)
- [09-operator-setup-and-diagnosis.md](09-operator-setup-and-diagnosis.md)

Read these when you need to answer:

- what counts as a real end-to-end capability
- how operators should verify connection, callable state, provider readiness, and task health

### 5. Engineering Constraints

- [05-cleanroom-rules.md](05-cleanroom-rules.md)
- [11-development-rules.md](11-development-rules.md)

Read these when you need to answer:

- what implementation constraints the rewrite must preserve
- how to keep code, tests, and docs aligned

### 6. Roadmap

- [12-next-step-plan.md](12-next-step-plan.md)
- [04-rewrite-roadmap.md](04-rewrite-roadmap.md)

Read these when you need to answer:

- what the immediate next development focus should be
- what earlier phase framing led to the current repository shape

Use these with this priority:

- read [12-next-step-plan.md](12-next-step-plan.md) for the active next milestone
- read [04-rewrite-roadmap.md](04-rewrite-roadmap.md) only as historical phase context, not as the current execution plan

## Current Mainline Summary

The current implemented mainline is:

- OpenClaw enters through `vscode.agent.route`
- ClawDrive chooses grounded inspect, `analyze`, `plan`, `apply`, `continue`, or `diagnose`
- direct inspect prefers VS Code-local read-only capability
- provider-backed work uses the stable `vscode.agent.task.*` task surface
- `apply` remains narrow and requires explicit approval before local mutation

Current grounded inspect strengths:

- explicit file reads
- explicit multi-file summaries
- explicit directory summaries
- extension-wiring inspection grounded in workspace files

Current non-goals for the active slice:

- git/test/debug/terminal workflows
- language-intelligence command families
- broad autonomous repository understanding without grounding

## Document Rule

When behavior changes:

- update the nearest current-reality document first
- then update this map if the reading order or document purpose changed
