import test from "node:test";
import assert from "node:assert/strict";
import { AgentRouteService } from "../../src/routing/service";
import type { WorkspaceInspector } from "../../src/routing/workspace-inspector";
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

test("AgentRouteService diagnose prefers degraded completion over generic active state", async () => {
  setLanguage("en");
  const degradedCompleted = {
    ...makeTask("task-completed", "completed"),
    executionHealth: "degraded" as const,
    runtimeSignals: [
      {
        code: "PROVIDER_TRANSPORT_FALLBACK",
        severity: "degraded" as const,
        summary: "Provider transport fell back to a slower or narrower runtime path.",
        count: 1,
        lastSeenAt: "2026-03-21T12:00:30.000Z",
      },
    ],
  };
  const waiting = makeTask("task-waiting", "waiting_decision");
  const service = new AgentRouteService({
    taskService: {
      listTasks: () => [waiting, degradedCompleted],
    } as never,
    getConnectionState: () => "connected",
    getProviderStatus: () => providerStatus,
  });

  const response = await service.route({ prompt: "what status is the provider in" });
  assert.equal(response.kind, "direct_result");
  assert.equal(response.route, "diagnose");
  assert.match(response.message, /completed task/i);
  assert.match(response.message, /degraded/i);
});

test("AgentRouteService infers an explicit file path from the prompt for direct reads", async () => {
  setLanguage("en");
  const service = new AgentRouteService({
    taskService: {} as never,
    getConnectionState: () => "connected",
    getProviderStatus: () => providerStatus,
    inspector: createInspector({
      fileRead: async ({ path }) => ({
        path,
        workspaceFolder: "h:\\workspace\\clawdrive-vscode",
        content: "# ClawDrive",
        languageId: "markdown",
        size: 11,
        modifiedTimeMs: 1,
      }),
    }),
  });

  const response = await service.route({ prompt: "read README.md" });
  assert.equal(response.kind, "direct_result");
  assert.equal(response.route, "inspect");
  assert.equal((response.data as { path: string }).path, "README.md");
});

test("AgentRouteService uses bounded local search for code-location prompts", async () => {
  setLanguage("en");
  const service = new AgentRouteService({
    taskService: {
      startTask: async () => {
        throw new Error("should not start provider task");
      },
    } as never,
    getConnectionState: () => "connected",
    getProviderStatus: () => providerStatus,
    inspector: createInspector({
      directoryList: async ({ path } = {}) => {
        if (!path || path === "h:\\workspace\\clawdrive-vscode") {
          return {
            path: "h:\\workspace\\clawdrive-vscode",
            workspaceFolder: "h:\\workspace\\clawdrive-vscode",
            entries: [
              { name: "src", path: "src", type: "directory" as const },
              { name: "package.json", path: "package.json", type: "file" as const },
            ],
          };
        }
        if (path === "src") {
          return {
            path: "src",
            workspaceFolder: "h:\\workspace\\clawdrive-vscode",
            entries: [
              { name: "commands", path: "src/commands", type: "directory" as const },
              { name: "routing", path: "src/routing", type: "directory" as const },
            ],
          };
        }
        if (path === "src/commands") {
          return {
            path: "src/commands",
            workspaceFolder: "h:\\workspace\\clawdrive-vscode",
            entries: [{ name: "registry.ts", path: "src/commands/registry.ts", type: "file" as const }],
          };
        }
        if (path === "src/routing") {
          return {
            path: "src/routing",
            workspaceFolder: "h:\\workspace\\clawdrive-vscode",
            entries: [{ name: "service.ts", path: "src/routing/service.ts", type: "file" as const }],
          };
        }
        throw new Error(`unexpected path ${path}`);
      },
      fileRead: async ({ path }) => {
        if (path === "src/commands/registry.ts") {
          return {
            ...makeFileRead(
              path,
              [
                "const definitions = [",
                "  {",
                "    command: \"vscode.agent.route\",",
                "  },",
                "];",
              ].join("\n")
            ),
            languageId: "typescript",
          };
        }
        if (path === "src/routing/service.ts") {
          return {
            ...makeFileRead(path, "export class AgentRouteService {}"),
            languageId: "typescript",
          };
        }
        if (path === "package.json") {
          return {
            ...makeFileRead(path, "{\"name\":\"clawdrive-vscode\"}"),
            languageId: "json",
          };
        }
        throw new Error(`unexpected path ${path}`);
      },
    }),
  });

  const response = await service.route({ prompt: "Where is `vscode.agent.route` wired up?" });
  assert.equal(response.kind, "direct_result");
  assert.equal(response.route, "inspect");
  assert.match(response.message, /likely local match/i);
  assert.match(response.message, /src\/commands\/registry\.ts:3/i);
});

