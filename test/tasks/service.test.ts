import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import { TaskService } from "../../src/tasks/service";
import { TaskStorage } from "../../src/tasks/storage";
import type { ProviderProbeResult, ProviderRunCallbacks, ProviderRunContext, TaskProvider } from "../../src/tasks/provider";
import type { TaskResponseInput, TaskRunResult, TaskSnapshot } from "../../src/tasks/types";
import { makeConfig, makeExtensionContext, makeTempDir, setWorkspaceRoot } from "../test-utils";

class FakeProvider implements TaskProvider {
  readonly kind = "fake";

  constructor(
    private readonly impl: {
      probe?: () => Promise<ProviderProbeResult>;
      startTask: (context: ProviderRunContext, callbacks: ProviderRunCallbacks, signal: AbortSignal) => Promise<TaskRunResult>;
      resumeTask: (
        context: ProviderRunContext,
        response: TaskResponseInput,
        callbacks: ProviderRunCallbacks,
        signal: AbortSignal
      ) => Promise<TaskRunResult>;
    }
  ) {}

  async probe(): Promise<ProviderProbeResult> {
    return await (this.impl.probe?.() ?? Promise.resolve({ ready: true, state: "ready", detail: "ok" }));
  }

  async startTask(context: ProviderRunContext, callbacks: ProviderRunCallbacks, signal: AbortSignal): Promise<TaskRunResult> {
    return await this.impl.startTask(context, callbacks, signal);
  }

  async resumeTask(
    context: ProviderRunContext,
    response: TaskResponseInput,
    callbacks: ProviderRunCallbacks,
    signal: AbortSignal
  ): Promise<TaskRunResult> {
    return await this.impl.resumeTask(context, response, callbacks, signal);
  }
}

