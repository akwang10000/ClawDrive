import { activeEditor } from "./editor";
import { diagnosticsGet } from "./diagnostics";
import { directoryList } from "./directory";
import { fileRead } from "./file";
import { assertCommandAllowed } from "../guards/policy";
import { isCommandFailure, mapUnknownCommandError } from "../guards/errors";
import { runWithCommandTimeout } from "../guards/timeout";
import type { AgentRouteRequest, AgentRouteResponse } from "../routing/types";
import type { TaskService } from "../tasks/service";
import { workspaceInfo } from "./workspace";

type CommandHandler = (params: unknown) => Promise<unknown>;

type PathAccess = "none" | "optional" | "required";

interface CommandDefinition {
  command: string;
  handler: CommandHandler;
  pathAccess: PathAccess;
  mutating: boolean;
  defaultTimeoutMs: number;
}

let taskService: TaskService | null = null;
let routeHandler: ((params: AgentRouteRequest) => Promise<AgentRouteResponse>) | null = null;

const definitions: CommandDefinition[] = [
  {
    command: "vscode.workspace.info",
    handler: async () => workspaceInfo(),
    pathAccess: "none",
    mutating: false,
    defaultTimeoutMs: 10_000,
  },
  {
    command: "vscode.file.read",
    handler: fileRead,
    pathAccess: "required",
    mutating: false,
    defaultTimeoutMs: 15_000,
  },
  {
    command: "vscode.dir.list",
    handler: directoryList,
    pathAccess: "optional",
    mutating: false,
    defaultTimeoutMs: 15_000,
  },
  {
    command: "vscode.editor.active",
    handler: async () => activeEditor(),
    pathAccess: "none",
    mutating: false,
    defaultTimeoutMs: 10_000,
  },
  {
    command: "vscode.diagnostics.get",
    handler: diagnosticsGet,
    pathAccess: "optional",
    mutating: false,
    defaultTimeoutMs: 15_000,
  },
  {
    command: "vscode.agent.route",
    handler: async (params) => requireRouteHandler()(parseRouteParams(params)),
    pathAccess: "optional",
    mutating: false,
    defaultTimeoutMs: 15_000,
  },
  {
    command: "vscode.agent.task.start",
    handler: async (params) => requireTaskService().startTask(parseTaskStartParams(params)),
    pathAccess: "optional",
    mutating: false,
    defaultTimeoutMs: 15_000,
  },
  {
    command: "vscode.agent.task.status",
    handler: async (params) => requireTaskService().getTask(parseTaskLookupParams(params).taskId),
    pathAccess: "none",
    mutating: false,
    defaultTimeoutMs: 10_000,
  },
  {
    command: "vscode.agent.task.list",
    handler: async (params) => requireTaskService().listTasks(parseTaskListParams(params)),
    pathAccess: "none",
    mutating: false,
    defaultTimeoutMs: 10_000,
  },
  {
    command: "vscode.agent.task.respond",
    handler: async (params) => requireTaskService().respondToTask(parseTaskRespondParams(params)),
    pathAccess: "none",
    mutating: false,
    defaultTimeoutMs: 15_000,
  },
  {
    command: "vscode.agent.task.cancel",
    handler: async (params) => requireTaskService().cancelTask(parseTaskLookupParams(params).taskId),
    pathAccess: "none",
    mutating: false,
    defaultTimeoutMs: 10_000,
  },
  {
    command: "vscode.agent.task.result",
    handler: async (params) => requireTaskService().getTaskResult(parseTaskLookupParams(params).taskId),
    pathAccess: "none",
    mutating: false,
    defaultTimeoutMs: 10_000,
  },
];

const handlers = new Map<string, CommandDefinition>(definitions.map((definition) => [definition.command, definition]));

export function initializeCommandRegistry(services: {
  taskService: TaskService;
  routeHandler: (params: AgentRouteRequest) => Promise<AgentRouteResponse>;
}): void {
  taskService = services.taskService;
  routeHandler = services.routeHandler;
}

export function getRegisteredCommands(): string[] {
  return definitions.map((definition) => definition.command);
}

function clampTimeout(requestedTimeoutMs: number | undefined, defaultTimeoutMs: number): number {
  return Math.max(1_000, Math.min(requestedTimeoutMs ?? defaultTimeoutMs, 30_000));
}

export async function dispatchCommand(
  command: string,
  params: unknown,
  requestedTimeoutMs?: number
): Promise<
  | { ok: true; payload?: unknown }
  | { ok: false; error: { code: string; message: string } }
