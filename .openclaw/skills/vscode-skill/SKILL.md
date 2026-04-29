---
name: vscode-skill
description: VS Code skill. Natural-language control layer for the OpenClaw VS Code node. Use when the user says "VS Code skill", "vscode skill", "use VS Code", asks to inspect code, read files, summarize a repository, plan next steps, continue a VS Code task, hand work off to Claude Code for VS Code, or debug why the VS Code node or provider is not callable.
---

# VS Code Skill

Goal: use the live VS Code node as the primary execution path for ClawDrive.

## Hard rules

- If the user explicitly invokes this skill by name, treat the VS Code node as the primary execution path.
- Do not answer from OpenClaw local context first when the request can be satisfied by the VS Code node.
- Do not say "this session does not have VS Code capability" until you have checked live node status in the current turn.
- Do not substitute ACP, coding-agent, generic local Codex execution, or local file reading unless the user explicitly asked for that fallback or the VS Code path has been proven unavailable.
- Prefer the plugin's current public contract: `vscode.agent.route` for natural-language work, direct `vscode.*` commands for narrow retrieval, and `vscode.agent.task.*` only when explicit task lifecycle control is needed.
- Respect strict provider selection. Do not assume the plugin will silently switch from `claude` to `codex`.

## Required first step

When this skill is invoked, start with a live capability check:

1. Call `nodes status`.
2. Find a connected, paired node whose capabilities include `vscode` or whose command list contains `vscode.*`.
3. If multiple VS Code nodes exist, prefer the connected node with the broadest `vscode.*` command set.
4. Only if no such node exists may you say the VS Code path is unavailable.

Do not infer node availability from unrelated signals such as stale memory or earlier failures in another turn.

## Current exposed direct commands

The current ClawDrive direct command surface is:

- `vscode.workspace.info`
- `vscode.file.read`
- `vscode.dir.list`
- `vscode.editor.active`
- `vscode.diagnostics.get`
- `vscode.agent.route`
- `vscode.agent.task.start`
- `vscode.agent.task.status`
- `vscode.agent.task.list`
- `vscode.agent.task.respond`
- `vscode.agent.task.cancel`
- `vscode.agent.task.result`

Do not invent unsupported direct commands such as `vscode.editor.openFiles`, `vscode.git.*`, `vscode.lang.*`, or a remote `clawdrive.openInClaudeCode` unless the live node actually advertises them.

## Claude split

Treat these as different surfaces:

- `Claude Code for VS Code`: handoff-only from the plugin side. It can open Claude and prefill a prompt, but it is not a background `vscode.agent.task.*` runtime.
- `Claude Code CLI`: the background provider behind `provider.kind = claude`.

Routing rule:

- If the user says "open in Claude", "continue in Claude Code", "use Claude Code for VS Code", or otherwise asks for Claude as an IDE tab/handoff experience, prefer `vscode.agent.route` with explicit handoff wording.
- If the user asks for a background VS Code task and the selected provider is `claude`, remember that this means `claude-cli`, not the VS Code extension.
- Do not collapse Claude handoff and Claude background-task semantics into one path.
- Remember that the current plugin can auto-discover the bundled Claude CLI from standard installed Claude Code for VS Code extension directories; a missing CLI error means that discovery still did not produce a runnable background executable.
- Do not claim Claude background task support is available unless the provider is actually ready.

## Command routing

After a matching node is found, route requests like this.

### 1. Read and query

Use direct node invocation for narrow supported retrieval tasks.

Typical mapping:

- workspace info -> `vscode.workspace.info`
- read a file -> `vscode.file.read`
- list files or folders -> `vscode.dir.list`
- active editor -> `vscode.editor.active`
- diagnostics -> `vscode.diagnostics.get`

Execution rules:

- Prefer `nodes invoke` with the exact supported `vscode.*` command.
- Return the real result from the node, summarized in natural language when helpful.
- If the user asks for "real result", include the raw payload or a faithful paraphrase of it.
- If the request asks for an unsupported direct capability, do not fabricate a command. Use `vscode.agent.route` if the request can still be handled naturally; otherwise say that the current VS Code node surface does not expose that capability.

### 2. Analyze and summarize

Use when the request is broad, cross-file, repository-wide, review-oriented, comparative, or interpretive.

Default route:

- Prefer `vscode.agent.route` for natural-language analysis and explanation.
- Use direct read-only `vscode.*` calls first only when the request is obviously narrow and fully covered by the direct surface.
- Only use `vscode.agent.task.start` when explicit task lifecycle tracking is actually needed.

Task mode rule:

- Canonical task modes are `analyze`, `plan`, and `apply`.
- Compatibility aliases such as `ask`, `chat`, `analysis`, and `analyse` map to `analyze`, but do not prefer them in new calls.

### 3. Plan and decide

For:

- "give me options"
- "plan first"
- "what should we do next"
- "do not change anything yet"

Default route:

- Prefer `vscode.agent.route` unless explicit task lifecycle control is needed.
- If starting a task directly, use `vscode.agent.task.start` with `mode="plan"`.

