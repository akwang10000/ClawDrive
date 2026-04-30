import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as path from "path";
import { ClaudeCliProvider } from "../../src/tasks/claude-provider";
import { makeConfig, makeTempDir } from "../test-utils";

test("ClaudeCliProvider parses analyze payload from Claude JSON envelope", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "session-1",
      result: '{"summary":"Repo overview","details":"The extension routes tasks through provider-backed execution."}',
    }),
    stderr: "",
    exitCode: 0,
  });

  let capturedSessionId: string | null = null;
  const result = await provider.startTask(
    {
      taskId: "task-analyze",
      mode: "analyze",
      prompt: "Explain the repo",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onSessionId(value: string) {
        capturedSessionId = value;
      },
    },
    new AbortController().signal
  );

  assert.equal(capturedSessionId, "session-1");
  assert.equal(result.sessionId, "session-1");
  assert.equal(result.summary, "Repo overview");
  assert.match(result.output ?? "", /provider-backed execution/i);
  assert.equal(result.providerEvidence?.finalMessageSource, "direct_message");
});

test("ClaudeCliProvider parses analyze payload from embedded JSON in a Claude result envelope", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const nestedEnvelope = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({
      summary: "Repo overview",
      details: "The extension routes natural-language requests into task flows.",
    }),
  });

  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "session-embedded",
      result: ["Best-effort result follows.", "```json", nestedEnvelope, "```"].join("\n"),
    }),
    stderr: "",
    exitCode: 0,
  });

  let capturedSessionId: string | null = null;
  const result = await provider.startTask(
    {
      taskId: "task-analyze-embedded",
      mode: "analyze",
      prompt: "Explain the repo",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onSessionId(value: string) {
        capturedSessionId = value;
      },
    },
    new AbortController().signal
  );

  assert.equal(capturedSessionId, "session-embedded");
  assert.equal(result.sessionId, "session-embedded");
  assert.equal(result.summary, "Repo overview");
  assert.match(result.output ?? "", /natural-language requests/i);
  assert.equal(result.providerEvidence?.finalMessageSource, "embedded_json");
  assert.equal(result.providerEvidence?.finalizationPath, "embedded_json");
});

test("ClaudeCliProvider parses analyze output from Claude structured_output envelope without degrading", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const runtimeSignals: Array<{ code: string; severity: string; summary: string }> = [];
  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: buildEmbeddedClaudeEnvelope(
      {
        result: "Short answer.",
        structured_output: {
          summary: "Repo overview",
          details: "The extension is organized around routing, tasks, and provider execution.",
        },
      },
      "session-structured-output"
    ),
    stderr: "",
    exitCode: 0,
  });

  const result = await provider.startTask(
    {
      taskId: "task-analyze-structured-output",
      mode: "analyze",
      prompt: "Explain the repo",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: { code: string; severity: string; summary: string }) {
        runtimeSignals.push(signal);
      },
    },
    new AbortController().signal
  );

  assert.equal(result.summary, "Repo overview");
  assert.match(result.output ?? "", /routing, tasks, and provider execution/i);
  assert.equal(result.providerEvidence?.finalMessageSource, "embedded_json");
  assert.equal(result.providerEvidence?.finalizationPath, "embedded_json");
  assert.ok(!runtimeSignals.some((signal) => signal.code === "PROVIDER_ANALYZE_DEGRADED_OUTPUT"));
});

test("ClaudeCliProvider preserves a usable analyze payload when stderr reports late noise", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const runtimeSignals: Array<{ code: string; severity: string; summary: string }> = [];
  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "session-late-noise",
      result: '{"summary":"Repo overview","details":"Provider finalization completed with a usable payload."}',
    }),
    stderr: "WARN late provider cleanup message after result\n",
    exitCode: 0,
  });

  const result = await provider.startTask(
    {
      taskId: "task-analyze-late-noise",
      mode: "analyze",
      prompt: "Explain provider finalization",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: { code: string; severity: string; summary: string }) {
        runtimeSignals.push(signal);
      },
    },
    new AbortController().signal
  );

  assert.equal(result.summary, "Repo overview");
  assert.match(result.output ?? "", /usable payload/i);
  assert.equal(result.sessionId, "session-late-noise");
  assert.equal(result.providerEvidence?.finalMessageSource, "direct_message");
  assert.ok(!runtimeSignals.some((signal) => signal.severity === "fatal"));
});


test("ClaudeCliProvider parses plan payload from embedded JSON in a Claude result envelope", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: buildEmbeddedClaudeEnvelope(
      {
        summary: "Choose an implementation path.",
        options: [
          { id: "option_a", title: "Fast", summary: "Patch the current flow.", recommended: true },
          { id: "option_b", title: "Safe", summary: "Refactor before patching.", recommended: false },
        ],
      },
      "session-plan-embedded"
    ),
    stderr: "",
    exitCode: 0,
  });

  let capturedSessionId: string | null = null;
  const result = await provider.startTask(
    {
      taskId: "task-plan-embedded",
      mode: "plan",
      prompt: "Plan the implementation",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onSessionId(value: string) {
        capturedSessionId = value;
      },
    },
    new AbortController().signal
  );

  assert.equal(capturedSessionId, "session-plan-embedded");
  assert.equal(result.sessionId, "session-plan-embedded");
  assert.equal(result.summary, "Choose an implementation path.");
  assert.equal(result.decision?.recommendedOptionId, "option_a");
  assert.equal(result.decision?.options.length, 2);
  assert.equal(result.providerEvidence?.finalMessageSource, "embedded_json");
  assert.equal(result.providerEvidence?.finalizationPath, "embedded_json");
});


test("ClaudeCliProvider reads plan summary and options from nested structured_output in direct JSON", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: JSON.stringify({
      message: "Outer readable text that should not be required for plan normalization.",
      structured_output: {
        summary: "Choose a task hardening path.",
        options: [
          { id: "option_a", title: "Provider path", summary: "Trace provider finalization.", recommended: true },
          { id: "option_b", title: "Routing path", summary: "Audit route classification.", recommended: false },
        ],
      },
      session_id: "session-plan-structured-direct",
    }),
    stderr: "",
    exitCode: 0,
  });

  const result = await provider.startTask(
    {
      taskId: "task-plan-structured-direct",
      mode: "plan",
      prompt: "Plan the implementation",
      paths: [],
      workspacePath: null,
    },
    noOpCallbacks(),
    new AbortController().signal
  );

  assert.equal(result.sessionId, "session-plan-structured-direct");
  assert.equal(result.summary, "Choose a task hardening path.");
  assert.equal(result.decision?.recommendedOptionId, "option_a");
  assert.equal(result.decision?.options.length, 2);
});

test("ClaudeCliProvider reads plan summary and options from nested structured_output in an embedded envelope", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: buildEmbeddedClaudeEnvelope(
      {
        result: "Readable outer text before the nested plan payload.",
        structured_output: {
          summary: "Choose an investigation path.",
          options: [
            { id: "option_a", title: "Task path", summary: "Inspect task service and provider flow.", recommended: true },
            { id: "option_b", title: "UI path", summary: "Inspect settings panel and diagnostics.", recommended: false },
          ],
        },
      },
      "session-plan-structured-embedded"
    ),
    stderr: "",
    exitCode: 0,
  });

  const result = await provider.startTask(
    {
      taskId: "task-plan-structured-embedded",
      mode: "plan",
      prompt: "Plan the implementation",
      paths: [],
      workspacePath: null,
    },
    noOpCallbacks(),
    new AbortController().signal
  );

  assert.equal(result.sessionId, "session-plan-structured-embedded");
  assert.equal(result.summary, "Choose an investigation path.");
  assert.equal(result.decision?.recommendedOptionId, "option_a");
  assert.equal(result.providerEvidence?.finalMessageSource, "embedded_json");
});

test("ClaudeCliProvider salvages plan when root fields are malformed but nested structured_output is usable", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: JSON.stringify({
      summary: { text: "bad-root-summary" },
      options: [{ id: "option_a", title: "Broken root option" }],
      structured_output: {
        summary: "Choose the safer provider investigation.",
        options: [
          { id: "option_a", title: "Provider trace", summary: "Trace finalization and salvage logic.", recommended: true },
          { id: "option_b", title: "Fallback audit", summary: "Audit text salvage and readonly fallback.", recommended: false },
        ],
      },
      session_id: "session-plan-structured-salvage",
    }),
    stderr: "",
    exitCode: 0,
  });

  const result = await provider.startTask(
    {
      taskId: "task-plan-structured-salvage",
      mode: "plan",
      prompt: "Plan the implementation",
      paths: [],
      workspacePath: null,
    },
    noOpCallbacks(),
    new AbortController().signal
  );

  assert.equal(result.sessionId, "session-plan-structured-salvage");
  assert.equal(result.summary, "Choose the safer provider investigation.");
  assert.equal(result.decision?.recommendedOptionId, "option_a");
  assert.equal(result.decision?.options.length, 2);
});