> {
  const definition = handlers.get(command);
  if (!definition) {
    return {
      ok: false,
      error: {
        code: "UNKNOWN_COMMAND",
        message: `Unknown command: ${command}`,
      },
    };
  }

  try {
    assertCommandAllowed(definition);
    const timeoutMs = clampTimeout(requestedTimeoutMs, definition.defaultTimeoutMs);
    const payload = await runWithCommandTimeout(timeoutMs, () => definition.handler(params));
    return { ok: true, payload };
  } catch (error) {
    const failure = isCommandFailure(error) ? error : mapUnknownCommandError(error);
    return {
      ok: false,
      error: {
        code: failure.code,
        message: failure.message,
      },
    };
  }
}

function requireTaskService(): TaskService {
  if (!taskService) {
    throw mapUnknownCommandError(new Error("Task service is not initialized."));
  }
  return taskService;
}

function requireRouteHandler(): (params: AgentRouteRequest) => Promise<AgentRouteResponse> {
  if (!routeHandler) {
    throw mapUnknownCommandError(new Error("Route handler is not initialized."));
  }
  return routeHandler;
}

function parseTaskStartParams(params: unknown): { prompt: string; mode: "analyze" | "plan" | "apply"; paths?: string[] } {
  if (!params || typeof params !== "object") {
    throw mapUnknownCommandError(new Error("Expected an object with prompt and mode."));
  }
  const value = params as Record<string, unknown>;
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  const mode = value.mode;
  const rawPaths = Array.isArray(value.paths) ? value.paths.filter((item): item is string => typeof item === "string") : undefined;
  if (!prompt) {
    throw mapUnknownCommandError(new Error("prompt must be a non-empty string."));
  }
  if (mode !== "analyze" && mode !== "plan" && mode !== "apply") {
    throw mapUnknownCommandError(new Error("mode must be analyze, plan, or apply."));
  }
  return { prompt, mode, paths: rawPaths };
}

function parseRouteParams(params: unknown): AgentRouteRequest {
  if (!params || typeof params !== "object") {
    throw mapUnknownCommandError(new Error("Expected an object with prompt and optional paths."));
  }
  const value = params as Record<string, unknown>;
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  const paths = Array.isArray(value.paths) ? value.paths.filter((item): item is string => typeof item === "string") : undefined;
  if (!prompt) {
    throw mapUnknownCommandError(new Error("prompt must be a non-empty string."));
  }
  return { prompt, paths };
}

function parseTaskLookupParams(params: unknown): { taskId: string } {
  if (!params || typeof params !== "object") {
    throw mapUnknownCommandError(new Error("Expected an object with taskId."));
  }
  const taskId = typeof (params as Record<string, unknown>).taskId === "string" ? String((params as Record<string, unknown>).taskId).trim() : "";
  if (!taskId) {
    throw mapUnknownCommandError(new Error("taskId must be a non-empty string."));
  }
  return { taskId };
}

function parseTaskListParams(params: unknown): { limit?: number } {
  if (params === undefined || params === null) {
    return {};
  }
  if (typeof params !== "object") {
    throw mapUnknownCommandError(new Error("Expected an object with an optional limit."));
  }
  const raw = (params as Record<string, unknown>).limit;
  if (raw === undefined || raw === null || raw === "") {
    return {};
  }
  const limit = Number(raw);
  if (!Number.isFinite(limit)) {
    throw mapUnknownCommandError(new Error("limit must be numeric when provided."));
  }
  return { limit: Math.trunc(limit) };
}

function parseTaskRespondParams(params: unknown): { taskId: string; optionId?: string; message?: string; approval?: "approved" | "rejected" } {
  if (!params || typeof params !== "object") {
    throw mapUnknownCommandError(new Error("Expected an object with taskId and response fields."));
  }
  const value = params as Record<string, unknown>;
  const taskId = typeof value.taskId === "string" ? value.taskId.trim() : "";
  const optionId = typeof value.optionId === "string" ? value.optionId.trim() : undefined;
  const message = typeof value.message === "string" ? value.message.trim() : undefined;
  const approval = value.approval === "approved" || value.approval === "rejected" ? value.approval : undefined;
  if (!taskId) {
    throw mapUnknownCommandError(new Error("taskId must be a non-empty string."));
  }
  if (!optionId && !message && !approval) {
    throw mapUnknownCommandError(new Error("respond requires optionId, message, or approval."));
  }
  return { taskId, optionId, message, approval };
}
