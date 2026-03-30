import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as path from "path";
import { CodexCliProvider } from "../../src/tasks/codex-provider";
import { makeConfig, makeTempDir } from "../test-utils";

test("CodexCliProvider falls back to streamed agent message when output file is empty", async () => {
  const provider = new CodexCliProvider(makeConfig());
  stubProviderEnvironment(provider, {
    supportsAskForApproval: false,
    supportsOutputSchema: false,
    supportsOutputLastMessage: true,
    supportsResumeOutputLastMessage: true,
  });

  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: "",
    stderr: "",
    capture: {
      sawTurnStarted: true,
      sawTurnCompleted: true,
      turnStartedAt: Date.now(),
      lastProgressAt: Date.now(),
      lastOutputAt: Date.now(),
      lastActivityAt: Date.now(),
      lastAgentMessage:
        '{"summary":"Choose a path.","options":[{"id":"option_a","title":"Fast path","summary":"Do the fast thing.","recommended":true},{"id":"option_b","title":"Safe path","summary":"Do the safe thing.","recommended":false}]}',
      outputFileReady: false,
      stdoutEventTail: [],
    },
  });
  (provider as unknown as { readOutputMessageWithRetry: Function }).readOutputMessageWithRetry = async () => ({
    message: null,
    status: "empty",
  });

  const result = await provider.startTask(
    {
      taskId: "task-1",
      mode: "plan",
      prompt: "give me two options",
      paths: [],
      workspacePath: null,
    },
    noOpCallbacks(),
    new AbortController().signal
  );

  assert.equal(result.summary, "Choose a path.");
  assert.equal(result.decision?.recommendedOptionId, "option_a");
  assert.equal(result.providerEvidence?.finalMessageSource, "stream_capture");
  assert.equal(result.providerEvidence?.finalizationPath, "stream_capture");
});

test("CodexCliProvider parses embedded JSON from prose agent output", async () => {
  const provider = new CodexCliProvider(makeConfig());
  stubProviderEnvironment(provider, {
    supportsAskForApproval: false,
    supportsOutputSchema: false,
    supportsOutputLastMessage: false,
    supportsResumeOutputLastMessage: false,
  });

  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: "",
    stderr: "",
    capture: {
      sawTurnStarted: true,
      sawTurnCompleted: true,
      turnStartedAt: Date.now(),
      lastProgressAt: Date.now(),
      lastOutputAt: Date.now(),
      lastActivityAt: Date.now(),
      lastAgentMessage:
        'I could not inspect every file directly, but here is the best-effort result:\n```json\n{"summary":"Repo overview","details":"The extension routes natural-language requests into task flows."}\n```',
      outputFileReady: false,
      stdoutEventTail: [],
    },
  });

  const result = await provider.startTask(
    {
      taskId: "task-2",
      mode: "analyze",
      prompt: "explain the repo",
      paths: [],
      workspacePath: null,
    },
    noOpCallbacks(),
    new AbortController().signal
  );

  assert.equal(result.summary, "Repo overview");
  assert.match(result.output ?? "", /natural-language requests/i);
  assert.equal(result.providerEvidence?.finalMessageSource, "embedded_json");
  assert.equal(result.providerEvidence?.finalizationPath, "embedded_json");
});

test("CodexCliProvider degrades to option extraction when plan output is non-JSON", async () => {
  const provider = new CodexCliProvider(makeConfig());
  const runtimeSignals: Array<{ code: string; severity: string }> = [];
  stubProviderEnvironment(provider, {
    supportsAskForApproval: false,
    supportsOutputSchema: false,
    supportsOutputLastMessage: false,
    supportsResumeOutputLastMessage: false,
  });

  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: "",
    stderr: "",
    capture: {
      sawTurnStarted: true,
      sawTurnCompleted: true,
      turnStartedAt: Date.now(),
      lastProgressAt: Date.now(),
      lastOutputAt: Date.now(),
      lastActivityAt: Date.now(),
      lastAgentMessage: "Summary: choose a path\nOption A: Fast - Do it quickly\nOption B: Safe - Do it carefully (recommended)",
      outputFileReady: false,
      stdoutEventTail: ["turn.started", "turn.completed"],
    },
  });

  const result = await provider.startTask(
    {
      taskId: "task-3",
      mode: "plan",
      prompt: "give me options",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: { code: string; severity: string }) {
        runtimeSignals.push(signal);
      },
    },
    new AbortController().signal
  );

  assert.equal(result.decision?.options.length, 2);
  assert.equal(result.decision?.recommendedOptionId, "option_b");
  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_PLAN_DEGRADED_OUTPUT"));
});

