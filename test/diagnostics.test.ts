import test from "node:test";
import assert from "node:assert/strict";
import { buildOperatorStatusFromDiagnosis, type ConnectionDiagnosisSnapshot } from "../src/diagnostics";
import type { ProviderStatusInfo, TaskSnapshot } from "../src/tasks/types";

const readyProvider: ProviderStatusInfo = {
  ready: true,
  state: "ready",
  label: "Ready (Codex CLI)",
  message: "Provider status: ready.",
  detail: "Codex CLI is enabled and runnable.",
};

test("buildOperatorStatusFromDiagnosis highlights disconnected state", () => {
  const status = buildOperatorStatusFromDiagnosis(
    {
      gatewayUrl: "ws://127.0.0.1:18789",
      connectionState: "disconnected",
      callable: true,
      providerStatus: readyProvider,
      findings: [],
    },
    null
  );

  assert.equal(status.connected, false);
  assert.equal(status.providerReady, true);
  assert.equal(status.actionableHint, "Reconnect the Gateway session first, then retry the request.");
});

test("buildOperatorStatusFromDiagnosis highlights provider readiness problems", () => {
  const diagnosis: ConnectionDiagnosisSnapshot = {
    gatewayUrl: "ws://127.0.0.1:18789",
    connectionState: "connected",
    callable: true,
    providerStatus: {
      ready: false,
      state: "missing",
      label: "Unavailable (path problem)",
      message: "Provider status: executable not found.",
      detail: "spawn codex ENOENT",
    },
    findings: [],
  };

  const status = buildOperatorStatusFromDiagnosis(diagnosis, null);
  assert.equal(status.providerReady, false);
  assert.equal(
    status.actionableHint,
    "Fix provider readiness first, especially the Codex executable path or local installation."
  );
});

test("buildOperatorStatusFromDiagnosis surfaces latest failed task summary", () => {
  const failedTask: TaskSnapshot = {
    taskId: "task-1",
    title: "Analyze: repo",
    mode: "analyze",
    state: "failed",
    prompt: "Explain the repo",
    paths: [],
    createdAt: "2026-03-21T12:00:00.000Z",
    updatedAt: "2026-03-21T12:01:00.000Z",
    summary: "Task failed: unexpected argument",
    lastOutput: null,
    executionHealth: "failed",
    runtimeSignals: [],
    decision: null,
    approval: null,
    error: "unexpected argument '--output-schema' found",
    errorCode: "PROVIDER_CLI_ARGS_UNSUPPORTED",
    providerKind: "codex",
    providerSessionId: "session-1",
    resultSummary: null,
    providerEvidence: null,
  };

  const status = buildOperatorStatusFromDiagnosis(
    {
      gatewayUrl: "ws://127.0.0.1:18789",
      connectionState: "connected",
      callable: true,
      providerStatus: readyProvider,
      findings: [],
    },
    failedTask
  );

  assert.equal(
    status.latestFailureSummary,
    "PROVIDER_CLI_ARGS_UNSUPPORTED: unexpected argument '--output-schema' found"
  );
  assert.equal(
    status.actionableHint,
    "Inspect the latest failed task summary and error code before re-running the task."
  );
});

test("buildOperatorStatusFromDiagnosis surfaces degraded completion separately from failure", () => {
  const degradedTask: TaskSnapshot = {
    taskId: "task-2",
    title: "Plan: repo",
    mode: "plan",
    state: "completed",
    prompt: "Give me two options",
    paths: [],
    createdAt: "2026-03-21T12:00:00.000Z",
    updatedAt: "2026-03-21T12:01:00.000Z",
    summary: "Plan completed.",
    lastOutput: null,
    executionHealth: "degraded",
    runtimeSignals: [
      {
        code: "PROVIDER_TRANSPORT_FALLBACK",
        severity: "degraded",
        summary: "Provider transport fell back to a slower or narrower runtime path.",
        count: 1,
        lastSeenAt: "2026-03-21T12:00:30.000Z",
      },
    ],
    decision: null,
    approval: null,
    error: null,
    errorCode: null,
    providerKind: "codex",
    providerSessionId: "session-2",
    resultSummary: "Plan completed.",
    providerEvidence: null,
  };

  const status = buildOperatorStatusFromDiagnosis(
    {
      gatewayUrl: "ws://127.0.0.1:18789",
      connectionState: "connected",
      callable: true,
      providerStatus: readyProvider,
      findings: [],
    },
    degradedTask
  );

  assert.equal(status.latestTaskHealth, "degraded");
  assert.equal(
    status.latestNonFatalSummary,
    "PROVIDER_TRANSPORT_FALLBACK: Provider transport fell back to a slower or narrower runtime path."
  );
  assert.equal(status.latestFailureSummary, null);
});

