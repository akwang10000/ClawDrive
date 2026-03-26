import test from "node:test";
import assert from "node:assert/strict";
import { CodexCliProvider } from "../../src/tasks/codex-provider";
import { makeConfig } from "../test-utils";

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
      lastProgressAt: Date.now(),
      lastOutputAt: Date.now(),
      lastActivityAt: Date.now(),
      lastAgentMessage:
        '{"summary":"Choose a path.","options":[{"id":"option_a","title":"Fast path","summary":"Do the fast thing.","recommended":true},{"id":"option_b","title":"Safe path","summary":"Do the safe thing.","recommended":false}]}',
    },
  });
  (provider as unknown as { readOutputMessage: Function }).readOutputMessage = async () => ({
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
      lastProgressAt: Date.now(),
      lastOutputAt: Date.now(),
      lastActivityAt: Date.now(),
      lastAgentMessage:
        'I could not inspect every file directly, but here is the best-effort result:\n```json\n{"summary":"Repo overview","details":"The extension routes natural-language requests into task flows."}\n```',
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