test("CodexCliProvider plan prompt forbids request_user_input in non-interactive runs", () => {
  const provider = new CodexCliProvider(makeConfig());
  const prompt = (provider as unknown as { buildPlanPrompt: Function }).buildPlanPrompt(
    {
      taskId: "task-plan-prompt",
      mode: "plan",
      prompt: "give me three options",
      paths: [],
      workspacePath: null,
    },
    true
  );

  assert.match(prompt, /request_user_input is unavailable/i);
  assert.match(prompt, /Do not call request_user_input/i);
  assert.match(prompt, /Return the full option set in this response/i);
  assert.match(prompt, /emit a short todo list or progress item before long reasoning/i);
});

test("CodexCliProvider builds a deterministic local workspace snapshot for read-only tasks", async () => {
  const workspacePath = await makeTempDir("clawdrive-provider-snapshot");
  await fs.writeFile(
    path.join(workspacePath, "package.json"),
    JSON.stringify(
      {
        name: "snapshot-test",
        displayName: "Snapshot Test",
        version: "1.2.3",
        main: "./out/extension.js",
        activationEvents: ["onStartupFinished"],
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.mkdir(path.join(workspacePath, "src", "tasks"), { recursive: true });
  await fs.mkdir(path.join(workspacePath, "src", "routing"), { recursive: true });
  await fs.mkdir(path.join(workspacePath, "src", "commands"), { recursive: true });
  await fs.writeFile(path.join(workspacePath, "README.en.md"), "# Snapshot Test\n", "utf8");
  await fs.writeFile(path.join(workspacePath, "src", "tasks", "service.ts"), "export {};\n", "utf8");
  await fs.writeFile(path.join(workspacePath, "src", "routing", "service.ts"), "export {};\n", "utf8");
  await fs.writeFile(path.join(workspacePath, "src", "commands", "registry.ts"), "export {};\n", "utf8");

  const provider = new CodexCliProvider(makeConfig());
  const snapshot = await (provider as unknown as { buildLocalWorkspaceSnapshot: Function }).buildLocalWorkspaceSnapshot({
    taskId: "task-local-context",
    mode: "plan",
    prompt: "analyze the repository",
    paths: [],
    workspacePath,
  });

  assert.ok(snapshot);
  assert.match(snapshot.lines.join("\n"), /Workspace root:/);
  assert.match(snapshot.lines.join("\n"), /Top-level directories: src/);
  assert.match(snapshot.lines.join("\n"), /Top-level files: README\.en\.md, package\.json|Top-level files: package\.json, README\.en\.md/);
  assert.match(snapshot.lines.join("\n"), /package\.json: name=snapshot-test, displayName=Snapshot Test, version=1\.2\.3/);
  assert.match(snapshot.lines.join("\n"), /src\/tasks files: service\.ts/);
  assert.match(snapshot.lines.join("\n"), /src\/routing files: service\.ts/);
  assert.match(snapshot.lines.join("\n"), /src\/commands files: registry\.ts/);
});

test("CodexCliProvider injects deterministic local workspace context into plan prompts", () => {
  const provider = new CodexCliProvider(makeConfig());
  const prompt = (provider as unknown as { buildPlanPrompt: Function }).buildPlanPrompt(
    {
      taskId: "task-plan-local-context",
      mode: "plan",
      prompt: "give me three options",
      paths: [],
      workspacePath: "H:\\workspace\\clawdrive-vscode",
    },
    true,
    {
      lines: ["- Workspace root: H:\\workspace\\clawdrive-vscode", "- Top-level directories: src, docs, test"],
    }
  );

  assert.match(prompt, /Use the deterministic local workspace context below before considering shell exploration/i);
  assert.match(prompt, /Deterministic local workspace context:/);
  assert.match(prompt, /Top-level directories: src, docs, test/);
});

test("CodexCliProvider detects finalization stalls after turn completion", async () => {
  const provider = new CodexCliProvider(makeConfig({ tasksDefaultTimeoutMs: 5_000 }));
  const progress: string[] = [];

  await assert.rejects(
    () =>
      (provider as unknown as { runCommand: Function }).runCommand(
        process.execPath,
        [
          "-e",
          [
            "console.log(JSON.stringify({ type: 'turn.started' }));",
            "console.log(JSON.stringify({ type: 'turn.completed' }));",
            "setTimeout(() => {}, 10_000);",
          ].join(" "),
        ],
        process.cwd(),
        new AbortController().signal,
        true,
        {
          ...noOpCallbacks(),
          onProgress(summary: string) {
            progress.push(summary);
          },
        }
      ),
    (error: unknown) => {
      assert.match(String(error), /no final result arrived before provider finalization timeout/i);
      return true;
    }
  );

  assert.ok(progress.some((entry) => /Finalizing result/i.test(entry)));
});

test("CodexCliProvider resolves after final output even if the child process does not exit cleanly", async () => {
  const provider = new CodexCliProvider(makeConfig({ tasksDefaultTimeoutMs: 5_000 }));
  const result = await (provider as unknown as { runCommand: Function }).runCommand(
    process.execPath,
    [
      "-e",
      [
        "console.log(JSON.stringify({ type: 'turn.started' }));",
        "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{\\\"summary\\\":\\\"Choose\\\",\\\"options\\\":[{\\\"id\\\":\\\"option_a\\\",\\\"title\\\":\\\"A\\\",\\\"summary\\\":\\\"Alpha\\\",\\\"recommended\\\":true},{\\\"id\\\":\\\"option_b\\\",\\\"title\\\":\\\"B\\\",\\\"summary\\\":\\\"Beta\\\",\\\"recommended\\\":false}]}' } }));",
        "console.log(JSON.stringify({ type: 'turn.completed' }));",
        "setTimeout(() => {}, 10_000);",
      ].join(" "),
    ],
    process.cwd(),
    new AbortController().signal,
    true,
    noOpCallbacks()
  );

  assert.match(result.capture.lastAgentMessage ?? "", /\"summary\":\"Choose\"/);
  assert.equal(result.capture.sawTurnCompleted, true);
});

test("CodexCliProvider preserves a captured result even if the child exits non-zero afterward", async () => {
  const provider = new CodexCliProvider(makeConfig({ tasksDefaultTimeoutMs: 12_000 }));
  const runtimeSignals: Array<{ code: string; severity: string; summary: string }> = [];
  const result = await (provider as unknown as { runCommand: Function }).runCommand(
    process.execPath,
    [
      "-e",
      [
        "console.log(JSON.stringify({ type: 'turn.started' }));",
        "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{\\\"summary\\\":\\\"Choose\\\",\\\"options\\\":[{\\\"id\\\":\\\"option_a\\\",\\\"title\\\":\\\"A\\\",\\\"summary\\\":\\\"Alpha\\\",\\\"recommended\\\":true},{\\\"id\\\":\\\"option_b\\\",\\\"title\\\":\\\"B\\\",\\\"summary\\\":\\\"Beta\\\",\\\"recommended\\\":false}]}' } }));",
        "console.log(JSON.stringify({ type: 'turn.completed' }));",
        "setTimeout(() => { console.error('late plugin error after final result'); process.exit(1); }, 100);",
      ].join(" "),
    ],
    process.cwd(),
    new AbortController().signal,
    true,
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: { code: string; severity: string; summary: string }) {
        runtimeSignals.push(signal);
      },
    }
  );

  assert.match(result.capture.lastAgentMessage ?? "", /\"summary\":\"Choose\"/);
  assert.equal(result.capture.sawTurnCompleted, true);
  assert.ok(!runtimeSignals.some((signal) => signal.code === "PROVIDER_RUNTIME_STDERR"));
});

test("CodexCliProvider emits a degraded stall signal before failing long-running silent turns", async () => {
  const provider = new CodexCliProvider(makeConfig({ tasksDefaultTimeoutMs: 12_000 }));
  const runtimeSignals: Array<{ code: string; severity: string; summary: string }> = [];
  const progress: string[] = [];

  await assert.rejects(
    () =>
      (provider as unknown as { runCommand: Function }).runCommand(
        process.execPath,
        [
          "-e",
          [
            "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }));",
            "console.log(JSON.stringify({ type: 'turn.started' }));",
            "setTimeout(() => {}, 20_000);",
          ].join(" "),
        ],
        process.cwd(),
        new AbortController().signal,
        true,
        {
          ...noOpCallbacks(),
          onProgress(summary: string) {
            progress.push(summary);
          },
          onRuntimeSignal(signal: { code: string; severity: string; summary: string }) {
            runtimeSignals.push(signal);
          },
        }
      ),
    (error: unknown) => {
      assert.match(String(error), /stalled after turn start without producing a usable result/i);
      return true;
    }
  );

  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_RESULT_STALL_WARNING" && signal.severity === "degraded"));
  assert.ok(progress.some((entry) => /appears stalled/i.test(entry)));
});

test("CodexCliProvider keeps running when transport warnings appear but output later arrives", async () => {
  const provider = new CodexCliProvider(makeConfig({ tasksDefaultTimeoutMs: 12_000 }));
  const runtimeSignals: Array<{ code: string; severity: string; summary: string }> = [];

  const result = await (provider as unknown as { runCommand: Function }).runCommand(
    process.execPath,
    [
      "-e",
      [
        "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }));",
        "console.log(JSON.stringify({ type: 'turn.started' }));",
        "setTimeout(() => console.error('worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some(\"missing-content-type; body: \"))'), 250);",
        "setTimeout(() => console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{\\\"summary\\\":\\\"Choose\\\",\\\"options\\\":[{\\\"id\\\":\\\"option_a\\\",\\\"title\\\":\\\"A\\\",\\\"summary\\\":\\\"Alpha\\\",\\\"recommended\\\":true},{\\\"id\\\":\\\"option_b\\\",\\\"title\\\":\\\"B\\\",\\\"summary\\\":\\\"Beta\\\",\\\"recommended\\\":false}]}' } })), 3500);",
        "setTimeout(() => console.log(JSON.stringify({ type: 'turn.completed' })), 3600);",
        "setTimeout(() => {}, 10000);",
      ].join(" "),
    ],
    process.cwd(),
    new AbortController().signal,
    true,
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: { code: string; severity: string; summary: string }) {
        runtimeSignals.push(signal);
      },
    }
  );

  assert.match(result.capture.lastAgentMessage ?? "", /\"summary\":\"Choose\"/);
  assert.equal(result.capture.sawTurnCompleted, true);
  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_TRANSPORT_RUNTIME_WARNING"));
});

test("CodexCliProvider fails early when transport warnings happen before the provider turn starts", async () => {
  const provider = new CodexCliProvider(makeConfig({ tasksDefaultTimeoutMs: 12_000 }));
  const startedAt = Date.now();

  await assert.rejects(
    () =>
      (provider as unknown as { runCommand: Function }).runCommand(
        process.execPath,
        [
          "-e",
          [
            "setTimeout(() => console.error('worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some(\"missing-content-type; body: \"))'), 250);",
            "setTimeout(() => {}, 20_000);",
          ].join(" "),
        ],
        process.cwd(),
        new AbortController().signal,
        true,
        noOpCallbacks()
      ),
    (error: unknown) => {
      assert.match(String(error), /UnexpectedContentType|missing-content-type/i);
      return true;
    }
  );

  assert.ok(Date.now() - startedAt < 6_000);
});

test("CodexCliProvider fails turn-started tasks early when transport keeps breaking without recovery", async () => {
  const provider = new CodexCliProvider(makeConfig({ tasksDefaultTimeoutMs: 12_000 }));
  const runtimeSignals: Array<{ code: string; severity: string; summary: string }> = [];
  const startedAt = Date.now();

  await assert.rejects(
    () =>
      (provider as unknown as { runCommand: Function }).runCommand(
        process.execPath,
        [
          "-e",
          [
            "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }));",
            "console.log(JSON.stringify({ type: 'turn.started' }));",
            "setInterval(() => console.error('worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some(\"missing-content-type; body: \"))'), 250);",
            "setTimeout(() => {}, 20_000);",
          ].join(" "),
        ],
        process.cwd(),
        new AbortController().signal,
        true,
        {
          ...noOpCallbacks(),
          onRuntimeSignal(signal: { code: string; severity: string; summary: string }) {
            runtimeSignals.push(signal);
          },
        }
      ),
    (error: unknown) => {
      assert.match(String(error), /Transport channel closed|missing-content-type/i);
      return true;
    }
  );

  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_TRANSPORT_RUNTIME_WARNING"));
  assert.ok(Date.now() - startedAt >= 4_000);
  assert.ok(Date.now() - startedAt < 12_000);
});

test("CodexCliProvider does not treat post-turn item activity as semantic recovery after a transport warning", async () => {
  const provider = new CodexCliProvider(makeConfig({ tasksDefaultTimeoutMs: 12_000 }));
  const runtimeSignals: Array<{ code: string; severity: string; summary: string }> = [];
  const startedAt = Date.now();

  await assert.rejects(
    () =>
      (provider as unknown as { runCommand: Function }).runCommand(
        process.execPath,
        [
          "-e",
          [
            "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }));",
            "console.log(JSON.stringify({ type: 'turn.started' }));",
            "setTimeout(() => console.error('worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some(\"missing-content-type; body: \"))'), 250);",
            "setInterval(() => console.log(JSON.stringify({ type: 'item.updated', item: { type: 'todo_list' } })), 750);",
            "setTimeout(() => {}, 20_000);",
          ].join(" "),
        ],
        process.cwd(),
        new AbortController().signal,
        true,
        {
          ...noOpCallbacks(),
          onRuntimeSignal(signal: { code: string; severity: string; summary: string }) {
            runtimeSignals.push(signal);
          },
        }
      ),
    (error: unknown) => {
      assert.match(String(error), /Transport channel closed|missing-content-type/i);
      return true;
    }
  );

  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_TRANSPORT_RUNTIME_WARNING"));
  assert.ok(Date.now() - startedAt >= 4_000);
  assert.ok(Date.now() - startedAt < 12_000);
});

test("CodexCliProvider fails turn-started tasks early on transport fallback body-decode errors", async () => {
  const provider = new CodexCliProvider(makeConfig({ tasksDefaultTimeoutMs: 30_000 }));
  const runtimeSignals: Array<{ code: string; severity: string; summary: string }> = [];
  const startedAt = Date.now();

  await assert.rejects(
    () =>
      (provider as unknown as { runCommand: Function }).runCommand(
        process.execPath,
        [
          "-e",
          [
            "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }));",
            "console.log(JSON.stringify({ type: 'turn.started' }));",
            "setTimeout(() => console.error('Reconnecting... 1/5 (stream disconnected before completion: Transport error: network error: error decoding response body)'), 250);",
            "setTimeout(() => {}, 20_000);",
          ].join(" "),
        ],
        process.cwd(),
        new AbortController().signal,
        true,
        {
          ...noOpCallbacks(),
          onRuntimeSignal(signal: { code: string; severity: string; summary: string }) {
            runtimeSignals.push(signal);
          },
        }
      ),
    (error: unknown) => {
      assert.match(String(error), /stream disconnected before completion|error decoding response body/i);
      return true;
    }
  );

  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_TRANSPORT_FALLBACK"));
  assert.ok(Date.now() - startedAt >= 4_000);
  assert.ok(Date.now() - startedAt < 12_000);
});

test("CodexCliProvider fails early on stream-closed transport fallback warnings", async () => {
  const provider = new CodexCliProvider(makeConfig({ tasksDefaultTimeoutMs: 16_000 }));
  const runtimeSignals: Array<{ code: string; severity: string; summary: string }> = [];
  const startedAt = Date.now();

  await assert.rejects(
    () =>
      (provider as unknown as { runCommand: Function }).runCommand(
        process.execPath,
        [
          "-e",
          [
            "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }));",
            "console.log(JSON.stringify({ type: 'turn.started' }));",
            "setTimeout(() => console.error('Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)'), 250);",
            "setTimeout(() => {}, 20_000);",
          ].join(" "),
        ],
        process.cwd(),
        new AbortController().signal,
        true,
        {
          ...noOpCallbacks(),
          onRuntimeSignal(signal: { code: string; severity: string; summary: string }) {
            runtimeSignals.push(signal);
          },
        }
      ),
    (error: unknown) => {
      assert.match(String(error), /stream disconnected before completion|response\.completed/i);
      assert.doesNotMatch(String(error), /turn did not complete/i);
      return true;
    }
  );

  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_TRANSPORT_FALLBACK"));
  assert.ok(Date.now() - startedAt >= 4_000);
  assert.ok(Date.now() - startedAt < 12_000);
});

test("CodexCliProvider gives quiet plan turns extra time before warning", async () => {
  const provider = new CodexCliProvider(makeConfig({ tasksDefaultTimeoutMs: 24_000 }));
  const runtimeSignals: Array<{ code: string; severity: string; summary: string }> = [];

  const result = await (provider as unknown as { runCommand: Function }).runCommand(
    process.execPath,
    [
      "-e",
      [
        "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }));",
        "console.log(JSON.stringify({ type: 'turn.started' }));",
        "setTimeout(() => console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{\\\"summary\\\":\\\"Choose\\\",\\\"options\\\":[{\\\"id\\\":\\\"option_a\\\",\\\"title\\\":\\\"A\\\",\\\"summary\\\":\\\"Alpha\\\",\\\"recommended\\\":true},{\\\"id\\\":\\\"option_b\\\",\\\"title\\\":\\\"B\\\",\\\"summary\\\":\\\"Beta\\\",\\\"recommended\\\":false}]}' } })), 5700);",
        "setTimeout(() => console.log(JSON.stringify({ type: 'turn.completed' })), 5800);",
        "setTimeout(() => {}, 10000);",
      ].join(" "),
    ],
    process.cwd(),
    new AbortController().signal,
    true,
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: { code: string; severity: string; summary: string }) {
        runtimeSignals.push(signal);
      },
    },
    undefined,
    undefined,
    "plan"
  );

  assert.match(result.capture.lastAgentMessage ?? "", /\"summary\":\"Choose\"/);
  assert.equal(result.capture.sawTurnCompleted, true);
  assert.ok(!runtimeSignals.some((signal) => signal.code === "PROVIDER_RESULT_STALL_WARNING"));
});

test("CodexCliProvider gives quiet plan turns extra time before turn-completion failure", async () => {
  const provider = new CodexCliProvider(makeConfig({ tasksDefaultTimeoutMs: 24_000 }));

  const result = await (provider as unknown as { runCommand: Function }).runCommand(
    process.execPath,
    [
      "-e",
      [
        "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }));",
        "console.log(JSON.stringify({ type: 'turn.started' }));",
        "setTimeout(() => console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{\\\"summary\\\":\\\"Choose\\\",\\\"options\\\":[{\\\"id\\\":\\\"option_a\\\",\\\"title\\\":\\\"A\\\",\\\"summary\\\":\\\"Alpha\\\",\\\"recommended\\\":true},{\\\"id\\\":\\\"option_b\\\",\\\"title\\\":\\\"B\\\",\\\"summary\\\":\\\"Beta\\\",\\\"recommended\\\":false}]}' } })), 16200);",
        "setTimeout(() => console.log(JSON.stringify({ type: 'turn.completed' })), 16300);",
        "setTimeout(() => {}, 20000);",
      ].join(" "),
    ],
    process.cwd(),
    new AbortController().signal,
    true,
    noOpCallbacks(),
    undefined,
    undefined,
    "plan"
  );

  assert.match(result.capture.lastAgentMessage ?? "", /\"summary\":\"Choose\"/);
  assert.equal(result.capture.sawTurnCompleted, true);
});

test("CodexCliProvider does not emit an early stall warning when active plan work resumes within the extended budget", async () => {
  const provider = new CodexCliProvider(makeConfig({ tasksDefaultTimeoutMs: 24_000 }));
  const runtimeSignals: Array<{ code: string; severity: string; summary: string }> = [];

  const result = await (provider as unknown as { runCommand: Function }).runCommand(
    process.execPath,
    [
      "-e",
      [
        "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }));",
        "console.log(JSON.stringify({ type: 'turn.started' }));",
        "setTimeout(() => console.log(JSON.stringify({ type: 'item.started', item: { id: 'item_0', type: 'todo_list', items: [{ text: 'Inspect files', completed: false }] } })), 250);",
        "setTimeout(() => console.log(JSON.stringify({ type: 'item.updated', item: { id: 'item_0', type: 'todo_list', items: [{ text: 'Inspect files', completed: true }] } })), 5500);",
        "setTimeout(() => console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{\\\"summary\\\":\\\"Choose\\\",\\\"options\\\":[{\\\"id\\\":\\\"option_a\\\",\\\"title\\\":\\\"A\\\",\\\"summary\\\":\\\"Alpha\\\",\\\"recommended\\\":true},{\\\"id\\\":\\\"option_b\\\",\\\"title\\\":\\\"B\\\",\\\"summary\\\":\\\"Beta\\\",\\\"recommended\\\":false}]}' } })), 5700);",
        "setTimeout(() => console.log(JSON.stringify({ type: 'turn.completed' })), 5800);",
        "setTimeout(() => {}, 10000);",
      ].join(" "),
    ],
    process.cwd(),
    new AbortController().signal,
    true,
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: { code: string; severity: string; summary: string }) {
        runtimeSignals.push(signal);
      },
    }
  );

  assert.match(result.capture.lastAgentMessage ?? "", /\"summary\":\"Choose\"/);
  assert.equal(result.capture.sawTurnCompleted, true);
  assert.ok(!runtimeSignals.some((signal) => signal.code === "PROVIDER_RESULT_STALL_WARNING"));
});

test("CodexCliProvider derives an extended task home with sanitized config", async () => {
  const sourceHome = await makeTempDir("clawdrive-codex-source-home");
  const originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = sourceHome;

  try {
    await fs.writeFile(
      path.join(sourceHome, "config.toml"),
      [
        'model_provider = "proxy"',
        'model = "gpt-5.4"',
        "",
        "[features]",
        "rmcp_client = true",
        "multi_agent = true",
        "",
        "[mcp_servers.unityMCP]",
        'url = "http://127.0.0.1:8080/mcp"',
        "",
        "[model_providers.proxy]",
        'name = "MyCodex"',
        'base_url = "https://robot2.indevs.in/v1"',
        "",
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(path.join(sourceHome, "auth.json"), '{"token":"x"}', "utf8");

    const provider = new CodexCliProvider(makeConfig({ providerPolicyLevel: "extended" }));
    const env = await (provider as unknown as { prepareCodexEnvironment: Function }).prepareCodexEnvironment();
    const taskHome = String(env.CODEX_HOME ?? "");
    const sanitizedConfig = await fs.readFile(path.join(taskHome, "config.toml"), "utf8");
    const copiedAuth = await fs.readFile(path.join(taskHome, "auth.json"), "utf8");

    assert.notEqual(taskHome, sourceHome);
    assert.match(taskHome, /codex-home-extended/i);
    assert.match(sanitizedConfig, /model_provider = "proxy"/);
    assert.doesNotMatch(sanitizedConfig, /\[features\]/i);
    assert.doesNotMatch(sanitizedConfig, /\[mcp_servers\.unityMCP\]/i);
    assert.equal(copiedAuth, '{"token":"x"}');
  } finally {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
  }
});

test("CodexCliProvider raw policy reuses the source CODEX_HOME directly", async () => {
  const sourceHome = await makeTempDir("clawdrive-codex-raw-home");
  const originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = sourceHome;

  try {
    await fs.writeFile(
      path.join(sourceHome, "config.toml"),
      [
        'model_provider = "proxy"',
        "",
        "[features]",
        "multi_agent = true",
        "",
        "[mcp_servers.unityMCP]",
        'url = "http://127.0.0.1:8080/mcp"',
        "",
      ].join("\n"),
      "utf8"
    );

    const provider = new CodexCliProvider(
      makeConfig({
        providerPolicyLevel: "raw",
        providerDisableFeatures: [],
      })
    );
    const env = await (provider as unknown as { prepareCodexEnvironment: Function }).prepareCodexEnvironment();

    assert.equal(String(env.CODEX_HOME ?? ""), sourceHome);
    const preservedConfig = await fs.readFile(path.join(sourceHome, "config.toml"), "utf8");
    assert.match(preservedConfig, /\[features\]/i);
    assert.match(preservedConfig, /\[mcp_servers\.unityMCP\]/i);
  } finally {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
  }
});

function stubProviderEnvironment(
  provider: CodexCliProvider,
  capabilities: {
    supportsAskForApproval: boolean;
    supportsOutputSchema: boolean;
    supportsOutputLastMessage: boolean;
    supportsResumeOutputLastMessage: boolean;
  }
): void {
  (provider as unknown as { resolveExecutable: Function }).resolveExecutable = async () => "codex";
  (provider as unknown as { prepareCodexEnvironment: Function }).prepareCodexEnvironment = async () => process.env;
  (provider as unknown as { getCapabilities: Function }).getCapabilities = async () => capabilities;
  (provider as unknown as { removeTempFile: Function }).removeTempFile = async () => undefined;
}

function noOpCallbacks() {
  return {
    onSessionId() {
      return undefined;
    },
    onProgress() {
      return undefined;
    },
    onOutput() {
      return undefined;
    },
    onRuntimeSignal() {
      return undefined;
    },
    onEvidence() {
      return undefined;
    },
  };
}
