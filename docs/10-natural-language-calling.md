# Natural-Language Calling Guide

## Purpose

This document defines the current v1 conversation contract for using OpenClaw with `ClawDrive for VS Code` through natural language instead of raw protocol commands.

It is written for end users and prompt authors first, not protocol debuggers.

## Goal

Make OpenClaw feel like an IDE assistant:

- users speak in normal language
- ClawDrive resolves that intent into the right IDE path
- low-level task details stay hidden unless debugging requires them

Default behavior:

- conversation-first
- read-first safety
- plan before write
- hide task protocol details by default

## Public Entry

The current preferred entrypoint for OpenClaw is:

- `vscode.agent.route`

That entrypoint accepts a plain prompt plus optional focus paths and decides whether to:

- answer through direct read-only commands
- start `analyze`
- start `plan`
- continue the most relevant recent task
- diagnose current connection, callable, provider, or latest-task problems

## Intent Classes

### 1. Read And Query

Examples:

- "Read the README and tell me how to install this project."
- "Show me the files under `src`."
- "Check current diagnostics."

Recommended route:

- direct read-only commands

### 2. Analyze And Summarize

Examples:

- "Summarize the current architecture."
- "Explain how the Gateway flow works."
- "Compare these two modules."

Recommended route:

- start with read-only inspection
- upgrade to task `analyze` mode when the request is broad or multi-step

### 3. Plan And Decide

Examples:

- "Give me two implementation options."
- "Analyze the next step, but do not modify anything."
- "I want to choose the direction myself."

Recommended route:

- planning mode
- translate decision requests into plain language
- avoid raw JSON unless the user asks for it

### 4. Continue Or Debug

Examples:

- "Continue the last task."
- "Use the recommended option and keep going."
- "Why is the node connected but still not callable?"

Recommended route:

- attach to the most recent active or waiting task when unambiguous
- use diagnostics for connection and readiness problems
- ask for a specific task only when there is real ambiguity

Current continuation preference order:

1. latest `waiting_decision`
2. latest `interrupted`
3. latest `running`
4. latest `queued`

If multiple tasks are equally plausible at the top priority, the router should return a short clarification list instead of guessing.

## Current Write Rule

Broad write execution is not implemented in the current milestone.

If the user asks to:

- fix
- implement
- patch
- edit
- apply

the expected behavior is:

- do not perform the write directly
- enter planning behavior or ask for a planning-first step

This is a deliberate v1 safety boundary, not a bug.

## Routing Rules

Apply these rules in order.

1. If the user asks to read, inspect, check, summarize, or analyze, default to read-only behavior.
2. If the user asks for options, tradeoffs, or explicitly says not to change anything, force planning behavior.
3. If the user asks to fix, implement, apply, or commit, do not write immediately. Redirect to planning-first behavior.
4. If the user says continue, keep going, or use the recommended option, resolve the latest waiting or active task internally before treating it as a new task.
5. If the user asks for status or progress, summarize the task in natural language instead of returning raw task JSON.
6. If the user asks why something failed, return a diagnosis-style explanation that prefers the latest relevant task failure.
7. Only reveal command names, task identifiers, or protocol details when debugging, failure analysis, or ambiguity makes it necessary.

## User-Facing Reply Style

Default reply style:

- short
- action-oriented
- natural
- no command names by default

Preferred examples:

- "I will first inspect the workspace and read the README."
- "I found two reasonable directions. You can pick one."
- "I am continuing with the recommended approach."

Avoid by default:

- "I called a task-start command."
- "Task `...` is now waiting for decision."

## Ready-To-Use Templates

### Read Template

```text
Read the current project README and summarize installation steps and known limits.
```

### Analyze Template

```text
Explain how the current Gateway timeout and task orchestration logic works.
```

### Plan Template

```text
Analyze the next most valuable change for this repository. Give me two options and do not modify anything yet.
```

### Resume Template

```text
Continue the last plan task and use the recommended option.
```

### Debug Template

```text
Check why the VS Code node is connected but still cannot be called.
```

```text
Why did the latest plan task fail?
```

## Acceptance Checklist

This guide is working as intended when:

- users can describe goals in plain language
- the system chooses inspect, analyze, plan, or continue behavior without asking for raw commands
- users do not need task IDs for normal flows
- progress updates are phrased naturally
- failure explanations name the real blocking layer such as allowlist, provider readiness, CLI compatibility, or task timeout
- protocol details appear only in debugging or failure explanations