test("TaskService drives waiting_decision -> respond -> completed", async () => {
  const rootPath = await makeTempDir("clawdrive-task-service");
  setWorkspaceRoot(rootPath);

  const provider = new FakeProvider({
    async startTask(_context, callbacks) {
      callbacks.onSessionId("session-1");
      callbacks.onProgress("Need a decision.");
      return {
        sessionId: "session-1",
        summary: "Need a decision.",
        output: "option_a: Fast path\noption_b: Safe path",
        decision: {
          summary: "Choose a path.",
          recommendedOptionId: "option_a",
          options: [
            { id: "option_a", title: "Fast path", summary: "Do the fast path.", recommended: true },
            { id: "option_b", title: "Safe path", summary: "Do the safe path.", recommended: false },
          ],
        },
      };
    },
    async resumeTask(_context, response) {
      assert.equal(response.optionId, "option_a");
      return {
        summary: "Plan completed.",
        output: "Implementation-ready plan.",
        decision: null,
      };
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "give me two options", mode: "plan" });
  const waiting = await waitForTaskState(service, queued.taskId, "waiting_decision");
  assert.equal(waiting.decision?.recommendedOptionId, "option_a");

  await service.respondToTask({ taskId: waiting.taskId, optionId: "option_a" });
  const completed = await waitForTaskState(service, waiting.taskId, "completed");
  assert.equal(completed.resultSummary, "Plan completed.");
  assert.equal(completed.errorCode, null);

  const result = await service.getTaskResult(completed.taskId);
  assert.ok(result.events.some((event) => event.type === "waiting_decision"));
  assert.ok(result.events.some((event) => event.type === "completed"));
});

test("TaskService persists provider session ids from apply waiting_decision into resume", async () => {
  const rootPath = await makeTempDir("clawdrive-task-apply-session-resume");
  setWorkspaceRoot(rootPath);

  let resumeSessionId: string | null | undefined;
  const provider = new FakeProvider({
    async startTask(_context, callbacks) {
      callbacks.onSessionId("session-apply-start");
      return {
        sessionId: "session-apply-start",
        summary: "Choose an apply plan.",
        output: "option_a: Update README",
        decision: {
          summary: "Choose an apply plan.",
          recommendedOptionId: "option_a",
          options: [{ id: "option_a", title: "Update README", summary: "Replace README text.", recommended: true }],
        },
      };
    },
    async resumeTask(context, response) {
      resumeSessionId = context.sessionId;
      assert.equal(response.optionId, "option_a");
      return {
        sessionId: context.sessionId,
        summary: "Ready to apply README update.",
        output: "write_file README.md",
        approval: {
          summary: "Update README.md content.",
          operations: [{ type: "write_file", path: "README.md", content: "after" }],
        },
      };
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "fix the README", mode: "apply" });
  const waitingDecision = await waitForTaskState(service, queued.taskId, "waiting_decision");
  assert.equal(waitingDecision.providerSessionId, "session-apply-start");

  await service.respondToTask({ taskId: waitingDecision.taskId, optionId: "option_a" });
  const waitingApproval = await waitForTaskState(service, waitingDecision.taskId, "waiting_approval");

  assert.equal(resumeSessionId, "session-apply-start");
  assert.equal(waitingApproval.providerSessionId, "session-apply-start");
});

test("TaskService returns provider evidence through task.result", async () => {
  const rootPath = await makeTempDir("clawdrive-task-provider-evidence");
  setWorkspaceRoot(rootPath);

  const provider = new FakeProvider({
    async startTask(_context, callbacks) {
      callbacks.onEvidence({
        sawTurnStarted: true,
        sawTurnCompleted: true,
        outputFileStatus: "empty",
        lastAgentMessagePreview: "{\"summary\":\"Choose a path.\"}",
        stdoutEventTail: ["thread.started", "turn.started", "item.completed:agent_message", "turn.completed"],
      });
      return {
        summary: "Choose a path.",
        output: "option_a: A\noption_b: B",
        decision: {
          summary: "Choose a path.",
          recommendedOptionId: "option_a",
          options: [
            { id: "option_a", title: "A", summary: "Preferred", recommended: true },
            { id: "option_b", title: "B", summary: "Fallback", recommended: false },
          ],
        },
        providerEvidence: {
          finalMessageSource: "stream_capture",
        },
      };
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "give me two options", mode: "plan" });
  const waiting = await waitForTaskState(service, queued.taskId, "waiting_decision");
  const result = await service.getTaskResult(waiting.taskId);
  assert.equal(result.providerEvidence?.finalMessageSource, "stream_capture");
  assert.equal(result.providerEvidence?.outputFileStatus, "empty");
  assert.deepEqual(result.providerEvidence?.stdoutEventTail, [
    "thread.started",
    "turn.started",
    "item.completed:agent_message",
    "turn.completed",
  ]);
});

test("TaskService exposes degraded completed fallback evidence without treating it as failure", async () => {
  const rootPath = await makeTempDir("clawdrive-task-degraded-completed-contract");
  setWorkspaceRoot(rootPath);

  const provider = new FakeProvider({
    async startTask() {
      return {
        executionHealth: "degraded",
        summary: "Completed with fallback output.",
        output: "Fallback output from provider finalization.",
        providerEvidence: {
          sawTurnStarted: true,
          sawTurnCompleted: false,
          outputFileStatus: "empty",
          finalizationPath: "timeout",
          finalMessageSource: "stdout_scan",
          lastAgentMessagePreview: "Fallback summary from the final agent message.",
          rawStdoutPreview: "raw provider stdout preview",
          stdoutEventTail: ["thread.started", "turn.started", "fallback.completed"],
          runtimeSignals: [
            {
              code: "PROVIDER_RESULT_STALL_WARNING",
              severity: "degraded",
              summary: "Provider finalization used a degraded fallback path.",
              detail: "final message recovered after timeout",
            },
          ],
          fallbackReason: "final message recovered after timeout",
        },
      };
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "explain the repo", mode: "analyze" });
  const completed = await waitForTaskState(service, queued.taskId, "completed");
  const result = await service.getTaskResult(completed.taskId);

  assert.equal(completed.state, "completed");
  assert.equal(completed.errorCode, null);
  assert.equal(result.executionHealth, "degraded");
  assert.equal(result.summary, "Completed with fallback output.");
  assert.equal(result.output, "Fallback output from provider finalization.");
  assert.equal(result.providerEvidence?.fallbackReason, "final message recovered after timeout");
  assert.equal(result.providerEvidence?.finalizationPath, "timeout");
});

test("TaskService keeps degraded completed health when provider omits runtime signals", async () => {
  const rootPath = await makeTempDir("clawdrive-task-degraded-no-signals-contract");
  setWorkspaceRoot(rootPath);

  const provider = new FakeProvider({
    async startTask() {
      return {
        executionHealth: "degraded",
        summary: "Completed with degraded provider health.",
        output: "Usable output from a degraded provider path.",
        providerEvidence: {
          fallbackReason: "provider reported degraded health without signal details",
        },
      };
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "explain the repo", mode: "analyze" });
  const completed = await waitForTaskState(service, queued.taskId, "completed");
  const result = await service.getTaskResult(completed.taskId);

  assert.equal(completed.state, "completed");
  assert.equal(completed.runtimeSignals.length, 0);
  assert.equal(completed.executionHealth, "degraded");
  assert.equal(result.executionHealth, "degraded");
  assert.equal(result.providerEvidence?.fallbackReason, "provider reported degraded health without signal details");
});

test("TaskService exposes degraded waiting decision fallback evidence without treating it as clean success", async () => {
  const rootPath = await makeTempDir("clawdrive-task-degraded-decision-contract");
  setWorkspaceRoot(rootPath);

  const provider = new FakeProvider({
    async startTask() {
      return {
        executionHealth: "degraded",
        summary: "Choose a degraded fallback path.",
        output: "option_a: Use recovered fallback\noption_b: Retry provider",
        decision: {
          summary: "Choose a degraded fallback path.",
          recommendedOptionId: "option_a",
          options: [
            { id: "option_a", title: "Use recovered fallback", summary: "Continue with degraded evidence.", recommended: true },
            { id: "option_b", title: "Retry provider", summary: "Discard fallback and retry.", recommended: false },
          ],
        },
        providerEvidence: {
          sawTurnStarted: true,
          sawTurnCompleted: false,
          outputFileStatus: "empty",
          finalizationPath: "timeout",
          finalMessageSource: "stdout_scan",
          lastAgentMessagePreview: "Recovered waiting decision preview.",
          rawStdoutPreview: "raw waiting decision stdout preview",
          stdoutEventTail: ["thread.started", "turn.started", "decision.fallback"],
          runtimeSignals: [
            {
              code: "PROVIDER_PLAN_OUTPUT_RETRY",
              severity: "degraded",
              summary: "Plan output was recovered through a degraded fallback path.",
              detail: "waiting decision recovered after retry",
            },
          ],
          fallbackReason: "waiting decision recovered after retry",
        },
      };
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "give me two next-step options", mode: "plan" });
  const waiting = await waitForTaskState(service, queued.taskId, "waiting_decision");
  const result = await service.getTaskResult(waiting.taskId);

  assert.equal(waiting.errorCode, null);
  assert.equal(result.executionHealth, "degraded");
  assert.equal(result.snapshot.executionHealth, "degraded");
  assert.equal(result.summary, "Choose a degraded fallback path.");
  assert.equal(result.output, "option_a: Use recovered fallback\noption_b: Retry provider");
  assert.ok(result.decision);
  assert.equal(result.providerEvidence?.fallbackReason, "waiting decision recovered after retry");
  assert.equal(result.providerEvidence?.runtimeSignals?.[0]?.code, "PROVIDER_PLAN_OUTPUT_RETRY");
});

test("TaskService allows read-only analyze prompts that mention do not modify", async () => {
  const rootPath = await makeTempDir("clawdrive-task-analyze-readonly");
  setWorkspaceRoot(rootPath);

  const provider = new FakeProvider({
    async startTask(context) {
      assert.equal(context.mode, "analyze");
      return {
        summary: "Analysis complete.",
        output: "Read-only analysis.",
        decision: null,
      };
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({
    prompt: "Analyze the repository purpose and task pipeline. Do not modify files.",
    mode: "analyze",
  });
  const completed = await waitForTaskState(service, queued.taskId, "completed");
  assert.equal(completed.resultSummary, "Analysis complete.");
  assert.equal(completed.errorCode, null);
});

test("TaskService still blocks explicit write requests in analyze mode", async () => {
  const rootPath = await makeTempDir("clawdrive-task-analyze-blocked");
  setWorkspaceRoot(rootPath);

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () =>
      new FakeProvider({
        async startTask() {
          throw new Error("not used");
        },
        async resumeTask() {
          throw new Error("not used");
        },
      }),
  });
  await service.initialize();

  await assert.rejects(
    () => service.startTask({ prompt: "Modify README.md to add setup steps.", mode: "analyze" }),
    (error: unknown) => {
      assert.match(String(error), /apply mode|规划方案/i);
      return true;
    }
  );
});

test("TaskService coalesces concurrent provider refreshes into a single probe", async () => {
  const rootPath = await makeTempDir("clawdrive-task-provider-refresh");
  setWorkspaceRoot(rootPath);

  let createCount = 0;
  let probeCount = 0;
  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => {
      createCount += 1;
      return new FakeProvider({
        async probe() {
          probeCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { ready: true, state: "ready", detail: "ok" };
        },
        async startTask() {
          throw new Error("not used");
        },
        async resumeTask() {
          throw new Error("not used");
        },
      });
    },
  });

  await service.initialize({ probeProvider: false });
  const [left, right] = await Promise.all([service.refreshProviderStatus(), service.refreshProviderStatus()]);

  assert.equal(left.state, "ready");
  assert.equal(right.state, "ready");
  assert.equal(probeCount, 1);
  assert.equal(createCount, 2);
});

test("TaskService falls back to codex when configured claude provider is not ready", async () => {
  const rootPath = await makeTempDir("clawdrive-task-provider-fallback");
  setWorkspaceRoot(rootPath);

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig({ providerKind: "claude", providerFallbackToAlternate: true }),
    createProvider: (config) => {
      if (config.providerKind === "claude") {
        return new FakeProvider({
          async probe() {
            return {
              ready: false,
              state: "missing",
              detail: "Claude Code executable was not found. Check clawdrive.provider.claude.path and local installation.",
            };
          },
          async startTask() {
            throw new Error("not used");
          },
          async resumeTask() {
            throw new Error("not used");
          },
        });
      }
      return {
        kind: "codex",
        async probe() {
          return { ready: true, state: "ready", detail: "Using codex." };
        },
        async startTask() {
          return {
            summary: "Fallback provider completed.",
            output: "Fallback analysis.",
          };
        },
        async resumeTask() {
          throw new Error("not used");
        },
      } satisfies TaskProvider;
    },
  });

  await service.initialize();
  const providerStatus = service.getProviderStatus();
  assert.equal(providerStatus.ready, true);
  assert.equal(providerStatus.label, "Ready (Codex CLI)");
  assert.match(providerStatus.detail, /Configured Claude Code CLI is unavailable/i);

  const queued = await service.startTask({ prompt: "Explain the repository.", mode: "analyze" });
  const completed = await waitForTaskState(service, queued.taskId, "completed");
  assert.equal(completed.providerKind, "codex");
  assert.equal(completed.resultSummary, "Fallback provider completed.");
});

test("TaskService allows task start after an inconclusive Claude probe", async () => {
  const rootPath = await makeTempDir("clawdrive-task-inconclusive-probe");
  setWorkspaceRoot(rootPath);

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig({ providerKind: "claude", providerFallbackToAlternate: false }),
    createProvider: () => ({
      kind: "claude",
      async probe() {
        return {
          ready: true,
          state: "ready",
          detail:
            "Using claude. Probe was inconclusive: Claude Code stalled after turn start without producing a usable result. Tasks will validate runtime readiness on execution.",
        };
      },
      async startTask() {
        return {
          summary: "Plan completed.",
          output: "Runtime task execution still works.",
        };
      },
      async resumeTask() {
        throw new Error("not used");
      },
    } satisfies TaskProvider),
  });

  await service.initialize();
  const providerStatus = service.getProviderStatus();
  assert.equal(providerStatus.ready, true);
  assert.equal(providerStatus.state, "ready");
  assert.match(providerStatus.detail, /probe was inconclusive/i);

  const queued = await service.startTask({ prompt: "Explain the repository.", mode: "analyze" });
  const completed = await waitForTaskState(service, queued.taskId, "completed");
  assert.equal(completed.errorCode, null);
  assert.equal(completed.resultSummary, "Plan completed.");
});

test("TaskService restore converts running tasks to interrupted", async () => {
  const rootPath = await makeTempDir("clawdrive-task-restore");
  setWorkspaceRoot(rootPath);

  const storage = new TaskStorage(rootPath, 20);
  await storage.initialize();
  await storage.saveSnapshot(makeSnapshot({ taskId: "running-task", state: "running", summary: "Still running." }));

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () =>
      new FakeProvider({
        async startTask() {
          throw new Error("not used");
        },
        async resumeTask() {
          throw new Error("not used");
        },
      }),
  });

  await service.initialize();
  const restored = service.getTask("running-task");
  assert.equal(restored.state, "interrupted");
  assert.equal(restored.errorCode, null);
});