test("AgentRouteService audits extension wiring from workspace files instead of starting a provider task", async () => {
  setLanguage("en");
  const service = new AgentRouteService({
    taskService: {
      startTask: async () => {
        throw new Error("should not start provider task");
      },
    } as never,
    getConnectionState: () => "connected",
    getProviderStatus: () => providerStatus,
    inspector: createInspector({
      fileRead: async ({ path }) => {
        if (path === "package.json") {
          return makeFileRead(path, JSON.stringify({
            main: "./out/extension.js",
            activationEvents: ["onStartupFinished"],
            contributes: {
              commands: [
                { command: "clawdrive.dashboard" },
                { command: "clawdrive.showStatus" },
              ],
            },
          }));
        }
        if (path === "src/extension.ts") {
          return makeFileRead(
            path,
            [
              "export async function activate(): Promise<void> {",
              "  vscode.commands.registerCommand(\"clawdrive.dashboard\", () => undefined);",
              "  vscode.commands.registerCommand(\"clawdrive.showStatus\", () => undefined);",
              "}",
              "export function deactivate(): void {}",
            ].join("\n")
          );
        }
        if (path === "out/extension.js") {
          return makeFileRead(path, "exports.activate = activate; exports.deactivate = deactivate;");
        }
        throw new Error(`unexpected path ${path}`);
      },
    }),
  });

  const response = await service.route({
    prompt: "读取 package.json，告诉我 main、activationEvents、contributes.commands 的真实值。",
  });

  assert.equal(response.kind, "direct_result");
  assert.equal(response.route, "inspect");
  assert.match(response.message, /package\.json main = \.\/out\/extension\.js/i);

  const audit = response.data as {
    packageJson: { main: string | null; activationEvents: string[]; commandIds: string[] };
    sourceEntry: { registeredCommands: string[] } | null;
    buildEntry: { exists: boolean } | null;
  };
  assert.equal(audit.packageJson.main, "./out/extension.js");
  assert.deepEqual(audit.packageJson.commandIds, ["clawdrive.dashboard", "clawdrive.showStatus"]);
  assert.deepEqual(audit.sourceEntry?.registeredCommands, ["clawdrive.dashboard", "clawdrive.showStatus"]);
  assert.equal(audit.buildEntry?.exists, true);
});

test("AgentRouteService returns grounded local summary for README summarize prompts", async () => {
  setLanguage("en");
  const service = new AgentRouteService({
    taskService: {
      startTask: async () => {
        throw new Error("should not start provider task");
      },
    } as never,
    getConnectionState: () => "connected",
    getProviderStatus: () => providerStatus,
    inspector: createInspector({
      fileRead: async ({ path }) => {
        assert.equal(path, "README.md");
        return {
          ...makeFileRead(path, ["# ClawDrive", "", "## Install", "", "## Limitations"].join("\n")),
          languageId: "markdown",
        };
      },
    }),
  });

  const response = await service.route({ prompt: "Read README.md and summarize installation." });
  assert.equal(response.kind, "direct_result");
  assert.equal(response.route, "inspect");
  assert.match(response.message, /README\.md: markdown headings = ClawDrive, Install, Limitations/i);
});

