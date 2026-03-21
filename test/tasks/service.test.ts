import test from "node:test";
import assert from "node:assert/strict";
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

function makeSnapshot(overrides: Partial<TaskSnapshot>): TaskSnapshot {
  return {
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
    decision: null,
    error: null,
    errorCode: null,
    providerKind: "fake",
    providerSessionId: null,
    resultSummary: null,
    ...overrides,
  };
}
