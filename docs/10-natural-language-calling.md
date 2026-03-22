# Natural-Language Calling Guide

## Purpose

This document defines the current natural-language conversation contract for using OpenClaw with `ClawDrive for VS Code`.

It is aimed at operators, prompt authors, and integration work, not protocol debugging first.

## Public Entry

The preferred entrypoint is:

- `vscode.agent.route`

Input:

- `prompt: string`
- `paths?: string[]`

The caller should usually provide only the user prompt and optional focus paths.

## Intent Classes

### 1. Read And Query

Examples:

- "Read the README and summarize installation."
- "List the files under `src`."
- "Check current diagnostics."

Expected route:

- synchronous read-only commands

### 2. Analyze And Explain

Examples:

- "Explain how this repository is structured."
- "Compare these two modules."
- "Summarize the architecture."

Expected route:

- `analyze`

### 3. Plan And Decide

Examples:

- "Give me two implementation options."
- "Plan first."
- "Do not change anything yet."

Expected route:

- `plan`

### 4. Apply With Approval

Examples:

- "Fix this bug."
- "Implement this behavior."
- "Modify the README."

Expected route:

- `apply`

Expected task flow:

- start `apply`
- return options and enter `waiting_decision`
- user chooses one option
- return structured file-operation preview and enter `waiting_approval`
- user explicitly approves or rejects

### 5. Continue, Approve, Reject, Diagnose

Examples:

- "Continue."
- "Use the recommended option."
- "Approve it."
- "Do not apply it."
- "Why did the latest task fail?"

Expected route:

- continue the latest relevant task when unambiguous
- approval and rejection phrases prefer the latest `waiting_approval`
- status and failure questions use the diagnosis summary path

## Routing Rules

Apply these rules in order:

1. Clear read requests should stay on synchronous read-only commands.
2. Broad explanation requests should route to `analyze`.
3. Option, tradeoff, or "do not change anything" requests should route to `plan`.
4. Explicit fix, implement, or modify requests should route to `apply`.
5. `continue` should resolve against the latest relevant recent task instead of starting a duplicate.
6. Explicit approval and rejection phrases should resolve against the latest `waiting_approval`.
7. Status and failure questions should return a short diagnosis summary instead of raw task protocol unless debugging requires detail.

## Current Continuation Preference Order

Generic continue behavior prefers:

1. latest `waiting_decision`
2. latest `interrupted`
3. latest `running`
4. latest `queued`

Explicit approval and rejection behavior prefers:

1. latest `waiting_approval`

If multiple tasks are equally plausible at the same priority, the router should return a short clarification list instead of guessing.

## Current Write Rule

The current write path is no longer planning-only, but it is still tightly scoped.

What happens now:

- write intent routes to `apply`
- provider proposes a plan and then a structured approval payload
- local VS Code execution performs the actual file mutation only after explicit approval

What is still out of scope:

- delete
- rename
- arbitrary shell or git execution
- provider-side direct writes

## Reply Style

Default user-facing replies should be:

- short
- natural
- action-oriented
- free of raw protocol names unless debugging requires them

Preferred examples:

- "I will inspect the current workspace and summarize the result."
- "I found two viable directions. You can pick one."
- "I am waiting for your approval before applying the proposed file changes."

## Ready-To-Use Templates

### Read

```text
Read the current README and summarize installation steps and current limitations.
```

### Analyze

```text
Explain how the current Gateway and task orchestration flow works.
```

### Plan

```text
Give me two implementation options for the next milestone, but do not modify anything yet.
```

### Apply

```text
Fix the README wording issue and wait for my approval before changing files.
```

### Continue

```text
Continue the last task and use the recommended option.
```

### Approve

```text
Approve the pending file changes.
```

### Diagnose

```text
Why did the latest provider task fail?
```

## Acceptance Checklist

This guide is working as intended when:

- users can describe goals in plain language
- the system chooses inspect, analyze, plan, apply, continue, or diagnose behavior without raw protocol instructions
- users do not need task IDs for common flows
- write execution requires explicit approval
- progress and results are phrased naturally
- failure explanations identify the real blocking layer such as allowlist, provider readiness, CLI compatibility, or transport/runtime friction