test("ClaudeCliProvider preserves provider evidence when apply returns an error envelope", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      session_id: "session-apply-error",
      result: "Claude returned an error result.",
    }),
    stderr: "",
    exitCode: 0,
  });

  let capturedSessionId: string | null = null;
  const evidenceEvents: Array<Record<string, unknown>> = [];

  await assert.rejects(
    () =>
      provider.startTask(
        {
          taskId: "task-apply-error",
          mode: "apply",
          prompt: "Implement Claude support",
          paths: [],
          workspacePath: null,
        },
        {
          ...noOpCallbacks(),
          onSessionId(value: string) {
            capturedSessionId = value;
          },
          onEvidence(evidence: Record<string, unknown>) {
            evidenceEvents.push(evidence);
          },
        },
        new AbortController().signal
      ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "PROVIDER_EXECUTION_FAILED");
      assert.match(String((error as Error).message), /error|Claude returned an error result/i);
      return true;
    }
  );

  assert.equal(capturedSessionId, "session-apply-error");
  assert.ok(evidenceEvents.some((event) => event.sawTurnStarted === true));
  assert.ok(
    evidenceEvents.some(
      (event) =>
        event.sawTurnCompleted === true &&
        event.finalMessageSource === "direct_message" &&
        event.finalizationPath === "stream_capture" &&
        typeof event.lastAgentMessagePreview === "string"
    )
  );
});


test("ClaudeCliProvider prefers API error detail over misleading success subtype in error envelopes", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      session_id: "session-apply-error-api-detail",
      result: "API Error: 400 {\"error\":{\"message\":\"Invalid schema for function 'StructuredOutputJsonSchema'\"}}",
    }),
    stderr: "",
    exitCode: 0,
  });

  await assert.rejects(
    () =>
      provider.startTask(
        {
          taskId: "task-apply-error-api-detail",
          mode: "apply",
          prompt: "Implement Claude support",
          paths: [],
          workspacePath: null,
        },
        noOpCallbacks(),
        new AbortController().signal
      ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "PROVIDER_OUTPUT_INVALID");
      assert.match(String((error as Error).message), /api error: 400/i);
      assert.doesNotMatch(String((error as Error).message), /^success$/i);
      return true;
    }
  );
});


test("ClaudeCliProvider surfaces structured-output retry exhaustion from apply error envelopes", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const seenArgs: string[][] = [];
  const runtimeSignals: Array<Record<string, unknown>> = [];
  (provider as unknown as { runCommand: Function }).runCommand = async (
    _executable: string,
    args: string[]
  ) => {
    seenArgs.push(args);
    if (seenArgs.length === 1) {
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "error_max_structured_output_retries",
          is_error: true,
          session_id: "session-apply-structured-error",
          result: "Claude returned an error result.",
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    return {
      stdout: buildEmbeddedClaudeEnvelope(
        {
          stage: "decision",
          summary: "Choose an implementation path.",
          options: [
            { id: "option_a", title: "Fast", summary: "Patch the current flow.", recommended: true },
            { id: "option_b", title: "Safe", summary: "Refactor before patching.", recommended: false },
          ],
        },
        "session-apply-structured-error-retry"
      ),
      stderr: "",
      exitCode: 0,
    };
  };

  const result = await provider.startTask(
    {
      taskId: "task-apply-structured-error",
      mode: "apply",
      prompt: "Implement Claude support",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: Record<string, unknown>) {
        runtimeSignals.push(signal);
      },
    },
    new AbortController().signal
  );

  assert.equal(seenArgs.length, 2);
  assert.equal(result.decision?.recommendedOptionId, "option_a");
  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_APPLY_SCHEMA_RETRY"));
});

test("ClaudeCliProvider retries apply when live error envelopes only surface structured-output subtype via evidence extraction", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const seenArgs: string[][] = [];
  const runtimeSignals: Array<Record<string, unknown>> = [];
  (provider as unknown as { runCommand: Function }).runCommand = async (_executable: string, args: string[]) => {
    seenArgs.push(args);
    if (seenArgs.length === 1) {
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "error_max_structured_output_retries",
          is_error: true,
          session_id: "session-apply-live-envelope",
          result: "Claude returned an error result.",
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    return {
      stdout: buildEmbeddedClaudeEnvelope(
        {
          stage: "decision",
          summary: "Choose an implementation path.",
          options: [
            { id: "option_a", title: "Fast", summary: "Patch the current flow.", recommended: true },
            { id: "option_b", title: "Safe", summary: "Refactor before patching.", recommended: false },
          ],
        },
        "session-apply-live-envelope-retry"
      ),
      stderr: "",
      exitCode: 0,
    };
  };

  const result = await provider.startTask(
    {
      taskId: "task-apply-live-envelope",
      mode: "apply",
      prompt: "Implement Claude support",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: Record<string, unknown>) {
        runtimeSignals.push(signal);
      },
    },
    new AbortController().signal
  );

  assert.equal(seenArgs.length, 2);
  assert.equal(result.decision?.recommendedOptionId, "option_a");
  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_APPLY_SCHEMA_RETRY"));
});



test("ClaudeCliProvider preserves apply decision session IDs from direct JSON results", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  let capturedSessionId: string | null = null;
  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: JSON.stringify({
      session_id: "session-apply-direct-json",
      stage: "decision",
      summary: "Choose an implementation path.",
      options: [
        { id: "option_a", title: "Fast", summary: "Patch the current flow.", recommended: true },
        { id: "option_b", title: "Safe", summary: "Refactor before patching.", recommended: false },
      ],
    }),
    stderr: "",
    exitCode: 0,
  });

  const result = await provider.startTask(
    {
      taskId: "task-apply-decision-direct-json",
      mode: "apply",
      prompt: "Implement Claude support",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onSessionId(value: string) {
        capturedSessionId = value;
      },
    },
    new AbortController().signal
  );

  assert.equal(capturedSessionId, "session-apply-direct-json");
  assert.equal(result.sessionId, "session-apply-direct-json");
  assert.equal(result.decision?.recommendedOptionId, "option_a");
});

test("ClaudeCliProvider preserves apply decision session IDs from embedded JSON in a Claude result envelope", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: buildEmbeddedClaudeEnvelope(
      {
        stage: "decision",
        summary: "Choose an implementation path.",
        options: [
          { id: "option_a", title: "Fast", summary: "Patch the current flow.", recommended: true },
          { id: "option_b", title: "Safe", summary: "Refactor before patching.", recommended: false },
        ],
      },
      "session-apply-decision"
    ),
    stderr: "",
    exitCode: 0,
  });

  let capturedSessionId: string | null = null;
  const result = await provider.startTask(
    {
      taskId: "task-apply-decision-embedded",
      mode: "apply",
      prompt: "Implement Claude support",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onSessionId(value: string) {
        capturedSessionId = value;
      },
    },
    new AbortController().signal
  );

  assert.equal(capturedSessionId, "session-apply-decision");
  assert.equal(result.sessionId, "session-apply-decision");
  assert.equal(result.summary, "Choose an implementation path.");
  assert.equal(result.decision?.recommendedOptionId, "option_a");
  assert.equal(result.decision?.options.length, 2);
  assert.equal(result.providerEvidence?.finalMessageSource, "embedded_json");
  assert.equal(result.providerEvidence?.finalizationPath, "embedded_json");
});


test("ClaudeCliProvider preserves retried apply session IDs from direct JSON results", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const seenArgs: string[][] = [];
  let capturedSessionId: string | null = null;
  (provider as unknown as { runCommand: Function }).runCommand = async (_executable: string, args: string[]) => {
    seenArgs.push(args);
    if (seenArgs.length === 1) {
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "error_max_structured_output_retries",
          is_error: true,
          session_id: "session-apply-direct-json-error",
          result: "Claude returned an error result.",
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    return {
      stdout: JSON.stringify({
        session_id: "session-apply-direct-json-retry",
        stage: "decision",
        summary: "Choose an implementation path.",
        options: [
          { id: "option_a", title: "Fast", summary: "Patch the current flow.", recommended: true },
          { id: "option_b", title: "Safe", summary: "Refactor before patching.", recommended: false },
        ],
      }),
      stderr: "",
      exitCode: 0,
    };
  };

  const result = await provider.startTask(
    {
      taskId: "task-apply-direct-json-retry",
      mode: "apply",
      prompt: "Implement Claude support",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onSessionId(value: string) {
        capturedSessionId = value;
      },
    },
    new AbortController().signal
  );

  assert.equal(seenArgs.length, 2);
  assert.equal(capturedSessionId, "session-apply-direct-json-retry");
  assert.equal(result.sessionId, "session-apply-direct-json-retry");
  assert.equal(result.decision?.recommendedOptionId, "option_a");
});