test("AgentRouteService summarizes multiple explicit files locally", async () => {
  setLanguage("en");
  const service = new AgentRouteService({
    taskService: {
      startTask: async () => {
        throw new Error("should not start provider task");
      },
    } as never,
    getConnectionState: () => "connected",
    getProviderStatus: () => providerStatus,
    inspector: createInspector({
      fileRead: async ({ path }) => {
        if (path === "package.json") {
          return {
            ...makeFileRead(path, JSON.stringify({ name: "clawdrive-vscode", version: "0.1.13", main: "./out/extension.js" })),
            languageId: "json",
          };
        }
        if (path === "src/extension.ts") {
          return {
            ...makeFileRead(
              path,
              [
                "export async function activate(): Promise<void> {}",
                "export function deactivate(): void {}",
                "vscode.commands.registerCommand(\"clawdrive.dashboard\", () => undefined);",
              ].join("\n")
            ),
            languageId: "typescript",
          };
        }
        throw new Error(`unexpected path ${path}`);
      },
    }),
  });

  const response = await service.route({ prompt: "Compare package.json and src/extension.ts and summarize the entry flow." });
  assert.equal(response.kind, "direct_result");
  assert.equal(response.route, "inspect");
  assert.match(response.message, /package\.json: package name = clawdrive-vscode/i);
  assert.match(response.message, /src\/extension\.ts: exports activate, deactivate; registerCommand = 1/i);
});

test("AgentRouteService summarizes a directory locally with sampled files", async () => {
  setLanguage("en");
  const service = new AgentRouteService({
    taskService: {
      startTask: async () => {
        throw new Error("should not start provider task");
      },
    } as never,
    getConnectionState: () => "connected",
    getProviderStatus: () => providerStatus,
    inspector: createInspector({
      directoryList: async ({ path } = {}) => {
        assert.equal(path, "src");
        return {
          path: "src",
          workspaceFolder: "h:\\workspace\\clawdrive-vscode",
          entries: [
            { name: "commands", path: "src\\commands", type: "directory" as const },
            { name: "routing", path: "src\\routing", type: "directory" as const },
            { name: "tasks", path: "src\\tasks", type: "directory" as const },
            { name: "extension.ts", path: "src\\extension.ts", type: "file" as const },
            { name: "gateway-client.ts", path: "src\\gateway-client.ts", type: "file" as const },
          ],
        };
      },
      fileRead: async ({ path }) => {
        if (path === "src\\extension.ts" || path === "src/extension.ts") {
          return {
            ...makeFileRead(
              "src/extension.ts",
              [
                "export async function activate(): Promise<void> {}",
                "export function deactivate(): void {}",
                "vscode.commands.registerCommand(\"clawdrive.dashboard\", () => undefined);",
              ].join("\n")
            ),
            languageId: "typescript",
          };
        }
        if (path === "src\\gateway-client.ts" || path === "src/gateway-client.ts") {
          return {
            ...makeFileRead("src/gateway-client.ts", "export class GatewayClient {}"),
            languageId: "typescript",
          };
        }
        throw new Error(`unexpected path ${path}`);
      },
    }),
  });

  const response = await service.route({ prompt: "Summarize the src directory." });
  assert.equal(response.kind, "direct_result");
  assert.equal(response.route, "inspect");
  assert.match(response.message, /src: 3 directories and 2 files at the top level/i);
  assert.match(response.message, /Top directories: commands, routing, tasks/i);
  assert.match(response.message, /src\/extension\.ts: exports activate, deactivate; registerCommand = 1/i);
});

