# Command Surface Summary

## Implemented Families In The Current Repository

The current repository exposes these command families:

- `vscode.file.*`
- `vscode.dir.list`
- `vscode.editor.*`
- `vscode.diagnostics.get`
- `vscode.workspace.info`
- `vscode.lang.*`
- `vscode.code.format`
- `vscode.git.*`
- `vscode.test.*`
- `vscode.debug.*`
- `vscode.terminal.run`
- `vscode.agent.*`
- `vscode.agent.task.*`

## Not Yet Implemented In The Current Repository

- `vscode.search.text`
- `vscode.search.files`

## Minimal Phase Order For The Rewrite

### Phase 1

- `vscode.workspace.info`
- `vscode.file.read`
- `vscode.dir.list`
- `vscode.editor.active`
- `vscode.diagnostics.get`

### Phase 2

- `vscode.file.write`
- `vscode.file.edit`
- `vscode.file.delete`
- `vscode.editor.openFiles`
- `vscode.editor.selections`

### Phase 3

- `vscode.lang.definition`
- `vscode.lang.references`
- `vscode.lang.hover`
- `vscode.lang.symbols`
- `vscode.lang.rename`
- `vscode.lang.codeActions`
- `vscode.lang.applyCodeAction`
- `vscode.code.format`

### Phase 4

- `vscode.git.status`
- `vscode.git.diff`
- `vscode.git.log`
- `vscode.git.blame`
- `vscode.git.stage`
- `vscode.git.unstage`
- `vscode.git.commit`
- `vscode.git.stash`

### Phase 5

- `vscode.test.list`
- `vscode.test.run`
- `vscode.test.results`
- `vscode.debug.*`

### Phase 6

- `vscode.terminal.run`
- `vscode.agent.status`
- `vscode.agent.run`
- `vscode.agent.setup`
- `vscode.agent.task.start`
- `vscode.agent.task.status`
- `vscode.agent.task.list`
- `vscode.agent.task.respond`
- `vscode.agent.task.cancel`
- `vscode.agent.task.result`

## Agent Task States

The current repository uses these task lifecycle states:

- `queued`
- `running`
- `waiting_decision`
- `completed`
- `failed`
- `cancelled`
- `interrupted`

## Agent Task Modes

The current task model uses:

- `agent`
- `plan`
- `ask`

## Provider Direction

The current repository is centered on Codex task execution, but the rewrite should treat provider choice as an implementation detail behind a stable task contract.

That means the new repository should aim for:

- provider-neutral task commands
- provider-specific adapters behind the task layer
- user-facing behavior that emphasizes assistant intent rather than provider brand names

Codex can be the first supported provider.
Claude or other providers should be considered future-compatible targets rather than out-of-model exceptions.

## Surface Honesty

The rewrite docs should distinguish between:

- stable external command names
- current MVP behavior behind those names
- future-upgrade targets

Important examples from the current repository:

- the public task API is provider-shaped, but the implementation only supports Codex today
- legacy `vscode.agent.*` commands and resumable `vscode.agent.task.*` commands both exist and should not be conflated
- some test and git commands are pragmatic shims rather than deep VS Code-native integrations

That behavior is acceptable as long as it is documented honestly and treated as deliberate scope, not hidden mismatch

## Rewrite Guidance

The new repository does not need to preserve the same file layout.
It does need to preserve a stable external command contract once the new command surface is published.