test("ClaudeCliProvider parses apply approval payload from embedded JSON in a Claude result envelope", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: buildEmbeddedClaudeEnvelope(
      {
        stage: "approval",
        summary: "Apply the approved changes.",
        operations: [
          { type: "write_file", path: "src/example.ts", content: "export const value = 1;\n" },
          { type: "replace_text", path: "src/other.ts", oldText: "before", newText: "after" },
        ],
      },
      "session-apply-approval"
    ),
    stderr: "",
    exitCode: 0,
  });

  const result = await provider.startTask(
    {
      taskId: "task-apply-approval-embedded",
      mode: "apply",
      prompt: "Implement Claude support",
      paths: [],
      workspacePath: null,
    },
    noOpCallbacks(),
    new AbortController().signal
  );

  assert.equal(result.summary, "Apply the approved changes.");
  assert.equal(result.approval?.operations.length, 2);
  assert.equal(result.approval?.operations[0]?.type, "write_file");
  assert.equal(result.approval?.operations[1]?.type, "replace_text");
  assert.equal(result.providerEvidence?.finalMessageSource, "embedded_json");
  assert.equal(result.providerEvidence?.finalizationPath, "embedded_json");
});


test("ClaudeCliProvider accepts snake_case replace_text approval fields", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: buildEmbeddedClaudeEnvelope(
      {
        stage: "approval",
        summary: "Apply the approved changes.",
        operations: [
          { type: "replace_text", path: "src/other.ts", old_text: "before", new_text: "after" },
        ],
      },
      "session-apply-approval-snake-case"
    ),
    stderr: "",
    exitCode: 0,
  });

  const result = await provider.startTask(
    {
      taskId: "task-apply-approval-snake-case",
      mode: "apply",
      prompt: "Implement Claude support",
      paths: [],
      workspacePath: null,
    },
    noOpCallbacks(),
    new AbortController().signal
  );

  assert.equal(result.approval?.operations.length, 1);
  assert.deepEqual(result.approval?.operations[0], {
    type: "replace_text",
    path: "src/other.ts",
    oldText: "before",
    newText: "after",
  });
});

test("ClaudeCliProvider parses apply completed payload from embedded JSON in a Claude result envelope", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: buildEmbeddedClaudeEnvelope(
      {
        stage: "completed",
        summary: "Applied the requested change.",
        details: "Updated the task routing logic and tests.",
      },
      "session-apply-completed"
    ),
    stderr: "",
    exitCode: 0,
  });

  const result = await provider.startTask(
    {
      taskId: "task-apply-completed-embedded",
      mode: "apply",
      prompt: "Implement Claude support",
      paths: [],
      workspacePath: null,
    },
    noOpCallbacks(),
    new AbortController().signal
  );

  assert.equal(result.summary, "Applied the requested change.");
  assert.match(result.output ?? "", /task routing logic/i);
  assert.equal(result.providerEvidence?.finalMessageSource, "embedded_json");
  assert.equal(result.providerEvidence?.finalizationPath, "embedded_json");
});

test("ClaudeCliProvider parses apply structured_output decision envelopes", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: buildEmbeddedClaudeEnvelope(
      {
        result: "Implementation direction first.",
        structured_output: {
          stage: "decision",
          summary: "Choose an implementation path.",
          options: [
            { id: "option_a", title: "Fast", summary: "Patch the current flow.", recommended: true },
            { id: "option_b", title: "Safe", summary: "Refactor before patching.", recommended: false },
          ],
        },
      },
      "session-apply-structured-output"
    ),
    stderr: "",
    exitCode: 0,
  });

  const result = await provider.startTask(
    {
      taskId: "task-apply-structured-output",
      mode: "apply",
      prompt: "Implement Claude support",
      paths: [],
      workspacePath: null,
    },
    noOpCallbacks(),
    new AbortController().signal
  );

  assert.equal(result.summary, "Choose an implementation path.");
  assert.equal(result.decision?.recommendedOptionId, "option_a");
  assert.equal(result.providerEvidence?.finalMessageSource, "embedded_json");
});

test("ClaudeCliProvider forces raw JSON prompting for initial apply turns", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  let capturedArgs: string[] = [];
  (provider as unknown as { runCommand: Function }).runCommand = async (_executable: string, args: string[]) => {
    capturedArgs = args;
    return {
      stdout: buildEmbeddedClaudeEnvelope(
        {
          stage: "decision",
          summary: "Choose an implementation path.",
          options: [
            { id: "option_a", title: "Fast", summary: "Patch the current flow.", recommended: true },
            { id: "option_b", title: "Safe", summary: "Refactor before patching.", recommended: false },
          ],
        },
        "session-apply-force-json"
      ),
      stderr: "",
      exitCode: 0,
    };
  };

  const result = await provider.startTask(
    {
      taskId: "task-apply-force-json",
      mode: "apply",
      prompt: "Implement Claude support",
      paths: [],
      workspacePath: null,
    },
    noOpCallbacks(),
    new AbortController().signal
  );

  assert.equal(result.decision?.recommendedOptionId, "option_a");
  assert.ok(!capturedArgs.includes("--json-schema"));
  assert.ok(capturedArgs.includes("--output-format"));
  assert.ok(capturedArgs.includes("--permission-mode"));
  assert.ok(capturedArgs.includes("-p"));
  const promptArg = capturedArgs[capturedArgs.length - 1] ?? "";
  assert.match(promptArg, /Return a raw JSON object only/i);
});


test("ClaudeCliProvider keeps JSON output format for apply start turns", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const seenArgs: string[][] = [];
  (provider as unknown as { runCommand: Function }).runCommand = async (_executable: string, args: string[]) => {
    seenArgs.push(args);
    return {
      stdout: buildEmbeddedClaudeEnvelope(
        {
          stage: "decision",
          summary: "Choose an implementation path.",
          options: [
            { id: "option_a", title: "Fast", summary: "Patch the current flow.", recommended: true },
            { id: "option_b", title: "Safe", summary: "Refactor before patching.", recommended: false },
          ],
        },
        "session-apply-start-format"
      ),
      stderr: "",
      exitCode: 0,
    };
  };

  const started = await provider.startTask(
    {
      taskId: "task-apply-start-format",
      mode: "apply",
      prompt: "Implement Claude support",
      paths: [],
      workspacePath: null,
    },
    noOpCallbacks(),
    new AbortController().signal
  );

  assert.equal(started.decision?.options.length, 2);
  assert.ok(seenArgs[0]?.includes("--output-format"));
  assert.ok(seenArgs[0]?.includes("--permission-mode"));
  assert.ok(seenArgs[0]?.includes("-p"));
  assert.ok(!seenArgs[0]?.includes("--json-schema"));
});


