import test from "node:test";
import assert from "node:assert/strict";
import { buildDashboardTaskSnapshot } from "../src/dashboard-tasks";
import type { TaskSnapshot } from "../src/tasks/types";
import { setLanguage } from "./test-utils";

test("buildDashboardTaskSnapshot pins active tasks above terminal tasks and derives action flags", () => {
  setLanguage("en");

  const snapshot = buildDashboardTaskSnapshot([
    makeSnapshot({ taskId: "completed-task", state: "completed", updatedAt: "2026-03-21T12:01:00.000Z" }),
    makeSnapshot({ taskId: "running-task", state: "running", updatedAt: "2026-03-21T12:00:00.000Z" }),
    makeSnapshot({ taskId: "failed-task", state: "failed", updatedAt: "2026-03-21T12:02:00.000Z" }),
    makeSnapshot({ taskId: "interrupted-task", state: "interrupted", updatedAt: "2026-03-21T12:03:00.000Z" }),
  ]);

  assert.deepEqual(
    snapshot.tasks.map((task) => task.taskId),
    ["interrupted-task", "running-task", "failed-task", "completed-task"]
  );

  const interrupted = snapshot.tasks.find((task) => task.taskId === "interrupted-task");
  const failed = snapshot.tasks.find((task) => task.taskId === "failed-task");
  assert.equal(interrupted?.canCancel, true);
  assert.equal(interrupted?.canDelete, false);
  assert.equal(failed?.canCancel, false);
  assert.equal(failed?.canDelete, true);
  assert.equal(snapshot.taskCounts.total, 4);
  assert.equal(snapshot.taskCounts.active, 2);
  assert.equal(snapshot.taskCounts.terminal, 2);
  assert.equal(snapshot.bulkActions.cancellable, 2);
  assert.equal(snapshot.bulkActions.deletable, 2);
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
