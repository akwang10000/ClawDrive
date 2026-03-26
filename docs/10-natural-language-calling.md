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
- "Read `package.json` and tell me the real `main`, `activationEvents`, and `contributes.commands` values."
- "List the files under `src`."
- "Check current diagnostics."

Expected route:

- synchronous read-only commands
- explicit file paths such as `README.md`, `package.json`, or `src/extension.ts` can now be inferred directly from the prompt

### 1A. Grounded Extension Audit

Examples:

- "Read `package.json` and tell me the real `main`, `activationEvents`, and `contributes.commands` values."
- "Check whether this plugin's entrypoint, activation events, and command registration are aligned."
- "Inspect `src/extension.ts` and `out/extension.js` and verify the build output matches the source entry."

Expected route:

- synchronous local file reads plus a grounded summary

Current behavior:

- the router reads `package.json`
- it checks a common source entry such as `src/extension.ts`
- it reads the declared build entry such as `out/extension.js` when `main` points there
- it summarizes command registration and build-entry consistency from actual workspace content instead of starting a provider task

### 1B. Grounded File Summaries

Examples:

- "Read `README.md` and summarize installation."
- "Compare `package.json` and `src/extension.ts`."
- "Read `package.json`, `src/extension.ts`, and `out/extension.js` and summarize the entry flow."

Expected route:

- synchronous local file reads plus a grounded summary for up to four explicit files

Current behavior:

- if the prompt explicitly names one to four files and asks to summarize, compare, verify, or explain them, the router reads those files directly
- markdown files are summarized by headings
- code files are summarized by exported functions and `registerCommand(...)` calls when available
- JSON files are summarized by key fields or top-level keys

### 1C. Grounded Directory Summaries

Examples:

- "Summarize the `src` directory."
- "Check the main modules under `src`."
- "Look at `docs` and summarize what is there."

Expected route:

- synchronous directory listing plus a small number of representative file reads

Current behavior:

- if the prompt clearly asks to summarize or inspect a directory such as `src` or `docs`, the router first lists that directory
- it then reads up to three representative top-level files such as `README.md`, `index.ts`, `extension.ts`, or `package.json`
- the reply summarizes top-level folders and the sampled files instead of starting a provider task

### 1D. Shallow Repository Summaries

Examples:

- "Summarize this repository structure."
- "Look at `src` and explain the main modules."
- "Give me a quick overview of the project layout."

Expected route:

- synchronous workspace-root summary plus one-level follow-through into one or two relevant child directories

Current behavior:

- if the prompt is clearly about repository structure or main module layout, the router first summarizes the workspace root
- it may then follow into one or two relevant child directories such as `src` or `docs`
- each child follow-through remains shallow: one directory listing plus a small number of representative file reads
- if the request becomes broader or ambiguous, routing should still fall back to `analyze`

### 1E. Grounded Runtime-Flow Audit

Examples:

- "Explain how route, task service, and provider fit together."
- "Show me the main runtime flow from `vscode.agent.route` to the provider."
- "Explain the local route-task-provider chain."

Expected route:

- synchronous local reads of the fixed runtime wiring files plus a grounded summary

Current behavior:

- the router reads a small fixed set of files such as `src/extension.ts`, `src/commands/registry.ts`, `src/routing/service.ts`, `src/tasks/service.ts`, and provider files
- it summarizes the activation wiring, command registration, route surface, task orchestration, and provider contract from local evidence
- it is intended for narrow chain-explanation prompts, not broad architecture replacement for `analyze`

### 1F. Bounded Code-Location Lookup

Examples:

- "Where is `vscode.agent.route` wired up?"
- "Which file defines `TaskService`?"
- "Where is `clawdrive.dashboard` registered?"

Expected route:

- synchronous bounded local search inside grounded inspect

Current behavior:

- the router may run a bounded local lookup for an explicit token such as a command id or symbol name
- this helper scans only a limited set of likely files and directories
- it stays internal to route-time grounding and does not introduce a new public search command

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
2. Explicit extension-wiring audit requests should use local reads and a grounded summary when the prompt is clearly about entrypoints, activation events, command registration, or build-output consistency.
3. Repository-structure and main-module prompts should prefer shallow grounded summaries before broader analysis.
4. Narrow route-task-provider flow questions should prefer grounded runtime-flow audit before broader analysis.
5. Explicit code-location prompts with a stable token should prefer bounded local search before broader analysis.
6. Broad explanation requests should route to `analyze`.
7. Option, tradeoff, or "do not change anything" requests should route to `plan`.
8. Explicit fix, implement, or modify requests should route to `apply`.
9. `continue` should resolve against the latest relevant recent task instead of starting a duplicate.
10. Explicit approval and rejection phrases should resolve against the latest `waiting_approval`.
11. Status and failure questions should return a short diagnosis summary instead of raw task protocol unless debugging requires detail.

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

### Grounded Audit

```text
Read package.json and tell me the real main, activationEvents, contributes.commands, and whether src/extension.ts matches out/extension.js.
```

### Code Location

```text
Where is `vscode.agent.route` wired up?
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