test("AgentRouteService summarizes repository structure with one-level follow-through", async () => {
  setLanguage("en");
  const service = new AgentRouteService({
    taskService: {
      startTask: async () => {
        throw new Error("should not start provider task");
      },
    } as never,
    getConnectionState: () => "connected",
    getProviderStatus: () => providerStatus,
    inspector: createInspector({
      workspaceInfo: async () => ({
        name: "clawdrive-vscode",
        rootPath: "h:\\workspace\\clawdrive-vscode",
        folders: ["h:\\workspace\\clawdrive-vscode"],
      }),
      directoryList: async ({ path } = {}) => {
        if (!path || path === "h:\\workspace\\clawdrive-vscode") {
          return {
            path: "h:\\workspace\\clawdrive-vscode",
            workspaceFolder: "h:\\workspace\\clawdrive-vscode",
            entries: [
              { name: "src", path: "src", type: "directory" as const },
              { name: "docs", path: "docs", type: "directory" as const },
              { name: "package.json", path: "package.json", type: "file" as const },
            ],
          };
        }
        if (path === "src" || path === "h:\\workspace\\clawdrive-vscode\\src") {
          return {
            path: typeof path === "string" ? path : "src",
            workspaceFolder: "h:\\workspace\\clawdrive-vscode",
            entries: [
              { name: "commands", path: "src/commands", type: "directory" as const },
              { name: "routing", path: "src/routing", type: "directory" as const },
              { name: "extension.ts", path: "src/extension.ts", type: "file" as const },
            ],
          };
        }
        if (path === "docs" || path === "h:\\workspace\\clawdrive-vscode\\docs") {
          return {
            path: typeof path === "string" ? path : "docs",
            workspaceFolder: "h:\\workspace\\clawdrive-vscode",
            entries: [
              { name: "01-product-scope.md", path: "docs/01-product-scope.md", type: "file" as const },
              { name: "10-natural-language-calling.md", path: "docs/10-natural-language-calling.md", type: "file" as const },
            ],
          };
        }
        throw new Error(`unexpected path ${path}`);
      },
      fileRead: async ({ path }) => {
        if (path === "package.json") {
          return {
            ...makeFileRead(path, "{\"name\":\"clawdrive-vscode\"}"),
            languageId: "json",
          };
        }
        if (path === "src/extension.ts") {
          return {
            ...makeFileRead(path, "export async function activate(): Promise<void> {}"),
            languageId: "typescript",
          };
        }
        if (path === "docs/01-product-scope.md") {
          return {
            ...makeFileRead(path, "# Product Scope"),
            languageId: "markdown",
          };
        }
        if (path === "docs/10-natural-language-calling.md") {
          return {
            ...makeFileRead(path, "# Natural-Language Calling Guide"),
            languageId: "markdown",
          };
        }
        throw new Error(`unexpected path ${path}`);
      },
    }),
  });

  const response = await service.route({ prompt: "Summarize this repository structure." });
  assert.equal(response.kind, "direct_result");
  assert.equal(response.route, "inspect");
  assert.match(response.message, /clawdrive-vscode: 2 directories and 1 files at the top level/i);
  assert.match(response.message, /Shallow follow-through for src:/i);
  assert.match(response.message, /Shallow follow-through for docs:/i);
});