test("ClaudeCliProvider keeps JSON output format for apply resume turns without json-schema", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const seenArgs: string[][] = [];
  (provider as unknown as { runCommand: Function }).runCommand = async (_executable: string, args: string[]) => {
    seenArgs.push(args);
    if (seenArgs.length === 1) {
      return {
        stdout: buildEmbeddedClaudeEnvelope(
          {
            stage: "decision",
            summary: "Choose an implementation path.",
            options: [
              { id: "option_a", title: "Fast", summary: "Patch the current flow.", recommended: true },
              { id: "option_b", title: "Safe", summary: "Refactor before patching.", recommended: false },
            ],
          },
          "session-apply-resume-start"
        ),
        stderr: "",
        exitCode: 0,
      };
    }
    return {
      stdout: buildEmbeddedClaudeEnvelope(
        {
          stage: "approval",
          summary: "Apply the approved changes.",
          operations: [{ type: "write_file", path: "src/example.ts", content: "export const value = 1;\n" }],
        },
        "session-apply-resume-approval"
      ),
      stderr: "",
      exitCode: 0,
    };
  };

  const started = await provider.startTask(
    {
      taskId: "task-apply-resume-format",
      mode: "apply",
      prompt: "Implement Claude support",
      paths: [],
      workspacePath: null,
    },
    noOpCallbacks(),
    new AbortController().signal
  );

  const resumed = await provider.resumeTask(
    {
      taskId: "task-apply-resume-format",
      mode: "apply",
      prompt: "Implement Claude support",
      paths: [],
      workspacePath: null,
      sessionId: started.sessionId,
      resumeFromState: "waiting_decision",
      decision: started.decision ?? null,
      approval: null,
    },
    { optionId: "option_a" },
    noOpCallbacks(),
    new AbortController().signal
  );

  assert.equal(resumed.approval?.operations.length, 1);
  assert.ok(seenArgs[0]?.includes("--output-format"));
  assert.ok(seenArgs[0]?.includes("--permission-mode"));
  assert.ok(seenArgs[0]?.includes("-p"));
  assert.ok(!seenArgs[0]?.includes("--json-schema"));
  assert.ok(seenArgs[1]?.includes("--output-format"));
  assert.ok(seenArgs[1]?.includes("--permission-mode"));
  assert.ok(seenArgs[1]?.includes("-p"));
  assert.ok(!seenArgs[1]?.includes("--json-schema"));
});

test("ClaudeCliProvider parses apply prose decisions with degraded extraction", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const runtimeSignals: Array<Record<string, unknown>> = [];
  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: buildEmbeddedClaudeEnvelope(
      "Here’s a minimal change proposal for approval, staying read-only for now.\n\n1. **Recommended: Minimal targeted patch** - Instrument the apply start path only.\n2. **Broader provider cleanup** - Touch parsing and retries together.",
      "session-apply-prose-decision"
    ),
    stderr: "",
    exitCode: 0,
  });

  const result = await provider.startTask(
    {
      taskId: "task-apply-prose-decision",
      mode: "apply",
      prompt: "Implement Claude support",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: Record<string, unknown>) {
        runtimeSignals.push(signal);
      },
    },
    new AbortController().signal
  );

  assert.equal(result.decision?.options.length, 2);
  assert.equal(result.decision?.recommendedOptionId, "option_1");
  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_APPLY_DEGRADED_DECISION_OUTPUT"));
});


test("ClaudeCliProvider fails stalled analyze turns after provider output appears but no usable result arrives", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude", tasksDefaultTimeoutMs: 6_000 }));

  await assert.rejects(
    () =>
      (provider as unknown as { runCommand: Function }).runCommand(
        process.execPath,
        [
          "-e",
          [
            'process.stdout.write("Thinking...\\n");',
            'setTimeout(() => process.stdout.write("Still working...\\n"), 800);',
            'setTimeout(() => process.exit(0), 5000);',
          ].join(" "),
        ],
        process.cwd(),
        new AbortController().signal,
        noOpCallbacks(),
        { warningMs: 1000, failureMs: 2500 }
      ),
    (error: unknown) => {
      assert.match(String(error), /usable result/i);
      return true;
    }
  );
});

test("ClaudeCliProvider parses apply prose decisions from success envelopes that include structured_output metadata", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const runtimeSignals: Array<Record<string, unknown>> = [];
  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: buildEmbeddedClaudeEnvelope(
      {
        result:
          "Minimal change proposal for approval:\n\n### Options\n1. **Recommended — Targeted Claude handoff/task-provider slice**\n   - Implement only the smallest end-to-end provider fix first.\n2. **Broader cleanup**\n   - Expand the change across adjacent routing paths.",
        structured_output: {
          details: "Provider returned prose options instead of strict apply JSON.",
        },
      },
      "session-apply-prose-structured-metadata"
    ),
    stderr: "",
    exitCode: 0,
  });

  const result = await provider.startTask(
    {
      taskId: "task-apply-prose-structured-metadata",
      mode: "apply",
      prompt: "Implement Claude support",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: Record<string, unknown>) {
        runtimeSignals.push(signal);
      },
    },
    new AbortController().signal
  );

  assert.equal(result.decision?.options.length, 2);
  assert.equal(result.decision?.recommendedOptionId, "option_1");
  assert.match(result.summary, /minimal change proposal/i);
  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_APPLY_DEGRADED_DECISION_OUTPUT"));
});


test("ClaudeCliProvider falls back to apply prose decisions even when structured_output metadata is present without a stage", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const runtimeSignals: Array<Record<string, unknown>> = [];
  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: buildEmbeddedClaudeEnvelope(
      {
        result:
          "Here’s a minimal change proposal for approval, staying read-only for now.\n\nOptions:\n1. Recommended — Minimal provider wiring only\n   Add the smallest compatible apply-path fix first.\n2. Broader follow-up cleanup\n   Expand once the live path is stable.",
        structured_output: {
          details: "Provider emitted prose options instead of stage-tagged apply JSON.",
        },
      },
      "session-apply-prose-no-stage"
    ),
    stderr: "",
    exitCode: 0,
  });

  const result = await provider.startTask(
    {
      taskId: "task-apply-prose-no-stage",
      mode: "apply",
      prompt: "Implement Claude support",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: Record<string, unknown>) {
        runtimeSignals.push(signal);
      },
    },
    new AbortController().signal
  );

  assert.equal(result.decision?.options.length, 2);
  assert.equal(result.decision?.recommendedOptionId, "option_1");
  assert.match(result.summary, /minimal change proposal/i);
  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_APPLY_DEGRADED_DECISION_OUTPUT"));
});
test("ClaudeCliProvider parses apply prose decisions that use recommended em dash formatting", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const runtimeSignals: Array<Record<string, unknown>> = [];
  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: buildEmbeddedClaudeEnvelope(
      "Implementation directions, staying read-only for now:\n\n1. Recommended — smallest targeted patch\n   - Change only the code path directly responsible for the current failure.",
      "session-apply-prose-emdash"
    ),
    stderr: "",
    exitCode: 0,
  });

  const result = await provider.startTask(
    {
      taskId: "task-apply-prose-emdash",
      mode: "apply",
      prompt: "Implement Claude support",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: Record<string, unknown>) {
        runtimeSignals.push(signal);
      },
    },
    new AbortController().signal
  );

  assert.equal(result.decision?.options.length, 1);
  assert.equal(result.decision?.recommendedOptionId, "option_1");
  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_APPLY_DEGRADED_DECISION_OUTPUT"));
});


test("ClaudeCliProvider retries initial apply after structured output exhaustion", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const seenArgs: string[][] = [];
  const runtimeSignals: Array<Record<string, unknown>> = [];
  (provider as unknown as { runCommand: Function }).runCommand = async (
    _executable: string,
    args: string[]
  ) => {
    seenArgs.push(args);
    if (seenArgs.length === 1) {
      throw new Error("error_max_structured_output_retries");
    }
    return {
      stdout: buildEmbeddedClaudeEnvelope(
        {
          stage: "decision",
          summary: "Choose an implementation path.",
          options: [
            { id: "option_a", title: "Fast", summary: "Patch the current flow.", recommended: true },
            { id: "option_b", title: "Safe", summary: "Refactor before patching.", recommended: false },
          ],
        },
        "session-apply-retry"
      ),
      stderr: "",
      exitCode: 0,
    };
  };

  const result = await provider.startTask(
    {
      taskId: "task-apply-schema-retry",
      mode: "apply",
      prompt: "Implement Claude support",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: Record<string, unknown>) {
        runtimeSignals.push(signal);
      },
    },
    new AbortController().signal
  );

  assert.equal(seenArgs.length, 2);
  assert.ok(!seenArgs[0]?.includes("--json-schema"));
  assert.ok(!seenArgs[1]?.includes("--json-schema"));
  assert.equal(result.decision?.recommendedOptionId, "option_a");
  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_APPLY_SCHEMA_RETRY"));
});