Decision rules:

- A `plan` task normally settles into `waiting_decision`.
- To choose an option on an existing task, continue or respond to that task rather than starting a duplicate planning task.
- Translate the decision request into natural language. Do not dump raw JSON unless the user asks.

### 4. Execute and modify

For explicit change requests:

- Prefer `vscode.agent.route` and let ClawDrive route the request into `apply`.
- If starting directly, use `vscode.agent.task.start` with `mode="apply"`.

Write-boundary rules:

- Do not use `mode="agent"`; it is not part of the current contract.
- Do not add your own extra preflight confirmation before task start. The ClawDrive `apply` flow already pauses for `waiting_decision` and then `waiting_approval`.
- Approval or rejection should target the current `waiting_approval` task instead of restarting work.

### 5. Claude handoff

For:

- "open this in Claude Code"
- "continue in Claude"
- "use Claude Code for VS Code"
- "hand this off to Claude"

Default route:

- Prefer `vscode.agent.route` with explicit natural-language wording that asks the plugin to open Claude Code for VS Code and prefill the prompt.
- Expect a direct-result acknowledgement rather than a task lifecycle object.
- Tell the user that prefilled Claude prompts may still require manual send in the Claude tab.

Do not do this:

- Do not start `vscode.agent.task.start` just because the user mentioned Claude.
- Do not translate a Claude handoff request into `mode="analyze"` or `mode="plan"` unless the user explicitly wants a background task and the provider is ready.

### 6. Continue, cancel, or debug

For:

- "continue the last task"
- "use the recommended option"
- "approve it"
- "do not apply it"
- "cancel the running task"
- "why did the latest task fail"
- "check whether the node is connected"
- "why is Claude not ready"

Default route:

- first use `nodes status`
- then inspect recent task state via `vscode.agent.task.list`, `vscode.agent.task.status`, or `vscode.agent.task.result` when task-level detail is needed
- use `vscode.agent.task.cancel` when the user explicitly wants cancellation
- prefer continuing or responding to an existing task over starting a new one

Important constraints:

- Dashboard task deletion is local VS Code UI only. There is no remote `vscode.agent.task.delete` command to call from OpenClaw.
- Provider readiness failures are not proof that the VS Code node itself is offline. Keep node health and provider readiness separate.

## Failure handling

When the VS Code path fails:

- Say which live step failed:
  - no connected VS Code node
  - node exists but command missing
  - node invocation returned an error
  - task entered provider execution but failed during runtime or finalization
  - provider is not ready for the selected backend
- Include the exact command that was attempted.
- Only then offer fallback options such as local inspection.
- Do not silently switch to local inference when the user explicitly requested this skill.
- Do not silently switch providers unless the user explicitly enabled or requested that behavior.

For Claude-specific readiness failures:

- If the error says `Claude Code CLI executable was not found`, explain that this refers to the CLI-backed provider.
- Explain that the plugin already checks the configured path, `PATH`, and standard Claude Code for VS Code extension locations for a bundled Claude CLI.
- If the user only intended to use the VS Code Claude extension, redirect them toward Claude handoff via `vscode.agent.route`.
- If they intended a background task, explain that they need a runnable Claude CLI, either through normal local installation, an auto-discoverable Claude Code for VS Code bundled CLI, or an explicit `clawdrive.provider.claude.path`.

## Important split

- `vscode.agent.route` is the preferred public natural-language entrypoint.
- `vscode.agent.task.*` is the long-running task orchestration and lifecycle surface.
- `vscode.agent.status` is a legacy health check and should not be used to block `vscode.agent.route` or `vscode.agent.task.*`.
- `Claude Code for VS Code` handoff should normally come through `vscode.agent.route`, not `vscode.agent.task.*`.
- The preferred chain is:
  OpenClaw -> VS Code node -> `vscode.agent.route` or targeted `vscode.*` / `vscode.agent.task.*`

## Reply style

- Speak like an IDE teammate.
- Say when you are using the live VS Code node.
- Prefer "I checked the live node and invoked ..." over abstract protocol talk.
- Keep protocol details hidden unless the user is debugging.
- When correcting a prior wrong assumption, state the correction clearly and move on.

## Examples

- `/skill vscode-skill read the current workspace info`
- `/skill vscode-skill read README.md`
- `/skill vscode-skill list the top-level files under src`
- `/skill vscode-skill show the active editor`
- `/skill vscode-skill analyze this repository and explain the main modules`
- `/skill vscode-skill give me two implementation options but do not modify code yet`
- `/skill vscode-skill open this in Claude Code for VS Code and continue there`
- `/skill vscode-skill continue the latest VS Code task and use the recommended option`
- `/skill vscode-skill debug why the latest VS Code task failed`

## Diagnostic shortcut

If the user explicitly asks for a proof that the VS Code path is real, do this in order:

1. `nodes status`
2. `nodes invoke` -> `vscode.workspace.info`
3. report the returned payload

This is the minimum end-to-end proof for the VS Code node path.
