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