test("ClaudeCliProvider retries initial apply with explicit raw JSON when the first reply is empty", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const seenArgs: string[][] = [];
  const runtimeSignals: Array<Record<string, unknown>> = [];
  (provider as unknown as { runCommand: Function }).runCommand = async (
    _executable: string,
    args: string[]
  ) => {
    seenArgs.push(args);
    if (seenArgs.length === 1) {
      throw Object.assign(new Error("Claude Code finished without returning a final message."), {
        code: "PROVIDER_OUTPUT_EMPTY",
      });
    }
    return {
      stdout: buildEmbeddedClaudeEnvelope(
        {
          stage: "decision",
          summary: "Choose an implementation path.",
          options: [
            { id: "option_a", title: "Fast", summary: "Patch the current flow.", recommended: true },
            { id: "option_b", title: "Safe", summary: "Refactor before patching.", recommended: false },
          ],
        },
        "session-apply-empty-retry"
      ),
      stderr: "",
      exitCode: 0,
    };
  };

  const result = await provider.startTask(
    {
      taskId: "task-apply-empty-retry",
      mode: "apply",
      prompt: "Implement Claude support",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: Record<string, unknown>) {
        runtimeSignals.push(signal);
      },
    },
    new AbortController().signal
  );

  assert.equal(seenArgs.length, 2);
  assert.ok(!seenArgs[0]?.includes("--json-schema"));
  assert.ok(!seenArgs[1]?.includes("--json-schema"));
  assert.equal(result.decision?.recommendedOptionId, "option_a");
  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_APPLY_OUTPUT_RETRY"));
});



test("ClaudeCliProvider forces raw JSON prompting for initial analyze turns", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const seenArgs: string[][] = [];
  (provider as unknown as { runCommand: Function }).runCommand = async (
    _executable: string,
    args: string[]
  ) => {
    seenArgs.push(args);
    return {
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "session-analyze-raw-json",
        result: JSON.stringify({
          summary: "Repo risks and leverage points",
          details: "Dependency chain: routing -> task service -> provider adapters.",
        }),
      }),
      stderr: "",
      exitCode: 0,
    };
  };

  const result = await provider.startTask(
    {
      taskId: "task-analyze-raw-json",
      mode: "analyze",
      prompt: "Perform a deep read-only repository analysis.",
      paths: [],
      workspacePath: process.cwd(),
    },
    noOpCallbacks(),
    new AbortController().signal
  );

  assert.equal(result.sessionId, "session-analyze-raw-json");
  assert.equal(seenArgs.length, 1);
  assert.ok(seenArgs[0].includes("--output-format"));
  assert.ok(!seenArgs[0].includes("--json-schema"));
  assert.match(seenArgs[0][seenArgs[0].length - 1] ?? "", /Return a raw JSON object only/i);
});


test("ClaudeCliProvider retries analyze with explicit raw JSON when the first reply stalls before usable output", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const seenArgs: string[][] = [];
  const runtimeSignals: Array<Record<string, unknown>> = [];
  (provider as unknown as { runCommand: Function }).runCommand = async (
    _executable: string,
    args: string[]
  ) => {
    seenArgs.push(args);
    if (seenArgs.length === 1) {
      throw Object.assign(new Error("Claude stalled after turn start without producing provider activity."), {
        code: "PROVIDER_EXECUTION_FAILED",
      });
    }
    return {
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "session-analyze-stall-retry",
        result: JSON.stringify({
          summary: "Repo risks and leverage points",
          details: "Analyze now retries once after a stalled first finalize attempt before giving up.",
        }),
      }),
      stderr: "",
      exitCode: 0,
    };
  };

  const result = await provider.startTask(
    {
      taskId: "task-analyze-stall-retry",
      mode: "analyze",
      prompt: "Perform a deep read-only repository analysis.",
      paths: [],
      workspacePath: process.cwd(),
    },
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: Record<string, unknown>) {
        runtimeSignals.push(signal);
      },
    },
    new AbortController().signal
  );

  assert.equal(seenArgs.length, 2);
  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_ANALYZE_OUTPUT_RETRY"));
  assert.equal(result.summary, "Repo risks and leverage points");
  assert.match(result.output ?? "", /retries once after a stalled first finalize attempt/i);
  assert.equal(result.sessionId, "session-analyze-stall-retry");
});

test("ClaudeCliProvider forces raw JSON prompting for initial plan turns", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const seenArgs: string[][] = [];
  (provider as unknown as { runCommand: Function }).runCommand = async (
    _executable: string,
    args: string[]
  ) => {
    seenArgs.push(args);
    return {
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "session-plan-raw-json",
        result: JSON.stringify({
          summary: "Choose an investigation path.",
          options: [
            { id: "option_a", title: "Trace provider finalization", summary: "Start in claude-provider.ts.", recommended: true },
            { id: "option_b", title: "Audit fallback semantics", summary: "Start in service.ts.", recommended: false },
          ],
        }),
      }),
      stderr: "",
      exitCode: 0,
    };
  };

  const result = await provider.startTask(
    {
      taskId: "task-plan-raw-json",
      mode: "plan",
      prompt: "Give me two next-step options.",
      paths: [],
      workspacePath: process.cwd(),
    },
    noOpCallbacks(),
    new AbortController().signal
  );

  assert.equal(result.sessionId, "session-plan-raw-json");
  assert.equal(seenArgs.length, 1);
  assert.ok(seenArgs[0].includes("--output-format"));
  assert.ok(!seenArgs[0].includes("--json-schema"));
  assert.match(seenArgs[0][seenArgs[0].length - 1] ?? "", /Return a raw JSON object only/i);
});
test("ClaudeCliProvider retries plan with explicit raw JSON when the first reply is empty", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const seenArgs: string[][] = [];
  const runtimeSignals: Array<Record<string, unknown>> = [];
  (provider as unknown as { runCommand: Function }).runCommand = async (
    _executable: string,
    args: string[]
  ) => {
    seenArgs.push(args);
    if (seenArgs.length === 1) {
      throw Object.assign(new Error("Claude Code finished without returning a final message."), {
        code: "PROVIDER_OUTPUT_EMPTY",
      });
    }
    return {
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "session-plan-empty-retry",
        result: JSON.stringify({
          summary: "Choose an investigation path.",
          options: [
            { id: "option_a", title: "Trace provider finalization", summary: "Start in claude-provider.ts.", recommended: true },
            { id: "option_b", title: "Audit fallback semantics", summary: "Start in service.ts and readonly-fallback.ts.", recommended: false },
          ],
        }),
      }),
      stderr: "",
      exitCode: 0,
    };
  };

  const result = await provider.startTask(
    {
      taskId: "task-plan-empty-retry",
      mode: "plan",
      prompt: "Give me two next-step options.",
      paths: [],
      workspacePath: process.cwd(),
    },
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: Record<string, unknown>) {
        runtimeSignals.push(signal);
      },
    },
    new AbortController().signal
  );

  assert.equal(seenArgs.length, 2);
  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_PLAN_OUTPUT_RETRY"));
  assert.equal(result.decision?.recommendedOptionId, "option_a");
  assert.equal(result.sessionId, "session-plan-empty-retry");
});

test("ClaudeCliProvider salvages plan output from direct JSON without an envelope", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const runtimeSignals: Array<Record<string, unknown>> = [];
  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: JSON.stringify({
      session_id: "session-plan-salvaged-json",
      title: "Choose an implementation path.",
      choices: [
        { key: "option_a", name: "Trace provider finalization", description: "Start in claude-provider.ts.", recommended: true },
        { key: "option_b", name: "Audit fallback semantics", description: "Start in service.ts.", recommended: false },
      ],
    }),
    stderr: "",
    exitCode: 0,
  });

  const result = await provider.startTask(
    {
      taskId: "task-plan-salvaged-json",
      mode: "plan",
      prompt: "Give me two next-step options.",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: Record<string, unknown>) {
        runtimeSignals.push(signal);
      },
    },
    new AbortController().signal
  );

  assert.equal(result.sessionId, "session-plan-salvaged-json");
  assert.equal(result.decision?.recommendedOptionId, "option_a");
  assert.equal(result.providerEvidence?.finalMessageSource, "embedded_json");
  assert.ok(!runtimeSignals.some((signal) => signal.code === "PROVIDER_PLAN_OUTPUT_RETRY"));
});

test("ClaudeCliProvider salvages plan output from substantive prose before retry", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const runtimeSignals: Array<Record<string, unknown>> = [];
  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: [
      "Choose an investigation path.",
      "Option A: Trace provider finalization - Start in claude-provider.ts. Recommended.",
      "Option B: Audit fallback semantics - Start in service.ts and readonly-fallback.ts.",
    ].join("\n"),
    stderr: "",
    exitCode: 0,
  });

  const result = await provider.startTask(
    {
      taskId: "task-plan-salvaged-prose",
      mode: "plan",
      prompt: "Give me two next-step options.",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: Record<string, unknown>) {
        runtimeSignals.push(signal);
      },
    },
    new AbortController().signal
  );

  assert.equal(result.decision?.options.length, 2);
  assert.equal(result.decision?.recommendedOptionId, "option_a");
  assert.ok(!runtimeSignals.some((signal) => signal.code === "PROVIDER_PLAN_OUTPUT_RETRY"));
});

