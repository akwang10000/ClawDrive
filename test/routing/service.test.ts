import test from "node:test";
import assert from "node:assert/strict";
import { AgentRouteService } from "../../src/routing/service";
import type { ProviderStatusInfo, TaskContinuationCandidate, TaskSnapshot } from "../../src/tasks/types";
import { setLanguage } from "../test-utils";

const providerStatus: ProviderStatusInfo = {
  ready: true,
  state: "ready",
  label: "Ready (Codex CLI)",
  message: "Provider status: ready.",
  detail: "Codex CLI is enabled and runnable.",
};

test("AgentRouteService returns clarify when multiple waiting tasks are plausible", async () => {
  setLanguage("en");
  const taskA = makeTask("task-a", "waiting_decision");
  const taskB = makeTask("task-b", "waiting_decision");
  const service = new AgentRouteService({
    taskService: {
      listContinuationCandidates: () => [toCandidate(taskB), toCandidate(taskA)],
      getTask: (taskId: string) => (taskId === taskA.taskId ? taskA : taskB),
    } as never,
    getConnectionState: () => "connected",
    getProviderStatus: () => providerStatus,
  });

  const response = await service.route({ prompt: "continue" });
  assert.equal(response.kind, "clarify");
  assert.equal(response.route, "continue");
  assert.equal(response.data.length, 2);
});

test("AgentRouteService returns current running task instead of spawning a duplicate", async () => {
  setLanguage("en");
  const running = makeTask("task-running", "running");
  const service = new AgentRouteService({
    taskService: {
      listContinuationCandidates: () => [toCandidate(running)],
      getTask: () => running,
    } as never,
    getConnectionState: () => "connected",
    getProviderStatus: () => providerStatus,
  });

  const response = await service.route({ prompt: "continue" });
  assert.equal(response.kind, "task");
  assert.equal(response.route, "continue");
  assert.equal(response.data.taskId, running.taskId);
  assert.match(response.message, /already running/i);
});

test("AgentRouteService approval prompts target waiting_approval tasks", async () => {
  setLanguage("en");
  const waitingApproval = makeTask("task-approval", "waiting_approval");
  const service = new AgentRouteService({
    taskService: {
      listContinuationCandidates: () => [toCandidate(waitingApproval)],
      respondToTask: async (params: { taskId: string; approval?: "approved" | "rejected" }) => {
        assert.equal(params.taskId, waitingApproval.taskId);
        assert.equal(params.approval, "approved");
        return {
          ...waitingApproval,
          state: "queued",
          summary: "Apply task queued.",
        };
      },
      getTask: () => waitingApproval,
    } as never,
    getConnectionState: () => "connected",
    getProviderStatus: () => providerStatus,
  });

  const response = await service.route({ prompt: "批准执行" });
  assert.equal(response.kind, "task");
  assert.equal(response.route, "continue");
  assert.equal(response.data.state, "queued");
});

function makeTask(taskId: string, state: TaskSnapshot["state"]): TaskSnapshot {
  return {
    taskId,
    title: `Task ${taskId}`,
    mode: "plan",
    state,
    prompt: "Give me options",
    paths: [],
    createdAt: "2026-03-21T12:00:00.000Z",
    updatedAt: "2026-03-21T12:01:00.000Z",
    summary: `Task ${taskId} summary`,
    lastOutput: null,
    decision:
      state === "waiting_decision"
        ? {
            summary: "Choose one option.",
            recommendedOptionId: "option_a",
            options: [
              { id: "option_a", title: "A", summary: "Recommended", recommended: true },
              { id: "option_b", title: "B", summary: "Alternative", recommended: false },
            ],
          }
        : null,
    approval:
      state === "waiting_approval"
        ? {
            summary: "Apply these changes.",
            operations: [{ type: "write_file", path: "README.md", content: "updated" }],
          }
        : null,
    error: null,
    errorCode: null,
    providerKind: "codex",
    providerSessionId: "session-1",
    resultSummary: null,
  };
}

function toCandidate(task: TaskSnapshot): TaskContinuationCandidate {
  return {
    taskId: task.taskId,
    title: task.title,
    state: task.state as TaskContinuationCandidate["state"],
    updatedAt: task.updatedAt,
    summary: task.summary,
  };
}