test("TaskService timeout is marked differently from cancellation", async () => {
  const rootPath = await makeTempDir("clawdrive-task-timeout");
  setWorkspaceRoot(rootPath);

  const provider = new FakeProvider({
    async startTask(_context, _callbacks, signal) {
      return await new Promise<TaskRunResult>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error(String(signal.reason ?? "aborted"))),
          { once: true }
        );
      });
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig({ tasksDefaultTimeoutMs: 5_000 }),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "explain the repo", mode: "analyze" });
  const failed = await waitForTaskState(service, queued.taskId, "failed", 8_000);
  assert.equal(failed.errorCode, "TASK_TIMEOUT");
});

test("TaskService active cancellation returns the settled cancelled snapshot", async () => {
  const rootPath = await makeTempDir("clawdrive-task-cancel");
  setWorkspaceRoot(rootPath);

  const provider = new FakeProvider({
    async startTask(_context, callbacks, signal) {
      callbacks.onProgress("Running analysis.");
      return await new Promise<TaskRunResult>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => setTimeout(() => reject(new Error(String(signal.reason ?? "aborted"))), 50),
          { once: true }
        );
      });
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig({ tasksDefaultTimeoutMs: 5_000 }),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "explain the repo", mode: "analyze" });
  await waitForTaskCondition(service, queued.taskId, (task) => task.state === "running");

  const cancelled = await service.cancelTask(queued.taskId);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.summary, "Task cancelled.");

  const stored = await waitForTaskState(service, queued.taskId, "cancelled");
  assert.equal(stored.state, "cancelled");
});

test("TaskService deleteTask removes a terminal task from memory and persisted storage", async () => {
  const rootPath = await makeTempDir("clawdrive-task-delete-terminal");
  setWorkspaceRoot(rootPath);

  const storage = new TaskStorage(rootPath, 20);
  await storage.initialize();
  await storage.saveSnapshot(
    makeSnapshot({
      taskId: "completed-task",
      state: "completed",
      updatedAt: "2026-03-21T12:02:00.000Z",
    })
  );
  await storage.saveSnapshot(
    makeSnapshot({
      taskId: "failed-task",
      state: "failed",
      updatedAt: "2026-03-21T12:01:00.000Z",
    })
  );

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () =>
      new FakeProvider({
        async startTask() {
          throw new Error("not used");
        },
        async resumeTask() {
          throw new Error("not used");
        },
      }),
  });
  await service.initialize();

  await service.deleteTask("completed-task");

  assert.deepEqual(
    service.listAllTasks().map((task) => task.taskId),
    ["failed-task"]
  );
  assert.equal(await storage.readSnapshot("completed-task"), null);
  assert.ok(await storage.readSnapshot("failed-task"));

  const restored = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () =>
      new FakeProvider({
        async startTask() {
          throw new Error("not used");
        },
        async resumeTask() {
          throw new Error("not used");
        },
      }),
  });
  await restored.initialize();
  assert.deepEqual(
    restored.listAllTasks().map((task) => task.taskId),
    ["failed-task"]
  );
});

test("TaskService deleteTask rejects non-terminal tasks and leaves them untouched", async () => {
  const rootPath = await makeTempDir("clawdrive-task-delete-active");
  setWorkspaceRoot(rootPath);

  const storage = new TaskStorage(rootPath, 20);
  await storage.initialize();
  await storage.saveSnapshot(
    makeSnapshot({
      taskId: "interrupted-task",
      state: "interrupted",
      summary: "Task was interrupted and can be resumed.",
    })
  );

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () =>
      new FakeProvider({
        async startTask() {
          throw new Error("not used");
        },
        async resumeTask() {
          throw new Error("not used");
        },
      }),
  });
  await service.initialize();

  await assert.rejects(
    () => service.deleteTask("interrupted-task"),
    /Only completed, failed, or cancelled tasks can be deleted/i
  );
  assert.equal(service.getTask("interrupted-task").state, "interrupted");
  assert.ok(await storage.readSnapshot("interrupted-task"));
});

test("TaskService deleteTerminalTasks removes only terminal task history", async () => {
  const rootPath = await makeTempDir("clawdrive-task-delete-terminal-batch");
  setWorkspaceRoot(rootPath);

  const storage = new TaskStorage(rootPath, 20);
  await storage.initialize();
  for (const snapshot of [
    makeSnapshot({ taskId: "completed-task", state: "completed", updatedAt: "2026-03-21T12:07:00.000Z" }),
    makeSnapshot({ taskId: "failed-task", state: "failed", updatedAt: "2026-03-21T12:06:00.000Z" }),
    makeSnapshot({ taskId: "cancelled-task", state: "cancelled", updatedAt: "2026-03-21T12:05:00.000Z" }),
    makeSnapshot({ taskId: "waiting-decision-task", state: "waiting_decision", updatedAt: "2026-03-21T12:04:00.000Z" }),
    makeSnapshot({ taskId: "waiting-approval-task", state: "waiting_approval", updatedAt: "2026-03-21T12:03:00.000Z" }),
    makeSnapshot({ taskId: "interrupted-task", state: "interrupted", updatedAt: "2026-03-21T12:02:00.000Z" }),
  ]) {
    await storage.saveSnapshot(snapshot);
  }

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () =>
      new FakeProvider({
        async startTask() {
          throw new Error("not used");
        },
        async resumeTask() {
          throw new Error("not used");
        },
      }),
  });
  await service.initialize();

  const result = await service.deleteTerminalTasks();

  assert.deepEqual(result, { requested: 3, completed: 3, skipped: 0 });
  assert.deepEqual(
    service.listAllTasks().map((task) => task.taskId),
    ["waiting-decision-task", "waiting-approval-task", "interrupted-task"]
  );
  assert.equal(await storage.readSnapshot("completed-task"), null);
  assert.equal(await storage.readSnapshot("failed-task"), null);
  assert.equal(await storage.readSnapshot("cancelled-task"), null);
  assert.ok(await storage.readSnapshot("waiting-decision-task"));
  assert.ok(await storage.readSnapshot("waiting-approval-task"));
  assert.ok(await storage.readSnapshot("interrupted-task"));
});

test("TaskService cancelActiveTasks cancels only active and resumable tasks", async () => {
  const rootPath = await makeTempDir("clawdrive-task-cancel-active-batch");
  setWorkspaceRoot(rootPath);

  const storage = new TaskStorage(rootPath, 20);
  await storage.initialize();
  for (const snapshot of [
    makeSnapshot({ taskId: "queued-task", state: "queued", updatedAt: "2026-03-21T12:08:00.000Z" }),
    makeSnapshot({ taskId: "running-task", state: "running", updatedAt: "2026-03-21T12:07:00.000Z" }),
    makeSnapshot({ taskId: "waiting-decision-task", state: "waiting_decision", updatedAt: "2026-03-21T12:06:00.000Z" }),
    makeSnapshot({ taskId: "waiting-approval-task", state: "waiting_approval", updatedAt: "2026-03-21T12:05:00.000Z" }),
    makeSnapshot({ taskId: "interrupted-task", state: "interrupted", updatedAt: "2026-03-21T12:04:00.000Z" }),
    makeSnapshot({ taskId: "completed-task", state: "completed", updatedAt: "2026-03-21T12:03:00.000Z" }),
    makeSnapshot({ taskId: "failed-task", state: "failed", updatedAt: "2026-03-21T12:02:00.000Z" }),
    makeSnapshot({ taskId: "cancelled-task", state: "cancelled", updatedAt: "2026-03-21T12:01:00.000Z" }),
  ]) {
    await storage.saveSnapshot(snapshot);
  }

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () =>
      new FakeProvider({
        async startTask() {
          throw new Error("not used");
        },
        async resumeTask() {
          throw new Error("not used");
        },
      }),
  });
  await service.initialize({ probeProvider: false });

  const result = await service.cancelActiveTasks();

  assert.deepEqual(result, { requested: 5, completed: 5, skipped: 0 });
  assert.equal(service.getTask("queued-task").state, "cancelled");
  assert.equal(service.getTask("running-task").state, "cancelled");
  assert.equal(service.getTask("waiting-decision-task").state, "cancelled");
  assert.equal(service.getTask("waiting-approval-task").state, "cancelled");
  assert.equal(service.getTask("interrupted-task").state, "cancelled");
  assert.equal(service.getTask("completed-task").state, "completed");
  assert.equal(service.getTask("failed-task").state, "failed");
  assert.equal(service.getTask("cancelled-task").state, "cancelled");
});

