import test from "node:test";
import assert from "node:assert/strict";
import { dispatchCommand, initializeCommandRegistry } from "../../src/commands/registry";
import type { AgentRouteResponse } from "../../src/routing/types";
import type { TaskService } from "../../src/tasks/service";
import type { TaskMode } from "../../src/tasks/types";

function makeRouteHandler(): (_params: unknown) => Promise<AgentRouteResponse> {
  return async () => ({
    kind: "blocked",
    route: "blocked",
    message: "blocked",
    data: { suggestedMode: "plan" },
  });
}

function makeTaskServiceStub() {
  const calls: Array<{ prompt: string; mode: TaskMode; paths?: string[] }> = [];
  const taskService = {
    async startTask(params: { prompt: string; mode: TaskMode; paths?: string[] }) {
      calls.push(params);
      return {
        taskId: `task-${calls.length}`,
        prompt: params.prompt,
        mode: params.mode,
        paths: params.paths ?? [],
      };
    },
  } as unknown as TaskService;

  return { taskService, calls };
}

test("vscode.agent.task.start accepts ask-style aliases for analyze", async () => {
  const { taskService, calls } = makeTaskServiceStub();
  initializeCommandRegistry({ taskService, routeHandler: makeRouteHandler() });

  for (const mode of ["ask", "chat", "analysis", "analyse", "ANALYZE"]) {
    const result = await dispatchCommand("vscode.agent.task.start", {
      prompt: "Explain the repository",
      mode,
      paths: ["README.md"],
    });
    assert.equal(result.ok, true);
  }

  assert.deepEqual(
    calls.map((call) => call.mode),
    ["analyze", "analyze", "analyze", "analyze", "analyze"]
  );
  assert.deepEqual(calls[0].paths, ["README.md"]);
});

test("vscode.agent.task.start accepts edit as an apply alias", async () => {
  const { taskService, calls } = makeTaskServiceStub();
  initializeCommandRegistry({ taskService, routeHandler: makeRouteHandler() });

  const result = await dispatchCommand("vscode.agent.task.start", {
    prompt: "Update the README",
    mode: "EDIT",
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0]?.mode, "apply");
});

test("vscode.agent.task.start explains canonical modes and compatibility aliases on invalid mode", async () => {
  const { taskService } = makeTaskServiceStub();
  initializeCommandRegistry({ taskService, routeHandler: makeRouteHandler() });

  const result = await dispatchCommand("vscode.agent.task.start", {
    prompt: "Explain the repository",
    mode: "ask_plan",
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.error.code, "COMMAND_ERROR");
  assert.match(result.error.message, /mode must be analyze, plan, or apply/i);
  assert.match(result.error.message, /ask\/chat\/analysis\/analyse -> analyze/i);
  assert.match(result.error.message, /edit -> apply/i);
});