test("ClaudeCliProvider retries plan after non-empty invalid first-pass output that still looks like a final answer", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const seenArgs: string[][] = [];
  const runtimeSignals: Array<Record<string, unknown>> = [];
  (provider as unknown as { runCommand: Function }).runCommand = async (
    _executable: string,
    args: string[]
  ) => {
    seenArgs.push(args);
    if (seenArgs.length === 1) {
      return {
        stdout: JSON.stringify({
          summary: "Choose an investigation path.",
          options: [{ id: "option_a", title: "Trace provider finalization", recommended: true }],
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    return {
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "session-plan-invalid-retry",
        result: JSON.stringify({
          summary: "Choose an investigation path.",
          options: [
            { id: "option_a", title: "Trace provider finalization", summary: "Start in claude-provider.ts.", recommended: true },
            { id: "option_b", title: "Audit fallback semantics", summary: "Start in service.ts.", recommended: false },
          ],
        }),
      }),
      stderr: "",
      exitCode: 0,
    };
  };

  const result = await provider.startTask(
    {
      taskId: "task-plan-invalid-retry",
      mode: "plan",
      prompt: "Give me two next-step options.",
      paths: [],
      workspacePath: process.cwd(),
    },
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: Record<string, unknown>) {
        runtimeSignals.push(signal);
      },
    },
    new AbortController().signal
  );

  assert.equal(seenArgs.length, 2);
  assert.equal(result.sessionId, "session-plan-invalid-retry");
  assert.equal(result.decision?.recommendedOptionId, "option_a");
  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_PLAN_OUTPUT_RETRY"));
});

test("ClaudeCliProvider still fails plan when first-pass output is not salvageable", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: "Done",
    stderr: "",
    exitCode: 0,
  });

  await assert.rejects(
    () =>
      provider.startTask(
        {
          taskId: "task-plan-unsalvageable",
          mode: "plan",
          prompt: "Give me two next-step options.",
          paths: [],
          workspacePath: process.cwd(),
        },
        noOpCallbacks(),
        new AbortController().signal
      ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "PROVIDER_EXECUTION_FAILED");
      assert.match(String((error as Error).message), /expected JSON result|usable plan result/i);
      return true;
    }
  );
});


test("ClaudeCliProvider builds a deterministic local workspace snapshot for read-only tasks", async () => {
  const workspacePath = await makeTempDir("clawdrive-claude-provider-snapshot");
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

  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
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
  assert.match(snapshot.lines.join("\n"), /package\.json: name=snapshot-test, displayName=Snapshot Test, version=1\.2\.3/);
  assert.match(snapshot.lines.join("\n"), /src\/tasks files: service\.ts/);
});

test("ClaudeCliProvider finds the bundled CLI inside a Claude Code VS Code extension", async () => {
  const extensionRoot = await makeTempDir("clawdrive-claude-extension-root");
  const extensionDir = path.join(extensionRoot, "anthropic.claude-code-2.1.88-win32-x64");
  const bundledCli = path.join(extensionDir, "resources", "native-binary", "claude.exe");
  await fs.mkdir(path.dirname(bundledCli), { recursive: true });
  await fs.writeFile(bundledCli, "", "utf8");

  const originalPath = process.env.PATH;
  process.env.PATH = "";

  try {
    const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude", providerClaudePath: "claude" }));
    (provider as unknown as { getExtensionRoots: Function }).getExtensionRoots = () => [extensionRoot];

    const resolved = await (provider as unknown as { resolveExecutable: Function }).resolveExecutable();
    assert.equal(resolved, bundledCli);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
});

test("ClaudeCliProvider uses mode-aware quiet budgets and keeps resume retries on the shared timing budget", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude", tasksDefaultTimeoutMs: 30_000 }));

  const analyzeTimings = (provider as unknown as { getRunStallTimings: Function }).getRunStallTimings({
    taskId: "task-analyze",
    mode: "analyze",
    prompt: "Explain the repo",
    paths: [],
    workspacePath: process.cwd(),
  });
  const planTimings = (provider as unknown as { getRunStallTimings: Function }).getRunStallTimings({
    taskId: "task-plan",
    mode: "plan",
    prompt: "Give me two options",
    paths: [],
    workspacePath: process.cwd(),
  });
  const planResumeRetryTimings = (provider as unknown as { getRunStallTimings: Function }).getRunStallTimings(
    {
      taskId: "task-plan-resume",
      mode: "plan",
      prompt: "Continue the previous task",
      paths: [],
      workspacePath: process.cwd(),
      sessionId: "session-plan-resume",
      resumeFromState: "waiting_decision",
      decision: null,
      approval: null,
    },
    true
  );
  const applyTimings = (provider as unknown as { getRunStallTimings: Function }).getRunStallTimings({
    taskId: "task-apply",
    mode: "apply",
    prompt: "Modify README",
    paths: [],
    workspacePath: process.cwd(),
  });

  assert.equal(analyzeTimings.failureMs, 10_000);
  assert.equal(analyzeTimings.warningMs, 5_000);
  assert.equal(planTimings.failureMs, 360_000);
  assert.equal(planTimings.warningMs, 180_000);
  assert.equal(planResumeRetryTimings.failureMs, 10_000);
  assert.equal(planResumeRetryTimings.warningMs, 5_000);
  assert.equal(applyTimings.failureMs, 10_000);
  assert.equal(applyTimings.warningMs, 5_000);
});

test("ClaudeCliProvider uses longer quiet budgets for initial plan runs", () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude", tasksDefaultTimeoutMs: 30_000 }));
  const timings = (provider as unknown as {
    getRunStallTimings(context: { mode: "analyze" | "plan" | "apply" }, preferResumeRetry?: boolean): {
      warningMs: number;
      failureMs: number;
    };
  }).getRunStallTimings({ mode: "plan" });
  const analyzeTimings = (provider as unknown as {
    getRunStallTimings(context: { mode: "analyze" | "plan" | "apply" }, preferResumeRetry?: boolean): {
      warningMs: number;
      failureMs: number;
    };
  }).getRunStallTimings({ mode: "analyze" });

  assert.ok(timings.warningMs > analyzeTimings.warningMs);
  assert.ok(timings.failureMs > analyzeTimings.failureMs);
});


test("ClaudeCliProvider preserves a usable captured result despite fatal trailing runtime stderr", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));

  const result = await (provider as unknown as { runCommand: Function }).runCommand(
    process.execPath,
    [
      "-e",
      [
        'process.stdout.write(JSON.stringify({summary:"Repo overview",details:"Terminal payload won the race."}));',
        'process.stderr.write("No authentication found\\n");',
        'setTimeout(() => process.exit(0), 10);',
      ].join(" "),
    ],
    process.cwd(),
    new AbortController().signal,
    noOpCallbacks()
  );

  assert.match(result.stdout, /Repo overview/);
  assert.match(result.stderr, /No authentication found/);
});



test("ClaudeCliProvider keeps active but unparseable stdout from timing out before close", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude", tasksDefaultTimeoutMs: 6_000 }));

  const progress: string[] = [];
  const evidence: Array<Record<string, unknown>> = [];
  const runtimeSignals: Array<{ code: string; severity: string; summary: string }> = [];
  const result = await (provider as unknown as { runCommand: Function }).runCommand(
    process.execPath,
    [
      "-e",
      [
        'process.stdout.write("Thinking...\\n");',
        'setTimeout(() => process.stdout.write("Still working...\\n"), 1500);',
        'setTimeout(() => process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:JSON.stringify({summary:"Repo overview",details:"Late final payload arrived after earlier unparseable progress."})})), 3200);',
        'setTimeout(() => process.exit(0), 3300);',
      ].join(" "),
    ],
    process.cwd(),
    new AbortController().signal,
    {
      ...noOpCallbacks(),
      onProgress(summary: string) {
        progress.push(summary);
      },
      onEvidence(value: Record<string, unknown>) {
        evidence.push(value);
      },
      onRuntimeSignal(signal: { code: string; severity: string; summary: string }) {
        runtimeSignals.push(signal);
      },
    },
    { warningMs: 1000, failureMs: 2500 }
  );

  assert.match(result.stdout, /Late final payload arrived/i);
  assert.ok(evidence.some((entry) => entry.sawTurnStarted === true));
  assert.ok(progress.some((entry) => /turn started|stalled/i.test(entry)));
  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_RESULT_STALL_WARNING"));
});