test("TaskService drives apply through waiting_decision -> waiting_approval -> completed", async () => {
  const rootPath = await makeTempDir("clawdrive-task-apply");
  setWorkspaceRoot(rootPath);

  await import("fs/promises").then((fs) => fs.writeFile(`${rootPath}\\README.md`, "before", "utf8"));

  const provider = new FakeProvider({
    async startTask() {
      return {
        summary: "Choose an apply plan.",
        output: "option_a: Update README",
        decision: {
          summary: "Choose an apply plan.",
          recommendedOptionId: "option_a",
          options: [{ id: "option_a", title: "Update README", summary: "Replace README text.", recommended: true }],
        },
      };
    },
    async resumeTask(_context, response) {
      assert.equal(response.optionId, "option_a");
      return {
        summary: "Ready to apply README update.",
        output: "write_file README.md",
        approval: {
          summary: "Update README.md content.",
          operations: [{ type: "write_file", path: "README.md", content: "after" }],
        },
      };
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "fix the README", mode: "apply" });
  const waitingDecision = await waitForTaskState(service, queued.taskId, "waiting_decision");
  await service.respondToTask({ taskId: waitingDecision.taskId, optionId: "option_a" });
  const waitingApproval = await waitForTaskState(service, waitingDecision.taskId, "waiting_approval");
  assert.equal(waitingApproval.approval?.operations.length, 1);

  await service.respondToTask({ taskId: waitingApproval.taskId, approval: "approved" });
  const completed = await waitForTaskState(service, waitingApproval.taskId, "completed");
  assert.equal(completed.errorCode, null);
  assert.match(completed.summary, /Applied 1 operation/);

  const fs = await import("fs/promises");
  assert.equal(await fs.readFile(`${rootPath}\\README.md`, "utf8"), "after");
});

test("TaskService rejects apply approval without modifying files", async () => {
  const rootPath = await makeTempDir("clawdrive-task-reject");
  setWorkspaceRoot(rootPath);

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () =>
      new FakeProvider({
        async startTask() {
          throw new Error("not used");
        },
        async resumeTask() {
          throw new Error("not used");
        },
      }),
  });
  await service.initialize();

  const storage = new TaskStorage(rootPath, 20);
  await storage.initialize();
  await storage.saveSnapshot(
    makeSnapshot({
      taskId: "apply-waiting",
      mode: "apply",
      state: "waiting_approval",
      approval: {
        summary: "Would update README.md",
        operations: [{ type: "write_file", path: "README.md", content: "after" }],
      },
    })
  );

  const restored = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () =>
      new FakeProvider({
        async startTask() {
          throw new Error("not used");
        },
        async resumeTask() {
          throw new Error("not used");
        },
      }),
  });
  await restored.initialize();

  const rejected = await restored.respondToTask({ taskId: "apply-waiting", approval: "rejected" });
  assert.equal(rejected.state, "cancelled");
  assert.equal(rejected.summary, "Apply request rejected.");
});

