import test from "node:test";
import assert from "node:assert/strict";
import { TaskStorage } from "../../src/tasks/storage";
import type { TaskSnapshot } from "../../src/tasks/types";
import { makeTempDir } from "../test-utils";

test("TaskStorage deleteTask removes the task directory and index entry", async () => {
  const rootPath = await makeTempDir("clawdrive-task-storage-delete");
  const storage = new TaskStorage(rootPath, 20);
  await storage.initialize();

  await storage.saveSnapshot(makeSnapshot({ taskId: "completed-task", state: "completed" }));
  await storage.saveSnapshot(makeSnapshot({ taskId: "failed-task", state: "failed" }));

  await storage.deleteTask("completed-task");

  assert.equal(await storage.readSnapshot("completed-task"), null);
  assert.deepEqual(
    (await storage.listSnapshots()).map((snapshot) => snapshot.taskId),
    ["failed-task"]
  );
});

test("TaskStorage deleteTask is safe to repeat for missing tasks", async () => {
  const rootPath = await makeTempDir("clawdrive-task-storage-repeat-delete");
  const storage = new TaskStorage(rootPath, 20);
  await storage.initialize();

  await storage.saveSnapshot(makeSnapshot({ taskId: "cancelled-task", state: "cancelled" }));

  await storage.deleteTask("cancelled-task");
  await storage.deleteTask("cancelled-task");
  await storage.deleteTask("does-not-exist");

  assert.deepEqual(await storage.listSnapshots(), []);
});

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