test("ClaudeCliProvider probe stays ready when smoke test stalls without a usable result", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  (provider as unknown as { runCommand: Function }).runCommand = async (_executable: string, args: string[]) => {
    if (args.includes("--help")) {
      return { stdout: "", stderr: "--bare\n--print\n--output-format\n--json-schema\n--resume\n--model\n--permission-mode\n", exitCode: 0 };
    }
    throw new Error("Claude stalled after turn start without producing a usable result.");
  };

  const result = await provider.probe();
  assert.equal(result.ready, true);
  assert.equal(result.state, "ready");
  assert.match(result.detail, /probe was inconclusive/i);
  assert.match(result.detail, /stalled after turn start/i);
});


test("ClaudeCliProvider probe stays ready when smoke test returns an empty result payload", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  (provider as unknown as { runCommand: Function }).runCommand = async (_executable: string, args: string[]) => {
    if (args.includes("--help")) {
      return { stdout: "", stderr: "--bare\n--print\n--output-format\n--json-schema\n--resume\n--model\n--permission-mode\n", exitCode: 0 };
    }
    throw new Error("Claude returned an empty result payload.");
  };

  const result = await provider.probe();
  assert.equal(result.ready, true);
  assert.equal(result.state, "ready");
  assert.match(result.detail, /probe was inconclusive/i);
  assert.match(result.detail, /final message/i);
});


test("ClaudeCliProvider probe fails when MCP tool fetch is incompatible", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  (provider as unknown as { runCommand: Function }).runCommand = async (_executable: string, args: string[]) => {
    if (args.includes("--help")) {
      return { stdout: "", stderr: "--bare\n--print\n--output-format\n--json-schema\n--resume\n--model\n--permission-mode\n", exitCode: 0 };
    }
    throw new Error('MCP server "claude-vscode" Failed to fetch tools: MCP error -32601: Method not found');
  };

  const result = await provider.probe();
  assert.equal(result.ready, false);
  assert.equal(result.state, "error");
  assert.match(result.detail, /mcp compatibility|tool registration/i);
});

test("ClaudeCliProvider fails fast on fatal auth runtime signals", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude", tasksDefaultTimeoutMs: 30_000 }));
  const runtimeSignals: Array<{ code: string; severity: string; summary: string }> = [];

  await assert.rejects(
    () =>
      (provider as unknown as { runCommand: Function }).runCommand(
        process.execPath,
        ["-e", 'process.stderr.write("No authentication found\\n"); setTimeout(() => {}, 20000);'],
        process.cwd(),
        new AbortController().signal,
        {
          ...noOpCallbacks(),
          onRuntimeSignal(signal: { code: string; severity: string; summary: string }) {
            runtimeSignals.push(signal);
          },
        }
      ),
    (error: unknown) => {
      assert.match(String(error), /No authentication found/i);
      return true;
    }
  );

  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_AUTH_FAILED" && signal.severity === "fatal"));
});

test("ClaudeCliProvider does not mark turn started before fatal runtime failure", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  (provider as unknown as { runCommand: Function }).runCommand = async () => {
    throw new Error("No authentication found");
  };

  const progress: string[] = [];
  const evidence: Array<{ sawTurnStarted?: boolean }> = [];

  await assert.rejects(
    () =>
      provider.startTask(
        {
          taskId: "task-auth-fail",
          mode: "plan",
          prompt: "Plan the implementation",
          paths: [],
          workspacePath: null,
        },
        {
          ...noOpCallbacks(),
          onProgress(summary: string) {
            progress.push(summary);
          },
          onEvidence(value: { sawTurnStarted?: boolean }) {
            evidence.push(value);
          },
        },
        new AbortController().signal
      ),
    /configured upstream model provider/i
  );

  assert.ok(!progress.some((entry) => /turn started/i.test(entry)));
  assert.ok(!evidence.some((entry) => entry.sawTurnStarted));
});


test("ClaudeCliProvider degrades analyze payload when summary/details fields are malformed", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: buildEmbeddedClaudeEnvelope(
      {
        summary: { text: "Repo overview" },
        details: ["The extension routes tasks through provider-backed execution."],
        message: "The extension routes tasks through provider-backed execution.",
        title: "Repo overview",
      },
      "session-analyze-degraded"
    ),
    stderr: "",
    exitCode: 0,
  });

  const runtimeSignals: Array<{ code: string; severity: string; summary: string }> = [];
  const result = await provider.startTask(
    {
      taskId: "task-analyze-degraded",
      mode: "analyze",
      prompt: "Explain the repo",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: { code: string; severity: string; summary: string }) {
        runtimeSignals.push(signal);
      },
    },
    new AbortController().signal
  );

  assert.equal(result.summary, "Repo overview");
  assert.match(result.output ?? "", /provider-backed execution/i);
  assert.equal(result.providerEvidence?.finalMessageSource, "embedded_json");
  assert.equal(result.providerEvidence?.finalizationPath, "embedded_json");
  assert.ok(
    runtimeSignals.some(
      (signal) => signal.code === "PROVIDER_ANALYZE_DEGRADED_OUTPUT" && signal.severity === "degraded"
    )
  );
});

test("ClaudeCliProvider salvages analyze output from direct JSON without an envelope", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const runtimeSignals: Array<{ code: string; severity: string; summary: string }> = [];
  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: JSON.stringify({
      session_id: "session-analyze-salvaged-json",
      title: "Repo overview",
      message: "The extension routes tasks through provider-backed execution after provider finalization.",
    }),
    stderr: "",
    exitCode: 0,
  });

  const result = await provider.startTask(
    {
      taskId: "task-analyze-salvaged-json",
      mode: "analyze",
      prompt: "Explain the repo",
      paths: [],
      workspacePath: null,
    },
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: { code: string; severity: string; summary: string }) {
        runtimeSignals.push(signal);
      },
    },
    new AbortController().signal
  );

  assert.equal(result.sessionId, "session-analyze-salvaged-json");
  assert.equal(result.summary, "Repo overview");
  assert.match(result.output ?? "", /provider-backed execution/i);
  assert.equal(result.providerEvidence?.finalMessageSource, "embedded_json");
  assert.ok(!runtimeSignals.some((signal) => signal.code === "PROVIDER_ANALYZE_DEGRADED_OUTPUT"));
});

test("ClaudeCliProvider treats resumed plan turns as analyze finalization for salvage", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const seenArgs: string[][] = [];
  (provider as unknown as { runCommand: Function }).runCommand = async (
    _executable: string,
    args: string[]
  ) => {
    seenArgs.push(args);
    if (seenArgs.length === 1) {
      return {
        stdout: buildEmbeddedClaudeEnvelope(
          {
            summary: "Choose an investigation path.",
            options: [
              { id: "option_a", title: "Trace provider finalization", summary: "Start in claude-provider.ts.", recommended: true },
              { id: "option_b", title: "Audit fallback semantics", summary: "Start in service.ts.", recommended: false },
            ],
          },
          "session-plan-resume-start"
        ),
        stderr: "",
        exitCode: 0,
      };
    }
    throw Object.assign(new Error("Claude did not return a usable analyze result."), {
      code: "PROVIDER_OUTPUT_INVALID",
      stdout: JSON.stringify({
        session_id: "session-plan-resume-final",
        title: "Provider finalization path",
        message: "Resume turns now salvage through analyze finalization instead of plan decision parsing.",
      }),
      stderr: "",
      exitCode: 0,
    });
  };

  const started = await provider.startTask(
    {
      taskId: "task-plan-resume-salvage",
      mode: "plan",
      prompt: "Give me two next-step options.",
      paths: [],
      workspacePath: process.cwd(),
    },
    noOpCallbacks(),
    new AbortController().signal
  );

  const resumed = await provider.resumeTask(
    {
      taskId: "task-plan-resume-salvage",
      mode: "plan",
      prompt: "Give me two next-step options.",
      paths: [],
      workspacePath: process.cwd(),
      sessionId: started.sessionId,
      resumeFromState: "waiting_decision",
      decision: started.decision ?? null,
      approval: null,
    },
    { optionId: "option_a" },
    noOpCallbacks(),
    new AbortController().signal
  );

  assert.equal(seenArgs.length, 2);
  assert.equal(resumed.sessionId, "session-plan-resume-final");
  assert.equal(resumed.summary, "Provider finalization path");
  assert.match(resumed.output ?? "", /analyze finalization/i);
  assert.equal(resumed.providerEvidence?.finalMessageSource, "direct_message");
  assert.equal(resumed.decision, undefined);
});