test("TaskService collapses repeated runtime warnings and completes with warning health", async () => {
  const rootPath = await makeTempDir("clawdrive-task-runtime-warning");
  setWorkspaceRoot(rootPath);

  const provider = new FakeProvider({
    async startTask(_context, callbacks) {
      callbacks.onRuntimeSignal(
        {
          code: "PROVIDER_RUNTIME_HELPER_WARNING",
          severity: "noise",
          summary: "Provider emitted a non-fatal helper or startup warning.",
          detail: "helper warning",
        },
        "helper warning"
      );
      callbacks.onRuntimeSignal(
        {
          code: "PROVIDER_RUNTIME_HELPER_WARNING",
          severity: "noise",
          summary: "Provider emitted a non-fatal helper or startup warning.",
          detail: "helper warning",
        },
        "helper warning"
      );
      return {
        summary: "Analysis completed.",
        output: "Repository summary.",
      };
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "explain the repo", mode: "analyze" });
  const completed = await waitForTaskState(service, queued.taskId, "completed");
  assert.equal(completed.executionHealth, "warning");
  assert.equal(completed.runtimeSignals.length, 1);
  assert.equal(completed.runtimeSignals[0].count, 2);

  const result = await service.getTaskResult(completed.taskId);
  assert.equal(result.executionHealth, "warning");
  assert.equal(result.runtimeSignals[0].code, "PROVIDER_RUNTIME_HELPER_WARNING");
});

test("TaskService marks completed tasks as degraded when runtime fallback warnings occur", async () => {
  const rootPath = await makeTempDir("clawdrive-task-runtime-degraded");
  setWorkspaceRoot(rootPath);

  const provider = new FakeProvider({
    async startTask(_context, callbacks) {
      callbacks.onRuntimeSignal(
        {
          code: "PROVIDER_TRANSPORT_FALLBACK",
          severity: "degraded",
          summary: "Provider transport fell back to a slower or narrower runtime path.",
          detail: "falling back to HTTP",
        },
        "falling back to HTTP"
      );
      return {
        summary: "Plan completed.",
        output: "Two options ready.",
      };
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "give me two options", mode: "plan" });
  const completed = await waitForTaskState(service, queued.taskId, "completed");
  assert.equal(completed.executionHealth, "degraded");
  assert.equal(completed.runtimeSignals[0].severity, "degraded");
});

test("TaskService falls back to bounded local read-only planning when provider-backed repo analysis stalls", async () => {
  const rootPath = await makeTempDir("clawdrive-task-readonly-fallback-plan");
  setWorkspaceRoot(rootPath);
  await seedReadonlyFallbackWorkspace(rootPath);

  const provider = new FakeProvider({
    async startTask(_context, callbacks) {
      callbacks.onRuntimeSignal(
        {
          code: "PROVIDER_TRANSPORT_FALLBACK",
          severity: "degraded",
          summary: "Provider transport fell back to a slower or narrower runtime path.",
          detail: "Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)",
        },
        "Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)"
      );
      callbacks.onEvidence({
        sawTurnStarted: true,
        sawTurnCompleted: false,
        finalizationPath: "timeout",
        stdoutEventTail: ["thread.started", "turn.started"],
      });
      throw Object.assign(new Error("Codex turn did not complete within 240s after turn start."), {
        code: "PROVIDER_TURN_STALLED",
      });
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({
    prompt:
      "Analyze the current workspace and return a structured report with repository purpose, top-level module breakdown, likely entry points, task pipeline locations, and a recommended file-reading order for debugging the VS Code task pipeline. Do not modify files.",
    mode: "plan",
  });
  const waiting = await waitForTaskState(service, queued.taskId, "waiting_decision", 5_000);

  assert.equal(waiting.executionHealth, "degraded");
  assert.equal(waiting.errorCode, null);
  assert.ok(waiting.runtimeSignals.some((signal) => signal.code === "PROVIDER_TRANSPORT_FALLBACK"));
  assert.ok(waiting.runtimeSignals.some((signal) => signal.code === "PROVIDER_LOCAL_READONLY_FALLBACK"));
  assert.ok((waiting.decision?.options.length ?? 0) >= 2);
  assert.match(waiting.resultSummary ?? "", /bounded local read-only plan|受限的只读计划/i);
  assert.match(waiting.lastOutput ?? "", /Task Pipeline Locations|任务链路位置/i);
});

test("TaskService falls back to bounded local read-only planning on transport failure after turn start", async () => {
  const rootPath = await makeTempDir("clawdrive-task-readonly-fallback-transport");
  setWorkspaceRoot(rootPath);
  await seedReadonlyFallbackWorkspace(rootPath);

  const provider = new FakeProvider({
    async startTask(_context, callbacks) {
      callbacks.onRuntimeSignal(
        {
          code: "PROVIDER_TRANSPORT_RUNTIME_WARNING",
          severity: "degraded",
          summary: "Provider transport received an invalid or empty downstream response.",
          detail:
            'worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some("missing-content-type; body: "))',
        },
        'worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some("missing-content-type; body: "))'
      );
      callbacks.onEvidence({
        sawTurnStarted: true,
        sawTurnCompleted: false,
        finalizationPath: "timeout",
        stdoutEventTail: ["thread.started", "turn.started", "item.updated:todo_list"],
      });
      throw Object.assign(
        new Error(
          'worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some("missing-content-type; body: "))'
        ),
        { code: "PROVIDER_TRANSPORT_FAILED" }
      );
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({
    prompt:
      "Analyze the current workspace and return a structured report with repository purpose, top-level module breakdown, likely entry points, task pipeline locations, and a recommended file-reading order for debugging the VS Code task pipeline. Do not modify files.",
    mode: "plan",
  });
  const waiting = await waitForTaskState(service, queued.taskId, "waiting_decision", 5_000);

  assert.equal(waiting.executionHealth, "degraded");
  assert.equal(waiting.errorCode, null);
  assert.ok(waiting.runtimeSignals.some((signal) => signal.code === "PROVIDER_TRANSPORT_RUNTIME_WARNING"));
  assert.ok(waiting.runtimeSignals.some((signal) => signal.code === "PROVIDER_LOCAL_READONLY_FALLBACK"));
  assert.ok((waiting.decision?.options.length ?? 0) >= 2);
  assert.match(waiting.resultSummary ?? "", /bounded local read-only plan|受限的只读计划/i);
});

test("TaskService aborts hung provider runs after hard transport warnings and settles via read-only fallback", async () => {
  const rootPath = await makeTempDir("clawdrive-task-transport-watchdog");
  setWorkspaceRoot(rootPath);
  await seedReadonlyFallbackWorkspace(rootPath);

  const provider = new FakeProvider({
    async startTask(_context, callbacks, signal) {
      callbacks.onProgress("Codex task turn started.");
      callbacks.onEvidence({
        sawTurnStarted: true,
        sawTurnCompleted: false,
        finalizationPath: "none",
        stdoutEventTail: ["thread.started", "turn.started"],
      });
      callbacks.onRuntimeSignal(
        {
          code: "PROVIDER_TRANSPORT_RUNTIME_WARNING",
          severity: "degraded",
          summary: "Provider transport received an invalid or empty downstream response.",
          detail:
            'worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some("missing-content-type; body: "))',
        },
        'worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some("missing-content-type; body: "))'
      );
      return await new Promise<TaskRunResult>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error(String(signal.reason ?? "aborted"))), { once: true });
      });
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig({ tasksDefaultTimeoutMs: 30_000 }),
    createProvider: () => provider,
  });
  await service.initialize();

  const startedAt = Date.now();
  const queued = await service.startTask({
    prompt: "Return the current workspace name and whether an active editor exists. Do not modify anything.",
    mode: "plan",
  });
  const waiting = await waitForTaskState(service, queued.taskId, "waiting_decision", 12_000);

  assert.equal(waiting.executionHealth, "degraded");
  assert.equal(waiting.errorCode, null);
  assert.ok(Date.now() - startedAt < 15_000);
  assert.ok(waiting.runtimeSignals.some((signal) => signal.code === "PROVIDER_TRANSPORT_RUNTIME_WARNING"));
  assert.ok(waiting.runtimeSignals.some((signal) => signal.code === "PROVIDER_LOCAL_READONLY_FALLBACK"));
  assert.match(waiting.resultSummary ?? "", /bounded local read-only plan/i);
});

test("TaskService does not abort recoverable runs that produce a result soon after a hard transport warning", async () => {
  const rootPath = await makeTempDir("clawdrive-task-transport-watchdog-recover");
  setWorkspaceRoot(rootPath);

  const provider = new FakeProvider({
    async startTask(_context, callbacks) {
      callbacks.onProgress("Codex task turn started.");
      callbacks.onEvidence({
        sawTurnStarted: true,
        sawTurnCompleted: false,
        finalizationPath: "none",
        stdoutEventTail: ["thread.started", "turn.started"],
      });
      callbacks.onRuntimeSignal(
        {
          code: "PROVIDER_TRANSPORT_RUNTIME_WARNING",
          severity: "degraded",
          summary: "Provider transport received an invalid or empty downstream response.",
          detail:
            'worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some("missing-content-type; body: "))',
        },
        'worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some("missing-content-type; body: "))'
      );
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return {
        summary: "Recovered plan output.",
        output: "option_a: Recover and continue\noption_b: Retry from scratch",
        decision: {
          summary: "Recovered plan output.",
          recommendedOptionId: "option_a",
          options: [
            { id: "option_a", title: "Recover and continue", summary: "Use the recovered provider result.", recommended: true },
            { id: "option_b", title: "Retry from scratch", summary: "Discard the recovered result and retry.", recommended: false },
          ],
        },
        providerEvidence: {
          sawTurnCompleted: true,
          finalizationPath: "stream_capture",
          finalMessageSource: "stream_capture",
          lastAgentMessagePreview: "Recovered plan output.",
          stdoutEventTail: ["thread.started", "turn.started", "item.completed:agent_message", "turn.completed"],
        },
      };
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig({ tasksDefaultTimeoutMs: 30_000 }),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "Return two safe options and do not modify anything.", mode: "plan" });
  const waiting = await waitForTaskState(service, queued.taskId, "waiting_decision", 8_000);

  assert.equal(waiting.executionHealth, "degraded");
  assert.equal(waiting.errorCode, null);
  assert.equal(waiting.resultSummary, "Recovered plan output.");
  assert.ok(waiting.runtimeSignals.some((signal) => signal.code === "PROVIDER_TRANSPORT_RUNTIME_WARNING"));
  assert.ok(!waiting.runtimeSignals.some((signal) => signal.code === "PROVIDER_LOCAL_READONLY_FALLBACK"));
});

test("TaskService aborts hung apply runs after hard transport warnings and marks them failed", async () => {
  const rootPath = await makeTempDir("clawdrive-task-transport-watchdog-apply");
  setWorkspaceRoot(rootPath);

  const provider = new FakeProvider({
    async startTask(_context, callbacks, signal) {
      callbacks.onProgress("Codex task turn started.");
      callbacks.onEvidence({
        sawTurnStarted: true,
        sawTurnCompleted: false,
        finalizationPath: "none",
        stdoutEventTail: ["thread.started", "turn.started"],
      });
      callbacks.onRuntimeSignal(
        {
          code: "PROVIDER_TRANSPORT_RUNTIME_WARNING",
          severity: "degraded",
          summary: "Provider transport received an invalid or empty downstream response.",
          detail:
            'worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some("missing-content-type; body: "))',
        },
        'worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some("missing-content-type; body: "))'
      );
      return await new Promise<TaskRunResult>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error(String(signal.reason ?? "aborted"))), { once: true });
      });
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig({ tasksDefaultTimeoutMs: 30_000 }),
    createProvider: () => provider,
  });
  await service.initialize();

  const startedAt = Date.now();
  const queued = await service.startTask({ prompt: "Implement the requested fix.", mode: "apply" });
  const failed = await waitForTaskState(service, queued.taskId, "failed", 12_000);

  assert.equal(failed.executionHealth, "failed");
  assert.equal(failed.errorCode, "PROVIDER_TRANSPORT_FAILED");
  assert.ok(Date.now() - startedAt < 15_000);
  assert.ok(failed.runtimeSignals.some((signal) => signal.code === "PROVIDER_TRANSPORT_RUNTIME_WARNING"));
  assert.ok(!failed.runtimeSignals.some((signal) => signal.code === "PROVIDER_LOCAL_READONLY_FALLBACK"));
});

test("TaskService reclassifies generic stalled provider failures as transport failures when transport warnings were recorded", async () => {
  const rootPath = await makeTempDir("clawdrive-task-transport-reclassify");
  setWorkspaceRoot(rootPath);

  const provider = new FakeProvider({
    async startTask(_context, callbacks) {
      callbacks.onRuntimeSignal(
        {
          code: "PROVIDER_TRANSPORT_FALLBACK",
          severity: "degraded",
          summary: "Provider transport fell back to a slower or narrower runtime path.",
          detail: "Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)",
        },
        "Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)"
      );
      throw Object.assign(new Error("Codex turn did not complete within 240s after turn start."), {
        code: "PROVIDER_TURN_STALLED",
      });
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "Plan how to fix the failing README workflow.", mode: "apply" });
  const failed = await waitForTaskState(service, queued.taskId, "failed", 5_000);

  assert.equal(failed.errorCode, "PROVIDER_TRANSPORT_FAILED");
  assert.match(failed.error ?? "", /downstream service|compatibility/i);
});

test("TaskService preserves fatal runtime signals when the provider fails", async () => {
  const rootPath = await makeTempDir("clawdrive-task-runtime-fatal");
  setWorkspaceRoot(rootPath);

  const provider = new FakeProvider({
    async startTask(_context, callbacks) {
      callbacks.onRuntimeSignal(
        {
          code: "PROVIDER_AUTH_FAILED",
          severity: "fatal",
          summary: "Provider authentication failed while contacting the upstream model service.",
          detail: "401 unauthorized",
        },
        "401 unauthorized"
      );
      throw Object.assign(new Error("unexpected status 401 Unauthorized"), { code: "PROVIDER_AUTH_FAILED" });
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "plan the next step", mode: "plan" });
  const failed = await waitForTaskState(service, queued.taskId, "failed");
  assert.equal(failed.executionHealth, "failed");
  assert.equal(failed.errorCode, "PROVIDER_AUTH_FAILED");
  assert.equal(failed.runtimeSignals[0].severity, "fatal");
});


test("TaskService uses readonly fallback for empty provider output during simple plan tasks", async () => {
  const rootPath = await makeTempDir("clawdrive-task-empty-output-fallback-simple-plan");
  setWorkspaceRoot(rootPath);
  await seedReadonlyFallbackWorkspace(rootPath);

  const provider: TaskProvider = {
    kind: "claude",
    async probe() {
      return { ready: true, state: "ready", detail: "ok" };
    },
    async startTask(_context, callbacks) {
      callbacks.onProgress("Claude task turn started.");
      callbacks.onEvidence({
        sawTurnStarted: true,
        sawTurnCompleted: false,
        finalizationPath: "none",
        stdoutEventTail: ["turn.started"],
      });
      throw Object.assign(new Error("Claude returned an empty result payload."), { code: "TASK_FAILED" });
    },
    async resumeTask() {
      throw new Error("not used");
    },
  };

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig({ providerKind: "claude" }),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({
    prompt: "Give me two safe next-step options for investigating this workspace. Do not modify anything.",
    mode: "plan",
  });
  const waiting = await waitForTaskState(service, queued.taskId, "waiting_decision", 5_000);

  assert.equal(waiting.executionHealth, "degraded");
  assert.equal(waiting.errorCode, null);
  assert.ok(waiting.runtimeSignals.some((signal) => signal.code === "PROVIDER_LOCAL_READONLY_FALLBACK"));
  assert.match(waiting.resultSummary ?? "", /bounded local read-only plan|受限的只读计划/i);
});

test("TaskService uses readonly fallback for empty provider output during plan tasks", async () => {
  const rootPath = await makeTempDir("clawdrive-task-empty-output-fallback");
  setWorkspaceRoot(rootPath);
  await seedReadonlyFallbackWorkspace(rootPath);

  const provider: TaskProvider = {
    kind: "claude",
    async probe() {
      return { ready: true, state: "ready", detail: "ok" };
    },
    async startTask(_context, callbacks) {
      callbacks.onProgress("Claude task turn started.");
      callbacks.onEvidence({
        sawTurnStarted: true,
        sawTurnCompleted: false,
        finalizationPath: "none",
        stdoutEventTail: ["thread.started", "turn.started"],
      });
      throw Object.assign(new Error("Claude returned an empty result payload."), { code: "TASK_FAILED" });
    },
    async resumeTask() {
      throw new Error("not used");
    },
  };

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig({ providerKind: "claude" }),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({
    prompt:
      "Analyze the current workspace and return a structured report with repository purpose, top-level module breakdown, likely entry points, task pipeline locations, and a recommended file-reading order for debugging the VS Code task pipeline. Do not modify files.",
    mode: "plan",
  });
  const waiting = await waitForTaskState(service, queued.taskId, "waiting_decision", 5_000);

  assert.equal(waiting.executionHealth, "degraded");
  assert.equal(waiting.errorCode, null);
  assert.ok(waiting.runtimeSignals.some((signal) => signal.code === "PROVIDER_LOCAL_READONLY_FALLBACK"));
  assert.match(waiting.resultSummary ?? "", /bounded local read-only plan|受限的只读计划/i);
});

test("TaskService marks readonly fallback results as degraded completed work with explicit fallback evidence", async () => {
  const rootPath = await makeTempDir("clawdrive-task-readonly-fallback-evidence");
  setWorkspaceRoot(rootPath);
  await seedReadonlyFallbackWorkspace(rootPath);

  const provider: TaskProvider = {
    kind: "claude",
    async probe() {
      return { ready: true, state: "ready", detail: "ok" };
    },
    async startTask(_context, callbacks) {
      callbacks.onProgress("Claude task turn started.");
      callbacks.onEvidence({
        sawTurnStarted: true,
        sawTurnCompleted: false,
        finalizationPath: "timeout",
        finalMessageSource: "none",
        stdoutEventTail: ["turn.started"],
      });
      throw Object.assign(new Error("Claude returned an empty result payload."), { code: "PROVIDER_OUTPUT_EMPTY" });
    },
    async resumeTask() {
      throw new Error("not used");
    },
  };

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig({ providerKind: "claude" }),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({
    prompt:
      "Analyze the current workspace and return a structured report with repository purpose, top-level module breakdown, likely entry points, task pipeline locations, and a recommended file-reading order for debugging the VS Code task pipeline. Do not modify files.",
    mode: "analyze",
  });
  const completed = await waitForTaskState(service, queued.taskId, "completed", 5_000);

  assert.equal(completed.executionHealth, "degraded");
  assert.equal(completed.errorCode, null);
  assert.ok(completed.runtimeSignals.some((signal) => signal.code === "PROVIDER_LOCAL_READONLY_FALLBACK"));
  assert.equal(completed.providerEvidence?.sawTurnStarted, true);
  assert.equal(completed.providerEvidence?.finalizationPath, "timeout");
  assert.equal(completed.providerEvidence?.finalMessageSource, "none");
  assert.match(completed.resultSummary ?? "", /bounded local workspace analysis|受限的本地工作区分析/i);
});

test("TaskService keeps completed health clean after a transient stall warning when provider finalizes successfully", async () => {
  const rootPath = await makeTempDir("clawdrive-task-runtime-stall-recovered");
  setWorkspaceRoot(rootPath);

  const provider = new FakeProvider({
    async startTask(_context, callbacks) {
      callbacks.onProgress("Claude task turn started.");
      callbacks.onRuntimeSignal(
        {
          code: "PROVIDER_RESULT_STALL_WARNING",
          severity: "degraded",
          summary: "Provider task is still running but has not produced usable output for a while.",
          detail: "No provider output after turn start for 10s.",
        },
        "No provider output after turn start for 10s."
      );
      callbacks.onEvidence({
        sawTurnStarted: true,
        sawTurnCompleted: true,
        finalMessageSource: "direct_message",
        finalizationPath: "stream_capture",
        stdoutEventTail: ["turn.started", "result.received", "turn.completed"],
      });
      return {
        summary: "Analysis completed.",
        output: "Provider-backed final answer.",
      };
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "Explain the repo.", mode: "analyze" });
  const completed = await waitForTaskState(service, queued.taskId, "completed");

  assert.equal(completed.executionHealth, "clean");
  assert.ok(completed.runtimeSignals.some((signal) => signal.code === "PROVIDER_RESULT_STALL_WARNING"));
  assert.equal(completed.providerEvidence?.sawTurnCompleted, true);
  assert.equal(completed.providerEvidence?.finalMessageSource, "direct_message");
});

test("TaskService keeps completed health degraded when fallback completes after a stall warning", async () => {
  const rootPath = await makeTempDir("clawdrive-task-runtime-stall-fallback");
  setWorkspaceRoot(rootPath);
  await seedReadonlyFallbackWorkspace(rootPath);

  const provider: TaskProvider = {
    kind: "claude",
    async probe() {
      return { ready: true, state: "ready", detail: "ok" };
    },
    async startTask(_context, callbacks) {
      callbacks.onProgress("Claude task turn started.");
      callbacks.onRuntimeSignal(
        {
          code: "PROVIDER_RESULT_STALL_WARNING",
          severity: "degraded",
          summary: "Provider task is still running but has not produced usable output for a while.",
          detail: "No provider output after turn start for 10s.",
        },
        "No provider output after turn start for 10s."
      );
      callbacks.onEvidence({
        sawTurnStarted: true,
        sawTurnCompleted: false,
        finalMessageSource: "none",
        finalizationPath: "timeout",
        stdoutEventTail: ["turn.started"],
      });
      throw Object.assign(new Error("Claude returned an empty result payload."), { code: "PROVIDER_OUTPUT_EMPTY" });
    },
    async resumeTask() {
      throw new Error("not used");
    },
  };

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig({ providerKind: "claude" }),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "Explain the repo.", mode: "analyze" });
  const completed = await waitForTaskState(service, queued.taskId, "completed", 5_000);

  assert.equal(completed.executionHealth, "degraded");
  assert.ok(completed.runtimeSignals.some((signal) => signal.code === "PROVIDER_RESULT_STALL_WARNING"));
  assert.ok(completed.runtimeSignals.some((signal) => signal.code === "PROVIDER_LOCAL_READONLY_FALLBACK"));
});

test("TaskService does not use readonly fallback for provider auth failures", async () => {
  const rootPath = await makeTempDir("clawdrive-task-auth-no-fallback");
  setWorkspaceRoot(rootPath);
  await seedReadonlyFallbackWorkspace(rootPath);

  const provider = new FakeProvider({
    async startTask(_context, callbacks) {
      callbacks.onRuntimeSignal(
        {
          code: "PROVIDER_AUTH_FAILED",
          severity: "fatal",
          summary: "Provider authentication failed while contacting the upstream model service.",
          detail: "No authentication found",
        },
        "No authentication found"
      );
      throw Object.assign(new Error("No authentication found"), { code: "PROVIDER_AUTH_FAILED" });
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "Plan the next step.", mode: "plan" });
  const failed = await waitForTaskState(service, queued.taskId, "failed", 5_000);

  assert.equal(failed.errorCode, "PROVIDER_AUTH_FAILED");
  assert.ok(!failed.runtimeSignals.some((signal) => signal.code === "PROVIDER_LOCAL_READONLY_FALLBACK"));
});

test("TaskService does not use readonly fallback for invalid Claude model failures", async () => {
  const rootPath = await makeTempDir("clawdrive-task-model-no-fallback");
  setWorkspaceRoot(rootPath);
  await seedReadonlyFallbackWorkspace(rootPath);

  const provider = new FakeProvider({
    async startTask(_context, callbacks) {
      callbacks.onRuntimeSignal(
        {
          code: "PROVIDER_MODEL_INVALID",
          severity: "fatal",
          summary: "Provider model configuration is invalid or unavailable.",
          detail: "invalid model: bad-model",
        },
        "invalid model: bad-model"
      );
      throw Object.assign(new Error("invalid model: bad-model"), { code: "PROVIDER_MODEL_INVALID" });
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "Plan the next step.", mode: "plan" });
  const failed = await waitForTaskState(service, queued.taskId, "failed", 5_000);

  assert.equal(failed.errorCode, "PROVIDER_MODEL_INVALID");
  assert.ok(!failed.runtimeSignals.some((signal) => signal.code === "PROVIDER_LOCAL_READONLY_FALLBACK"));
});



test("TaskService uses bounded readonly decision fallback for Claude apply StructuredOutput compatibility failures", async () => {
  const rootPath = await makeTempDir("clawdrive-task-apply-structuredoutput-fallback");
  setWorkspaceRoot(rootPath);
  await seedReadonlyFallbackWorkspace(rootPath);

  const provider: TaskProvider = {
    kind: "claude",
    async probe() {
      return { ready: true, state: "ready", detail: "ok" };
    },
    async startTask(_context, callbacks) {
      callbacks.onProgress("Claude task turn started.");
      callbacks.onEvidence({
        sawTurnStarted: true,
        sawTurnCompleted: true,
        finalizationPath: "stream_capture",
        finalMessageSource: "direct_message",
        lastAgentMessagePreview:
          "API Error: 400 {\"error\":{\"message\":\"litellm.BadRequestError: OpenAIException - {\\\"error\\\":{\\\"message\\\":\\\"Invalid schema for function 'StructuredOutput': schema must be a JSON Schema of 'type: \\\\\\\"object\\\\\\\"', got 'type: \\\\\\\"None\\\\\\\"'.\\\"}}\"}}",
        stdoutEventTail: ["turn.started", "result.received", "turn.completed"],
      });
      throw Object.assign(
        new Error("Claude Code returned output that could not be parsed as the expected JSON result."),
        { code: "PROVIDER_OUTPUT_INVALID" }
      );
    },
    async resumeTask() {
      throw new Error("not used");
    },
  };

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig({ providerKind: "claude" }),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({
    prompt: "First produce a minimal change proposal for approval, then wait for confirmation before applying it.",
    mode: "apply",
  });
  const waiting = await waitForTaskState(service, queued.taskId, "waiting_decision", 5_000);

  assert.equal(waiting.executionHealth, "degraded");
  assert.equal(waiting.errorCode, null);
  assert.ok(waiting.runtimeSignals.some((signal) => signal.code === "PROVIDER_LOCAL_READONLY_FALLBACK"));
  assert.ok((waiting.decision?.options.length ?? 0) >= 2);
  assert.match(waiting.resultSummary ?? "", /change-review decision|变更审核决策/i);
  assert.match(waiting.lastOutput ?? "", /Fallback Note|降级说明/i);
  assert.match(waiting.providerEvidence?.lastAgentMessagePreview ?? "", /StructuredOutput|type: \\\"None\\\"/i);
});


test("TaskService uses minimal apply readonly fallback when workspace inspection cannot build one", async () => {
  const rootPath = await makeTempDir("clawdrive-task-apply-minimal-fallback");
  setWorkspaceRoot(rootPath);

  const provider: TaskProvider = {
    kind: "claude",
    async probe() {
      return { ready: true, state: "ready", detail: "ok" };
    },
    async startTask(_context, callbacks) {
      callbacks.onProgress("Claude task turn started.");
      callbacks.onEvidence({
        sawTurnStarted: true,
        sawTurnCompleted: true,
        finalizationPath: "stream_capture",
        finalMessageSource: "direct_message",
        lastAgentMessagePreview:
          "API Error: 400 {\"error\":{\"message\":\"litellm.BadRequestError: OpenAIException - {\\\"error\\\":{\\\"message\\\":\\\"Invalid schema for function 'StructuredOutput': schema must be a JSON Schema of 'type: \\\\\\\"object\\\\\\\"', got 'type: \\\\\\\"None\\\\\\\"'.\\\"}}\"}}",
        stdoutEventTail: ["turn.started", "result.received", "turn.completed"],
      });
      throw Object.assign(
        new Error("Claude Code returned output that could not be parsed as the expected JSON result."),
        { code: "PROVIDER_OUTPUT_INVALID" }
      );
    },
    async resumeTask() {
      throw new Error("not used");
    },
  };

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig({ providerKind: "claude" }),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({
    prompt: "First produce a minimal change proposal for approval, then wait for confirmation before applying it.",
    mode: "apply",
  });
  const waiting = await waitForTaskState(service, queued.taskId, "waiting_decision", 5_000);

  assert.equal(waiting.executionHealth, "degraded");
  assert.equal(waiting.errorCode, null);
  assert.ok(waiting.runtimeSignals.some((signal) => signal.code === "PROVIDER_LOCAL_READONLY_FALLBACK"));
  assert.equal(waiting.decision?.recommendedOptionId, "option_apply_runtime_review");
  assert.match(waiting.resultSummary ?? "", /read-only change-review decision/i);
  assert.match(waiting.lastOutput ?? "", /Fallback Note/i);
});

test("TaskService does not use readonly fallback for MCP compatibility failures", async () => {
  const rootPath = await makeTempDir("clawdrive-task-mcp-no-fallback");
  setWorkspaceRoot(rootPath);
  await seedReadonlyFallbackWorkspace(rootPath);

  const provider = new FakeProvider({
    async startTask(_context, callbacks) {
      callbacks.onRuntimeSignal(
        {
          code: "PROVIDER_MCP_COMPATIBILITY_FAILED",
          severity: "fatal",
          summary: "Provider MCP compatibility failed while fetching tools or invoking methods.",
          detail: 'MCP server "claude-vscode" Failed to fetch tools: MCP error -32601: Method not found',
        },
        'MCP server "claude-vscode" Failed to fetch tools: MCP error -32601: Method not found'
      );
      throw Object.assign(new Error('MCP server "claude-vscode" Failed to fetch tools: MCP error -32601: Method not found'), {
        code: "PROVIDER_MCP_COMPATIBILITY_FAILED",
      });
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "Plan the next step.", mode: "plan" });
  const failed = await waitForTaskState(service, queued.taskId, "failed", 5_000);

  assert.equal(failed.errorCode, "PROVIDER_MCP_COMPATIBILITY_FAILED");
  assert.ok(!failed.runtimeSignals.some((signal) => signal.code === "PROVIDER_LOCAL_READONLY_FALLBACK"));
});

test("TaskService keeps waiting_decision degraded when a plan result only arrives after retry", async () => {
  const rootPath = await makeTempDir("clawdrive-task-plan-retry-degraded");
  setWorkspaceRoot(rootPath);

  const provider = new FakeProvider({
    async startTask(_context, callbacks) {
      callbacks.onRuntimeSignal(
        {
          code: "PROVIDER_PLAN_OUTPUT_RETRY",
          severity: "degraded",
          summary: "Claude plan task returned empty output; retried once with explicit raw JSON prompting.",
          detail: "Claude Code finished without returning a final message.",
        },
        "Claude Code finished without returning a final message."
      );
      return {
        summary: "Choose an investigation path.",
        output: "option_a: Trace provider finalization - Start in claude-provider.ts.\noption_b: Audit fallback semantics - Start in service.ts.",
        decision: {
          summary: "Choose an investigation path.",
          recommendedOptionId: "option_a",
          options: [
            { id: "option_a", title: "Trace provider finalization", summary: "Start in claude-provider.ts.", recommended: true },
            { id: "option_b", title: "Audit fallback semantics", summary: "Start in service.ts.", recommended: false },
          ],
        },
      };
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "Give me two next-step options.", mode: "plan" });
  const waiting = await waitForTaskState(service, queued.taskId, "waiting_decision");

  assert.equal(waiting.executionHealth, "degraded");
  assert.ok(waiting.runtimeSignals.some((signal) => signal.code === "PROVIDER_PLAN_OUTPUT_RETRY"));
});

test("TaskService keeps waiting_decision clean when a plan result is available without retry", async () => {
  const rootPath = await makeTempDir("clawdrive-task-plan-clean");
  setWorkspaceRoot(rootPath);

  const provider = new FakeProvider({
    async startTask() {
      return {
        summary: "Choose an investigation path.",
        output: "option_a: Trace provider finalization - Start in claude-provider.ts.\noption_b: Audit fallback semantics - Start in service.ts.",
        decision: {
          summary: "Choose an investigation path.",
          recommendedOptionId: "option_a",
          options: [
            { id: "option_a", title: "Trace provider finalization", summary: "Start in claude-provider.ts.", recommended: true },
            { id: "option_b", title: "Audit fallback semantics", summary: "Start in service.ts.", recommended: false },
          ],
        },
      };
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig(),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "Give me two next-step options.", mode: "plan" });
  const waiting = await waitForTaskState(service, queued.taskId, "waiting_decision");

  assert.equal(waiting.executionHealth, "clean");
  assert.ok(!waiting.runtimeSignals.some((signal) => signal.code === "PROVIDER_PLAN_OUTPUT_RETRY"));
});

test("TaskService shows degraded running health when the provider emits a stall warning before timeout", async () => {
  const rootPath = await makeTempDir("clawdrive-task-runtime-stall");
  setWorkspaceRoot(rootPath);

  const provider = new FakeProvider({
    async startTask(_context, callbacks, signal) {
      callbacks.onProgress("Codex task turn started.");
      callbacks.onRuntimeSignal(
        {
          code: "PROVIDER_RESULT_STALL_WARNING",
          severity: "degraded",
          summary: "Provider task is still running but has not produced usable output for a while.",
          detail: "No provider output after turn start for 10s.",
        },
        "No provider output after turn start for 10s."
      );
      return await new Promise<TaskRunResult>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error(String(signal.reason ?? "aborted"))), { once: true });
      });
    },
    async resumeTask() {
      throw new Error("not used");
    },
  });

  const service = new TaskService(makeExtensionContext(rootPath), {
    getConfig: () => makeConfig({ tasksDefaultTimeoutMs: 5_000 }),
    createProvider: () => provider,
  });
  await service.initialize();

  const queued = await service.startTask({ prompt: "give me two options", mode: "plan" });
  const running = await waitForTaskCondition(
    service,
    queued.taskId,
    (task) => task.state === "running" && task.executionHealth === "degraded" && task.runtimeSignals.length === 1
  );
  assert.equal(running.runtimeSignals[0].code, "PROVIDER_RESULT_STALL_WARNING");

  await service.cancelTask(queued.taskId);
  const cancelled = await waitForTaskState(service, queued.taskId, "cancelled");
  assert.equal(cancelled.executionHealth, "degraded");
});

test("TaskStorage keeps interrupted tasks resumable while pruning terminal history", async () => {
  const rootPath = await makeTempDir("clawdrive-task-storage-prune");
  setWorkspaceRoot(rootPath);

  const storage = new TaskStorage(rootPath, 1);
  await storage.initialize();
  await storage.saveSnapshot(makeSnapshot({ taskId: "completed-task", state: "completed", updatedAt: "2026-03-21T12:00:00.000Z" }));
  await storage.saveSnapshot(makeSnapshot({ taskId: "interrupted-task", state: "interrupted", updatedAt: "2026-03-21T12:01:00.000Z" }));
  await storage.saveSnapshot(makeSnapshot({ taskId: "failed-task", state: "failed", updatedAt: "2026-03-21T12:02:00.000Z" }));

  const taskIds = (await storage.listSnapshots()).map((snapshot) => snapshot.taskId);
  assert.deepEqual(taskIds, ["failed-task", "interrupted-task"]);
});

async function waitForTaskState(
  service: TaskService,
  taskId: string,
  state: TaskSnapshot["state"],
  timeoutMs = 2_000
): Promise<TaskSnapshot> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = service.getTask(taskId);
    if (task.state === state) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for task ${taskId} to reach state ${state}.`);
}

async function waitForTaskCondition(
  service: TaskService,
  taskId: string,
  predicate: (task: TaskSnapshot) => boolean,
  timeoutMs = 2_000
): Promise<TaskSnapshot> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = service.getTask(taskId);
    if (predicate(task)) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for task ${taskId} to satisfy predicate.`);
}

function makeSnapshot(overrides: Partial<TaskSnapshot>): TaskSnapshot {
  const base: TaskSnapshot = {
    taskId: "task-1",
    title: "Analyze: repo",
    mode: "analyze",
    state: "queued",
    prompt: "Explain the repo",
    paths: [],
    createdAt: "2026-03-21T12:00:00.000Z",
    updatedAt: "2026-03-21T12:00:00.000Z",
    summary: "Queued",
    lastOutput: null,
    executionHealth: "clean",
    runtimeSignals: [],
    decision: null,
    approval: null,
    error: null,
    errorCode: null,
    providerKind: "fake",
    providerSessionId: null,
    resultSummary: null,
    providerEvidence: null,
  };

  return {
    ...base,
    ...overrides,
    executionHealth: overrides.executionHealth ?? base.executionHealth,
    runtimeSignals: overrides.runtimeSignals ?? base.runtimeSignals,
  };
}

async function seedReadonlyFallbackWorkspace(rootPath: string): Promise<void> {
  await fs.mkdir(`${rootPath}\\src\\commands`, { recursive: true });
  await fs.mkdir(`${rootPath}\\src\\routing`, { recursive: true });
  await fs.mkdir(`${rootPath}\\src\\tasks`, { recursive: true });
  await fs.writeFile(
    `${rootPath}\\package.json`,
    JSON.stringify(
      {
        name: "clawdrive-vscode",
        displayName: "ClawDrive for VS Code",
        version: "0.1.39",
        main: "./out/extension.js",
        activationEvents: ["onStartupFinished"],
        contributes: {
          commands: [{ command: "clawdrive.dashboard" }, { command: "vscode.agent.route" }],
        },
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(
    `${rootPath}\\src\\extension.ts`,
    [
      'import * as vscode from "vscode";',
      'import { initializeCommandRegistry } from "./commands/registry";',
      'import { TaskService } from "./tasks/service";',
      'export async function activate() {',
      "  const service = new TaskService({} as vscode.ExtensionContext);",
      "  initializeCommandRegistry({ taskService: service, routeHandler: async () => ({ kind: 'task', route: 'analyze' }) });",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    `${rootPath}\\src\\commands\\registry.ts`,
    'export function initializeCommandRegistry() { return "vscode.agent.route"; }\n',
    "utf8"
  );
  await fs.writeFile(
    `${rootPath}\\src\\routing\\service.ts`,
    'export class AgentRouteService { async routeTask() { return "route"; } }\n',
    "utf8"
  );
  await fs.writeFile(
    `${rootPath}\\src\\tasks\\service.ts`,
    'export class TaskService { async startTask() { return "task"; } }\n',
    "utf8"
  );
  await fs.writeFile(
    `${rootPath}\\src\\tasks\\provider.ts`,
    'export interface TaskProvider { startTask(): Promise<void>; resumeTask(): Promise<void>; }\n',
    "utf8"
  );
  await fs.writeFile(
    `${rootPath}\\src\\tasks\\codex-provider.ts`,
    'export class CodexCliProvider { async startTask() { return "provider"; } async resumeTask() { return "provider"; } }\n',
    "utf8"
  );
}
