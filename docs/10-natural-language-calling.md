# Natural-Language Calling Guide

## Purpose

This document defines the v1 conversation contract for using OpenClaw with `ClawDrive for VS Code` through natural language instead of raw protocol commands.

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

## Intent Classes

### 1. Read And Query

Examples:

- "Read the README and tell me how to install this project."
- "Check the current git status."
- "Show me the files under `src`."

Recommended route:

- direct read-only capability

### 2. Analyze And Summarize

Examples:

- "Summarize the current architecture."
- "Explain how the Gateway flow works."
- "Compare two implementation directions."

Recommended route:

- start with read-only inspection
- upgrade to task analysis mode when the request is broad or multi-step

### 3. Plan And Decide

Examples:

- "Give me two implementation options."
- "Analyze the next step, but do not modify anything."
- "I want to choose the direction myself."

Recommended route:

- planning mode
- translate decision requests into plain language
- avoid raw JSON unless the user asks for it

### 4. Execute And Modify

Examples:

- "Fix this bug."
- "Apply the recommended approach."
- "Update the docs."

Recommended route:

- do not write immediately
- briefly restate intended scope
- require explicit write intent before entering write-capable execution

### 5. Continue Or Debug

Examples:

- "Continue the last task."
- "Use the recommended option and keep going."
- "Why is the node connected but still not callable?"

Recommended route:

- attach to the most recent active or waiting task when unambiguous
- use diagnostics for connection and readiness problems
- ask for a specific task only when there is real ambiguity

## Routing Rules

Apply these rules in order.

1. If the user asks to read, inspect, check, summarize, or analyze, default to read-only behavior.
2. If the user asks for options, tradeoffs, or explicitly says not to change anything, force planning behavior.
3. If the user asks to fix, implement, apply, or commit, do not write immediately. Confirm the intended execution first.
4. If the user says continue, keep going, or use the recommended option, resolve the latest waiting or active task internally before treating it as a new task.
5. If the user asks for status or progress, summarize the task in natural language instead of returning raw task JSON.
6. Only reveal command names, task identifiers, or protocol details when debugging, failure analysis, or ambiguity makes it necessary.

## Prompt Contract

The assistant prompt should follow these rules.

### Role Framing

Treat the user as talking to an IDE assistant, not a command runner.

Prefer:

- understanding intent
- choosing the right internal route
- hiding protocol mechanics

Avoid:

- asking users to name raw commands
- requiring users to provide task IDs
- exposing JSON unless needed

### Agent Split

The implementation may contain multiple internal agent surfaces.
Natural-language long-form work should prefer the provider-neutral task flow rather than older one-shot agent checks or vendor-specific status probes.

### Safety Contract

For any request that could modify code, run terminal commands, or create git history:

- analyze first
- plan first when the request is broad
- require explicit user confirmation before write execution

### Task Hiding Contract

Internally the system may use start, status, respond, and result semantics.

Externally it should say things like:

- "I am analyzing the repository."
- "I organized two directions for you to choose from."
- "I am continuing with the recommended option."

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

### Execute Template

```text
Apply the recommended approach, make the code changes, and summarize what changed.
```

### Resume Template

```text
Continue the last plan task and use the recommended option.
```

### Debug Template

```text
Check why the VS Code node is connected but still cannot be called.
```

## Acceptance Checklist

This guide is working as intended when:

- users can describe goals in plain language
- the system chooses inspect, analyze, plan, or apply behavior without asking for raw commands
- users do not need task IDs for normal flows
- progress updates are phrased naturally
- protocol details appear only in debugging or failure explanations