test("ClaudeCliProvider retries resumed plan finalization when the first continue reply is invalid", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const seenArgs: string[][] = [];
  const runtimeSignals: Array<Record<string, unknown>> = [];
  (provider as unknown as { runCommand: Function }).runCommand = async (
    _executable: string,
    args: string[]
  ) => {
    seenArgs.push(args);
    if (seenArgs.length === 1) {
      return {
        stdout: buildEmbeddedClaudeEnvelope(
          {
            summary: "Choose an investigation path.",
            options: [
              { id: "option_a", title: "Trace provider finalization", summary: "Start in claude-provider.ts.", recommended: true },
              { id: "option_b", title: "Audit fallback semantics", summary: "Start in service.ts.", recommended: false },
            ],
          },
          "session-plan-resume-invalid-start"
        ),
        stderr: "",
        exitCode: 0,
      };
    }
    if (seenArgs.length === 2) {
      throw Object.assign(new Error("Claude did not return a usable analyze result."), {
        code: "PROVIDER_OUTPUT_INVALID",
        stdout: JSON.stringify({
          session_id: "session-plan-resume-invalid-first-final",
          summary: "Continue with the provider trace",
          options: [{ id: "option_a", title: "broken" }],
        }),
        stderr: "",
        exitCode: 0,
      });
    }
    return {
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "session-plan-resume-invalid-retry",
        result: JSON.stringify({
          summary: "Provider finalization path",
          details: "Resume turns now recover via a retry if the first continue reply is malformed.",
        }),
      }),
      stderr: "",
      exitCode: 0,
    };
  };

  const started = await provider.startTask(
    {
      taskId: "task-plan-resume-invalid-retry",
      mode: "plan",
      prompt: "Give me two next-step options.",
      paths: [],
      workspacePath: process.cwd(),
    },
    noOpCallbacks(),
    new AbortController().signal
  );

  const resumed = await provider.resumeTask(
    {
      taskId: "task-plan-resume-invalid-retry",
      mode: "plan",
      prompt: "Give me two next-step options.",
      paths: [],
      workspacePath: process.cwd(),
      sessionId: started.sessionId,
      resumeFromState: "waiting_decision",
      decision: started.decision ?? null,
      approval: null,
    },
    { optionId: "option_a" },
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: Record<string, unknown>) {
        runtimeSignals.push(signal);
      },
    },
    new AbortController().signal
  );

  assert.equal(seenArgs.length, 3);
  assert.ok(seenArgs[1]?.includes("--output-format"));
  assert.ok(seenArgs[2]?.includes("--output-format"));
  assert.equal(resumed.sessionId, "session-plan-resume-invalid-retry");
  assert.equal(resumed.summary, "Provider finalization path");
  assert.match(resumed.output ?? "", /recover via a retry/i);
  assert.equal(resumed.decision, undefined);
  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_PLAN_RESUME_OUTPUT_RETRY"));
});

test("ClaudeCliProvider retries resumed plan finalization when the first continue reply returns no usable result", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  const seenArgs: string[][] = [];
  const runtimeSignals: Array<Record<string, unknown>> = [];
  (provider as unknown as { runCommand: Function }).runCommand = async (
    _executable: string,
    args: string[]
  ) => {
    seenArgs.push(args);
    if (seenArgs.length === 1) {
      return {
        stdout: buildEmbeddedClaudeEnvelope(
          {
            summary: "Choose an investigation path.",
            options: [
              { id: "option_a", title: "Trace provider finalization", summary: "Start in claude-provider.ts.", recommended: true },
              { id: "option_b", title: "Audit fallback semantics", summary: "Start in service.ts.", recommended: false },
            ],
          },
          "session-plan-resume-stall-start"
        ),
        stderr: "",
        exitCode: 0,
      };
    }
    if (seenArgs.length === 2) {
      throw Object.assign(new Error("Claude Code finished without returning a final message."), {
        code: "PROVIDER_OUTPUT_EMPTY",
        stdout: "",
        stderr: "",
        exitCode: 0,
      });
    }
    return {
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "session-plan-resume-stall-retry",
        result: JSON.stringify({
          summary: "Resume retry recovered",
          details: "The resumed plan continue path now retries once after an empty first finalize attempt.",
        }),
      }),
      stderr: "",
      exitCode: 0,
    };
  };

  const started = await provider.startTask(
    {
      taskId: "task-plan-resume-stall-retry",
      mode: "plan",
      prompt: "Give me two next-step options.",
      paths: [],
      workspacePath: process.cwd(),
    },
    noOpCallbacks(),
    new AbortController().signal
  );

  const resumed = await provider.resumeTask(
    {
      taskId: "task-plan-resume-stall-retry",
      mode: "plan",
      prompt: "Give me two next-step options.",
      paths: [],
      workspacePath: process.cwd(),
      sessionId: started.sessionId,
      resumeFromState: "waiting_decision",
      decision: started.decision ?? null,
      approval: null,
    },
    { optionId: "option_a" },
    {
      ...noOpCallbacks(),
      onRuntimeSignal(signal: Record<string, unknown>) {
        runtimeSignals.push(signal);
      },
    },
    new AbortController().signal
  );

  assert.equal(seenArgs.length, 3);
  assert.equal(resumed.sessionId, "session-plan-resume-stall-retry");
  assert.equal(resumed.summary, "Resume retry recovered");
  assert.match(resumed.output ?? "", /retries once after an empty first finalize attempt/i);
  assert.equal(resumed.decision, undefined);
  assert.ok(runtimeSignals.some((signal) => signal.code === "PROVIDER_PLAN_RESUME_OUTPUT_RETRY"));
});

test("ClaudeCliProvider salvages complex plan prose with numbered headings and bullet details", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: [
      "Three feasible next-step options for this workspace.",
      "1. Review the frozen documentation backbone",
      "- Impact scope: docs and product model only.",
      "- Main risk: may delay validation of active code paths.",
      "2. Inspect active implementation surfaces",
      "- Impact scope: backend, frontend, and current progress files.",
      "- Main risk: may inherit temporary in-progress assumptions.",
      "3. Validate workflow state transitions [recommended]",
      "- Impact scope: action semantics, guard logic, and task records.",
      "- Main risk: narrower coverage of broader architecture questions.",
    ].join("\n"),
    stderr: "",
    exitCode: 0,
  });

  const result = await provider.startTask(
    {
      taskId: "task-plan-complex-prose",
      mode: "plan",
      prompt: "Give me three feasible next-step options for this workspace, explain impact scope and main risks, and do not modify anything yet.",
      paths: [],
      workspacePath: null,
    },
    noOpCallbacks(),
    new AbortController().signal
  );

  assert.equal(result.decision?.options.length, 3);
  assert.equal(result.decision?.recommendedOptionId, "option_3");
  assert.match(result.output ?? "", /Impact scope: action semantics/i);
});

test("ClaudeCliProvider still fails analyze when final prose is not substantive enough to salvage", async () => {
  const provider = new ClaudeCliProvider(makeConfig({ providerKind: "claude" }));
  stubProviderEnvironment(provider);

  (provider as unknown as { runCommand: Function }).runCommand = async () => ({
    stdout: "Done",
    stderr: "",
    exitCode: 0,
  });

  await assert.rejects(
    () =>
      provider.startTask(
        {
          taskId: "task-analyze-unsalvageable-prose",
          mode: "analyze",
          prompt: "Explain the repo",
          paths: [],
          workspacePath: null,
        },
        noOpCallbacks(),
        new AbortController().signal
      ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "PROVIDER_OUTPUT_INVALID");
      assert.match(String((error as Error).message), /expected JSON result|usable analyze result|configured upstream model provider/i);
      return true;
    }
  );
});

function buildEmbeddedClaudeEnvelope(payload: unknown, sessionId: string): string {
  const nestedEnvelope = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify(payload),
  });

  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    result: ["Best-effort result follows.", "```json", nestedEnvelope, "```"].join("\n"),
  });
}

function stubProviderEnvironment(provider: ClaudeCliProvider): void {
  (provider as unknown as { resolveExecutable: Function }).resolveExecutable = async () => "claude";
  (provider as unknown as { getCapabilities: Function }).getCapabilities = async () => ({
    supportsBare: true,
    supportsPrint: true,
    supportsOutputFormat: true,
    supportsJsonSchema: true,
    supportsResume: true,
    supportsModel: true,
    supportsPermissionMode: true,
  });
}

function noOpCallbacks() {
  return {
    onSessionId() {},
    onProgress() {},
    onOutput() {},
    onRuntimeSignal() {},
    onEvidence() {},
  };
}
