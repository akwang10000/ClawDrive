# ClawDrive for VS Code

ClawDrive is the VS Code bridge that lets OpenClaw route natural-language requests into IDE-native read commands, resumable long tasks, and a controlled apply flow.

Chinese version:
- [README.md](readme.md)

## Current Status

The repository has moved beyond the original Gateway command-bridge prototype.

Validated paths now include:

- Gateway connection and device identity reuse
- a read-only command surface for workspace, file, directory, editor, and diagnostics inspection
- `vscode.agent.route` as the public natural-language entrypoint
- `vscode.agent.task.*` as the long-task lifecycle surface
- Codex CLI as the first provider adapter
- persisted task snapshots and event history
- recovery for `waiting_decision`, `waiting_approval`, and `interrupted`
- a VS Code `ClawDrive Activity` task view
- the first `apply` thin slice with structured edits, explicit approval, and local controlled writes

Validated end-to-end flows:

- `OpenClaw -> Gateway -> ClawDrive -> vscode.workspace.info -> Gateway result`
- `OpenClaw -> vscode.agent.route -> inspect/analyze/plan/apply/continue`
- `OpenClaw -> vscode.agent.task.start/respond/result -> Codex CLI provider -> task lifecycle`
- `apply -> waiting_decision -> waiting_approval -> approved/rejected -> completed/cancelled`

## Public Capability Surface

Implemented remote commands:

- `vscode.agent.route`
- `vscode.workspace.info`
- `vscode.file.read`
- `vscode.dir.list`
- `vscode.editor.active`
- `vscode.diagnostics.get`
- `vscode.agent.task.start`
- `vscode.agent.task.status`
- `vscode.agent.task.list`
- `vscode.agent.task.respond`
- `vscode.agent.task.cancel`
- `vscode.agent.task.result`

Implemented long-task modes:

- `analyze`
- `plan`
- `apply`

Current task states:

- `queued`
- `running`
- `waiting_decision`
- `waiting_approval`
- `completed`
- `failed`
- `cancelled`
- `interrupted`

## Current Natural-Language Behavior

- simple inspect requests stay on synchronous read-only commands
- broader explanation requests route to `analyze`
- option and tradeoff requests route to `plan`
- explicit fix / implement / modify requests default to `apply`
- `continue` resolves against the most relevant recent active task
- explicit approval or rejection phrases target the latest `waiting_approval`
- status and failure questions can return a synchronous diagnosis summary

## Current Write Boundary

The current `apply` slice only supports controlled structured edits:

- `write_file`
- `replace_text`

Explicitly out of scope in this milestone:

- delete / rename
- arbitrary shell
- git operations
- test / debug / terminal / formatter execution
- provider-side direct file mutation

Actual writes are performed by a local VS Code execution layer with:

- workspace containment checks
- whole-batch prevalidation
- exact unique matching for `replace_text`
- rollback attempts on write failure

## Operator Notes

Recommended setup flow:

1. Open `ClawDrive: Settings`.
2. Configure Gateway host, port, token, and provider settings.
3. Leave auto-connect enabled unless you explicitly want manual connection.
4. Save settings and let the extension connect.
5. Use `ClawDrive: Dashboard`, `ClawDrive Activity`, or the `ClawDrive` output log only when you need verification or diagnosis.

If the Gateway uses `gateway.nodes.allowCommands`, keep the allowlist aligned with the extension's advertised surface.
At minimum, allow:

- `vscode.agent.route`
- `vscode.workspace.info`
- `vscode.file.read`
- `vscode.dir.list`
- `vscode.editor.active`
- `vscode.diagnostics.get`
- `vscode.agent.task.start`
- `vscode.agent.task.status`
- `vscode.agent.task.list`
- `vscode.agent.task.respond`
- `vscode.agent.task.cancel`
- `vscode.agent.task.result`

Provider execution may still emit helper, sandbox, or transport-layer warnings.
The current objective is:

- keep the primary user flow working
- avoid turning non-fatal low-level noise into user-facing hard failures
- surface a clearer root-cause summary in diagnosis and task results

## Compatibility And Provider Notes

Gateway pairing is sensitive to device identity compatibility.
ClawDrive therefore:

- derives `deviceId` from the Ed25519 public-key fingerprint
- reuses the legacy `~/.openclaw-vscode/device.json` identity when available

Provider-backed tasks currently depend on a locally runnable Codex CLI.
Common failure classes already covered by the implementation and docs include:

- executable not found
- provider disabled
- incompatible CLI arguments
- policy or environment friction during read-only analysis
- external MCP configuration interfering with provider execution

## Not Implemented Yet

- broader language-service, git, test, debug, and terminal command families
- delete / rename mutations
- provider-side direct writes
- a full diff viewer or complex approval dashboard
- providers beyond Codex CLI

## Documentation

- [docs/03-command-surface.md](docs/03-command-surface.md)
- [docs/06-intent-routing.md](docs/06-intent-routing.md)
- [docs/07-validation-goals.md](docs/07-validation-goals.md)
- [docs/08-task-semantics.md](docs/08-task-semantics.md)
- [docs/09-operator-setup-and-diagnosis.md](docs/09-operator-setup-and-diagnosis.md)
- [docs/10-natural-language-calling.md](docs/10-natural-language-calling.md)
- [docs/10-natural-language-calling.zh-CN.md](docs/10-natural-language-calling.zh-CN.md)

## Local Development

```powershell
npm install
npm run compile
npm test
```

Then open the repository in VS Code and press `F5` to launch the extension development host.

## Reference Boundary

Behavior-analysis reference only:

- `https://github.com/akwang10000/openclaw-vscode.git`

This repository should not copy source code, tests, assets, or wording from that reference repository.