test("buildOperatorStatusFromDiagnosis points running transport content-type warnings at downstream provider transport", () => {
  const runningTask: TaskSnapshot = {
    taskId: "task-3",
    title: "Analyze: repo",
    mode: "analyze",
    state: "running",
    prompt: "Explain the repo",
    paths: [],
    createdAt: "2026-03-21T12:00:00.000Z",
    updatedAt: "2026-03-21T12:01:00.000Z",
    summary: "Codex task turn started.",
    lastOutput: null,
    executionHealth: "degraded",
    runtimeSignals: [
      {
        code: "PROVIDER_TRANSPORT_RUNTIME_WARNING",
        severity: "degraded",
        summary: "Provider transport received an invalid or empty downstream response.",
        detail: 'worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some("missing-content-type; body: "))',
        count: 1,
        lastSeenAt: "2026-03-21T12:00:30.000Z",
      },
    ],
    decision: null,
    approval: null,
    error: null,
    errorCode: null,
    providerKind: "codex",
    providerSessionId: "session-3",
    resultSummary: null,
    providerEvidence: {
      sawTurnStarted: true,
      sawTurnCompleted: false,
      outputFileStatus: "not_used",
      finalMessageSource: "none",
      finalizationPath: "none",
      lastAgentMessagePreview: null,
      stdoutEventTail: ["thread.started", "turn.started"],
    },
  };

  const status = buildOperatorStatusFromDiagnosis(
    {
      gatewayUrl: "ws://127.0.0.1:18789",
      connectionState: "connected",
      callable: true,
      providerStatus: readyProvider,
      findings: [],
    },
    runningTask
  );

  assert.match(status.latestNonFatalSummary ?? "", /PROVIDER_TRANSPORT_RUNTIME_WARNING/);
  assert.equal(
    status.actionableHint,
    "The latest task reached Codex and saw a downstream transport warning about a missing content-type or empty body. It may still recover, but if it remains stuck after turn.started, check MCP, relay, or provider-gateway compatibility."
  );
});

test("buildOperatorStatusFromDiagnosis includes fallback transport detail for failed transport tasks", () => {
  const failedTask: TaskSnapshot = {
    taskId: "task-4",
    title: "Plan: repo",
    mode: "plan",
    state: "failed",
    prompt: "Give me options",
    paths: [],
    createdAt: "2026-03-21T12:00:00.000Z",
    updatedAt: "2026-03-21T12:01:00.000Z",
    summary: "Task failed: transport broke",
    lastOutput: null,
    executionHealth: "failed",
    runtimeSignals: [
      {
        code: "PROVIDER_TRANSPORT_FALLBACK",
        severity: "degraded",
        summary: "Provider transport fell back to a slower or narrower runtime path.",
        detail: "Reconnecting... 1/5 (stream disconnected before completion: Transport error: network error: error decoding response body)",
        count: 1,
        lastSeenAt: "2026-03-21T12:00:30.000Z",
      },
    ],
    decision: null,
    approval: null,
    error: "Codex transport failed while decoding a downstream streaming response. Check the configured relay, proxy, or model-provider compatibility.",
    errorCode: "PROVIDER_TRANSPORT_FAILED",
    providerKind: "codex",
    providerSessionId: "session-4",
    resultSummary: null,
    providerEvidence: {
      sawTurnStarted: true,
      sawTurnCompleted: false,
      outputFileStatus: "not_used",
      finalMessageSource: "none",
      finalizationPath: "timeout",
      lastAgentMessagePreview: null,
      stdoutEventTail: ["thread.started", "turn.started"],
    },
  };

  const status = buildOperatorStatusFromDiagnosis(
    {
      gatewayUrl: "ws://127.0.0.1:18789",
      connectionState: "connected",
      callable: true,
      providerStatus: readyProvider,
      findings: [],
    },
    failedTask
  );

  assert.match(status.latestFailureSummary ?? "", /PROVIDER_TRANSPORT_FAILED/);
  assert.match(status.latestFailureSummary ?? "", /error decoding response body/);
  assert.equal(
    status.actionableHint,
    "Provider transport failed. Check the downstream MCP service status and ensure HTTP responses include a valid content-type."
  );
});