test("AgentRouteService explains the local route-task-provider flow without starting a provider task", async () => {
  setLanguage("en");
  const service = new AgentRouteService({
    taskService: {
      startTask: async () => {
        throw new Error("should not start provider task");
      },
    } as never,
    getConnectionState: () => "connected",
    getProviderStatus: () => providerStatus,
    inspector: createInspector({
      fileRead: async ({ path }) => {
        if (path === "src/extension.ts") {
          return {
            ...makeFileRead(
              path,
              [
                "const taskService = new TaskService(context);",
                "const routeService = new AgentRouteService({ taskService });",
                "initializeCommandRegistry({ taskService, routeHandler: (params) => routeService.route(params) });",
                "new GatewayClient({ onInvoke: dispatchCommand });",
              ].join("\n")
            ),
            languageId: "typescript",
          };
        }
        if (path === "src/commands/registry.ts") {
          return {
            ...makeFileRead(
              path,
              [
                "{ command: \"vscode.agent.route\" },",
                "{ command: \"vscode.agent.task.start\" },",
                "{ command: \"vscode.agent.task.status\" },",
                "{ command: \"vscode.agent.task.list\" },",
                "{ command: \"vscode.agent.task.respond\" },",
                "{ command: \"vscode.agent.task.cancel\" },",
                "{ command: \"vscode.agent.task.result\" },",
              ].join("\n")
            ),
            languageId: "typescript",
          };
        }
        if (path === "src/routing/service.ts") {
          return {
            ...makeFileRead(
              path,
              [
                "return { route: \"inspect\" };",
                "return { route: \"analyze\" };",
                "return { route: \"plan\" };",
                "return { route: \"apply\" };",
                "return { route: \"continue\" };",
                "return { route: \"diagnose\" };",
                "routeTask(prompt, paths, \"analyze\");",
              ].join("\n")
            ),
            languageId: "typescript",
          };
        }
        if (path === "src/tasks/service.ts") {
          return {
            ...makeFileRead(
              path,
              [
                "new StructuredApplyExecutor();",
                "this.provider.startTask(context, callbacks, signal);",
                "this.provider.resumeTask(context, response, callbacks, signal);",
                "pumpQueue();",
              ].join("\n")
            ),
            languageId: "typescript",
          };
        }
        if (path === "src/tasks/provider.ts") {
          return {
            ...makeFileRead(
              path,
              [
                "probe(): Promise<ProviderProbeResult>;",
                "startTask(context: ProviderRunContext, callbacks: ProviderRunCallbacks, signal: AbortSignal): Promise<TaskRunResult>;",
                "resumeTask(context: ProviderRunContext, response: TaskResponseInput, callbacks: ProviderRunCallbacks, signal: AbortSignal): Promise<TaskRunResult>;",
              ].join("\n")
            ),
            languageId: "typescript",
          };
        }
        if (path === "src/tasks/codex-provider.ts") {
          return {
            ...makeFileRead(
              path,
              [
                "export class CodexCliProvider implements TaskProvider {",
                "readonly kind = \"codex\";",
                "async startTask(context, callbacks, signal) {}",
                "async resumeTask(context, response, callbacks, signal) {}",
                "async probe() {}",
                "}",
              ].join("\n")
            ),
            languageId: "typescript",
          };
        }
        throw new Error(`unexpected path ${path}`);
      },
    }),
  });

  const response = await service.route({ prompt: "Explain how route, task service, and provider fit together." });
  assert.equal(response.kind, "direct_result");
  assert.equal(response.route, "inspect");
  assert.match(response.message, /Main flow: OpenClaw -> vscode\.agent\.route -> AgentRouteService -> TaskService -> CodexCliProvider/i);
  assert.match(response.message, /src\/extension\.ts: activation wires TaskService, AgentRouteService, command registry init, gateway dispatch/i);
  assert.match(response.message, /src\/commands\/registry\.ts: route command = yes; task commands = 6/i);
  assert.match(response.message, /src\/tasks\/service\.ts: task orchestration includes provider\.startTask, provider\.resumeTask, StructuredApplyExecutor, single queue pump/i);
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
    executionHealth: "clean",
    runtimeSignals: [],
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
    providerEvidence: null,
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

function createInspector(overrides?: Partial<WorkspaceInspector>): WorkspaceInspector {
  return {
    workspaceInfo: async () => ({
      name: "clawdrive-vscode",
      rootPath: "h:\\workspace\\clawdrive-vscode",
      folders: ["h:\\workspace\\clawdrive-vscode"],
    }),
    activeEditor: async () => ({ path: "src/extension.ts" }),
    diagnosticsGet: async () => ({ items: [] }),
    fileRead: async ({ path }) => makeFileRead(path, ""),
    directoryList: async ({ path } = {}) => ({
      path: path ?? "h:\\workspace\\clawdrive-vscode",
      workspaceFolder: "h:\\workspace\\clawdrive-vscode",
      entries: [],
    }),
    ...overrides,
  };
}

function makeFileRead(path: string, content: string) {
  return {
    path,
    workspaceFolder: "h:\\workspace\\clawdrive-vscode",
    content,
    languageId: "plaintext",
    size: content.length,
    modifiedTimeMs: 1,
  };
}
