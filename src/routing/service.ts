import { collectOperatorStatus } from "../diagnostics";
import type { ConnectionState } from "../gateway-client";
import { getCurrentLocale } from "../i18n";
import { taskExecutionHealthLabel, taskResumePrompt, taskStateLabel } from "../tasks/text";
import type { ProviderStatusInfo } from "../tasks/types";
import { TaskService } from "../tasks/service";
import {
  classifyIntent,
  selectHighestPriorityCandidates,
  shouldApprove,
  shouldReject,
  shouldUseRecommended,
  type InspectAction,
} from "./classifier";
import { inspectExtensionWiring } from "./extension-audit";
import { inspectGroundedDirectory, inspectGroundedFiles, inspectGroundedRepository } from "./grounded-summary";
import { inspectRuntimeFlow } from "./runtime-flow-audit";
import { inspectSearchLite } from "./search-lite";
import { continuationCandidateToChoice, type AgentRouteRequest, type AgentRouteResponse } from "./types";
import { createWorkspaceInspector, type WorkspaceInspector } from "./workspace-inspector";

interface AgentRouteServiceOptions {
  taskService: TaskService;
  getConnectionState: () => ConnectionState;
  getProviderStatus: () => ProviderStatusInfo;
  inspector?: WorkspaceInspector;
}

export class AgentRouteService {
  private readonly inspector: WorkspaceInspector;

  constructor(private readonly options: AgentRouteServiceOptions) {
    this.inspector = options.inspector ?? createWorkspaceInspector();
  }

  async route(request: AgentRouteRequest): Promise<AgentRouteResponse> {
    const prompt = request.prompt.trim();
    const paths = normalizePaths(request.paths);
    const intent = classifyIntent(prompt, paths);

    switch (intent.type) {
      case "continue":
        return await this.routeContinue(prompt);
      case "plan":
        return await this.routeTask(prompt, paths, "plan");
      case "apply":
        return await this.routeTask(prompt, paths, "apply");
      case "diagnose":
        return await this.routeDiagnose();
      case "blocked":
        return this.routeBlocked();
      case "inspect":
        return await this.routeInspect(intent.action);
      default:
        return await this.routeTask(prompt, paths, "analyze");
    }
  }

  private async routeTask(prompt: string, paths: string[], mode: "analyze" | "plan" | "apply"): Promise<AgentRouteResponse> {
    const snapshot = await this.options.taskService.startTask({ prompt, mode, paths });
    return {
      kind: "task",
      route: mode,
      message:
        mode === "plan"
          ? text("I started a planning task.", "\u6211\u5df2\u7ecf\u542f\u52a8\u4e86\u4e00\u4e2a\u89c4\u5212\u4efb\u52a1\u3002")
          : mode === "apply"
            ? text("I started an apply task.", "\u6211\u5df2\u7ecf\u542f\u52a8\u4e86\u4e00\u4e2a\u4fee\u6539\u6267\u884c\u4efb\u52a1\u3002")
          : text("I started an analysis task.", "\u6211\u5df2\u7ecf\u542f\u52a8\u4e86\u4e00\u4e2a\u5206\u6790\u4efb\u52a1\u3002"),
      data: snapshot,
    };
  }

  private async routeContinue(prompt: string): Promise<AgentRouteResponse> {
    const candidates = this.options.taskService.listContinuationCandidates();
    if (!candidates.length) {
      return {
        kind: "direct_result",
        route: "continue",
        message: text("There is no recent task to continue.", "\u5f53\u524d\u6ca1\u6709\u53ef\u4ee5\u7ee7\u7eed\u7684\u6700\u8fd1\u4efb\u52a1\u3002"),
      };
    }

    const explicitApproval = shouldApprove(prompt) || shouldReject(prompt);
    const approvalCandidates = candidates.filter((candidate) => candidate.state === "waiting_approval");
    const eligibleCandidates = explicitApproval
      ? approvalCandidates
      : candidates.filter((candidate) => candidate.state !== "waiting_approval");

    if (explicitApproval && !eligibleCandidates.length) {
      return {
        kind: "direct_result",
        route: "continue",
        message: text(
          "There is no recent task waiting for approval.",
          "\u5f53\u524d\u6ca1\u6709\u6700\u8fd1\u7684\u5f85\u6279\u51c6\u4efb\u52a1\u3002"
        ),
      };
    }

    if (!explicitApproval && !eligibleCandidates.length && approvalCandidates.length) {
      return {
        kind: "direct_result",
        route: "continue",
        message: text(
          "The latest task is waiting for explicit approval. Approve or reject it first.",
          "\u6700\u8fd1\u7684\u4efb\u52a1\u6b63\u5728\u7b49\u5f85\u660e\u786e\u6279\u51c6\uff0c\u8bf7\u5148\u6279\u51c6\u6216\u62d2\u7edd\u3002"
        ),
      };
    }

    const highestPriority = selectHighestPriorityCandidates(eligibleCandidates);
    if (highestPriority.length > 1) {
      return {
        kind: "clarify",
        route: "continue",
        message: text(
          "There are multiple recent tasks that could be continued. Choose one.",
          "\u6709\u591a\u4e2a\u6700\u8fd1\u4efb\u52a1\u90fd\u53ef\u80fd\u662f\u4f60\u8981\u7ee7\u7eed\u7684\uff0c\u8bf7\u5148\u9009\u4e00\u4e2a\u3002"
        ),
        data: highestPriority.map(continuationCandidateToChoice),
      };
    }

    const candidate = highestPriority[0];
    if (candidate.state === "waiting_approval") {
      const snapshot = await this.options.taskService.respondToTask({
        taskId: candidate.taskId,
        approval: shouldReject(prompt) ? "rejected" : "approved",
      });
      return {
        kind: "task",
        route: "continue",
        message: shouldReject(prompt)
          ? text(
              "I rejected the latest waiting apply task.",
              "\u6211\u5df2\u7ecf\u62d2\u7edd\u4e86\u6700\u8fd1\u7684\u5f85\u6279\u51c6\u4fee\u6539\u4efb\u52a1\u3002"
            )
          : text(
              "I approved the latest waiting apply task.",
              "\u6211\u5df2\u7ecf\u6279\u51c6\u4e86\u6700\u8fd1\u7684\u5f85\u6279\u51c6\u4fee\u6539\u4efb\u52a1\u3002"
            ),
        data: snapshot,
      };
    }

    if (candidate.state === "waiting_decision") {
      const waitingTask = this.options.taskService.getTask(candidate.taskId);
      const useRecommended = shouldUseRecommended(prompt) || Boolean(waitingTask.decision?.recommendedOptionId);
      const snapshot = useRecommended
        ? await this.options.taskService.continueLatestRecommended()
        : await this.options.taskService.respondToTask({ taskId: waitingTask.taskId, message: taskResumePrompt() });
      return {
        kind: "task",
        route: "continue",
        message: useRecommended
          ? text(
              "I continued the latest waiting task with the recommended option.",
              "\u6211\u5df2\u7ecf\u6309\u63a8\u8350\u9009\u9879\u7ee7\u7eed\u4e86\u6700\u8fd1\u7684\u7b49\u5f85\u4efb\u52a1\u3002"
            )
          : text("I continued the latest waiting task.", "\u6211\u5df2\u7ecf\u7ee7\u7eed\u4e86\u6700\u8fd1\u7684\u7b49\u5f85\u4efb\u52a1\u3002"),
        data: snapshot,
      };
    }

    if (candidate.state === "interrupted") {
      const snapshot = await this.options.taskService.resumeLatestInterrupted();
      return {
        kind: "task",
        route: "continue",
        message: text(
          "I resumed the latest interrupted task.",
          "\u6211\u5df2\u7ecf\u6062\u590d\u4e86\u6700\u8fd1\u88ab\u4e2d\u65ad\u7684\u4efb\u52a1\u3002"
        ),
        data: snapshot,
      };
    }

    const snapshot = this.options.taskService.getTask(candidate.taskId);
    return {
      kind: "task",
      route: "continue",
      message:
        candidate.state === "running"
          ? text("The latest task is already running.", "\u6700\u8fd1\u7684\u4efb\u52a1\u6b63\u5728\u8fd0\u884c\u4e2d\u3002")
          : text("The latest task is already queued.", "\u6700\u8fd1\u7684\u4efb\u52a1\u5df2\u7ecf\u5728\u961f\u5217\u91cc\u4e86\u3002"),
      data: snapshot,
    };
  }

  private async routeDiagnose(): Promise<AgentRouteResponse> {
    const recentTasks = this.options.taskService.listTasks({ limit: 20 });
    const latestFailedTask = recentTasks.find((task) => task.state === "failed") ?? null;
    const latestActiveTask =
      recentTasks.find(
        (task) =>
          task.state === "waiting_approval" ||
          task.state === "waiting_decision" ||
          task.state === "running" ||
          task.state === "queued" ||
          task.state === "interrupted"
      ) ?? null;
    const latestCompletedWithWarnings =
      recentTasks.find(
        (task) =>
          task.state === "completed" && (task.executionHealth === "warning" || task.executionHealth === "degraded")
      ) ?? null;
    const operatorStatus = await collectOperatorStatus(
      this.options.getConnectionState(),
      this.options.getProviderStatus(),
      latestFailedTask ?? latestCompletedWithWarnings ?? latestActiveTask
    );

    const lines = [
      text(
        `Connection: ${operatorStatus.connectionState}.`,
        `\u8fde\u63a5\u72b6\u6001\uff1A${taskStateLikeLabel(operatorStatus.connectionState)}\u3002`
      ),
      text(
        `Callable: ${operatorStatus.callable ? "ready" : "blocked"}.`,
        `\u53ef\u8c03\u7528\u72b6\u6001\uff1A${operatorStatus.callable ? "\u5c31\u7eea" : "\u53d7\u9650"}\u3002`
      ),
      text(
        `Provider: ${operatorStatus.providerStatus.label}.`,
        `Provider \u72b6\u6001\uff1A${operatorStatus.providerStatus.label}\u3002`
      ),
    ];

    if (!operatorStatus.providerReady) {
      lines.push(operatorStatus.providerStatus.detail);
    }

    if (latestFailedTask) {
      lines.push(
        text(
          `Latest failed task: ${latestFailedTask.title}. ${operatorStatus.latestFailureSummary ?? latestFailedTask.summary}`,
          `\u6700\u8fd1\u5931\u8d25\u7684\u4efb\u52a1\uff1A${latestFailedTask.title}\u3002${operatorStatus.latestFailureSummary ?? latestFailedTask.summary}`
        )
      );
    } else if (latestCompletedWithWarnings) {
      lines.push(
        text(
          `Latest completed task: ${latestCompletedWithWarnings.title} (${taskExecutionHealthLabel(latestCompletedWithWarnings.executionHealth)}). ${operatorStatus.latestNonFatalSummary ?? latestCompletedWithWarnings.summary}`,
          `\u6700\u8fd1\u5b8c\u6210\u7684\u4efb\u52a1\uff1A${latestCompletedWithWarnings.title}\uff08${taskStateLabel(latestCompletedWithWarnings.state)} / ${taskExecutionHealthLabel(latestCompletedWithWarnings.executionHealth)}\uff09\u3002${operatorStatus.latestNonFatalSummary ?? latestCompletedWithWarnings.summary}`
        )
      );
    } else if (latestActiveTask) {
      lines.push(
        text(
          `Latest task: ${latestActiveTask.title} (${taskStateLabel(latestActiveTask.state)}).`,
          `\u6700\u8fd1\u4efb\u52a1\uff1A${latestActiveTask.title}\uff08${taskStateLabel(latestActiveTask.state)}\uff09\u3002`
        )
      );
    }

    if (operatorStatus.actionableHint) {
      lines.push(operatorStatus.actionableHint);
    }

    return {
      kind: "direct_result",
      route: "diagnose",
      message: lines.join("\n"),
      data: operatorStatus,
    };
  }

  private routeBlocked(): AgentRouteResponse {
    return {
      kind: "blocked",
      route: "blocked",
      message: text(
        "This write intent is not supported in the current apply slice.",
        "\u5f53\u524d apply \u91cc\u7a0b\u7891\u8fd8\u4e0d\u652f\u6301\u8fd9\u79cd\u5199\u5165\u610f\u56fe\u3002"
      ),
      data: {
        suggestedMode: "plan",
      },
    };
  }

  private async routeInspect(action: InspectAction): Promise<AgentRouteResponse> {
    switch (action.type) {
      case "workspace":
        return {
          kind: "direct_result",
          route: "inspect",
          message: text("I checked the current workspace.", "\u6211\u5df2\u7ecf\u67e5\u770b\u4e86\u5f53\u524d\u5de5\u4f5c\u533a\u3002"),
          data: await this.inspector.workspaceInfo(),
        };
      case "editor":
        return {
          kind: "direct_result",
          route: "inspect",
          message: text("I inspected the active editor.", "\u6211\u5df2\u7ecf\u67e5\u770b\u4e86\u5f53\u524d\u7f16\u8f91\u5668\u3002"),
          data: await this.inspector.activeEditor(),
        };
      case "diagnostics":
        return {
          kind: "direct_result",
          route: "inspect",
          message: text("I collected the current diagnostics.", "\u6211\u5df2\u7ecf\u6536\u96c6\u4e86\u5f53\u524d\u8bca\u65ad\u4fe1\u606f\u3002"),
          data: await this.inspector.diagnosticsGet(action.path ? { path: action.path } : undefined),
        };
      case "file":
        return {
          kind: "direct_result",
          route: "inspect",
          message: text("I read the requested file.", "\u6211\u5df2\u7ecf\u8bfb\u53d6\u4e86\u8bf7\u6c42\u7684\u6587\u4ef6\u3002"),
          data: await this.inspector.fileRead({ path: action.path }),
        };
      case "directory":
        return {
          kind: "direct_result",
          route: "inspect",
          message: text("I listed the requested directory.", "\u6211\u5df2\u7ecf\u5217\u51fa\u4e86\u8bf7\u6c42\u7684\u76ee\u5f55\u3002"),
          data: await this.inspector.directoryList({ path: action.path }),
        };
      case "search_lite": {
        const result = await inspectSearchLite(this.inspector, action.query);
        return {
          kind: "direct_result",
          route: "inspect",
          message: result.summary,
          data: result,
        };
      }
      case "runtime_flow_audit": {
        const result = await inspectRuntimeFlow(this.inspector);
        return {
          kind: "direct_result",
          route: "inspect",
          message: result.summary,
          data: result,
        };
      }
      case "repository_summary": {
        const result = await inspectGroundedRepository(this.inspector, undefined, action.focusPath);
        return {
          kind: "direct_result",
          route: "inspect",
          message: result.summary,
          data: result,
        };
      }
      case "directory_summary": {
        const summary = await inspectGroundedDirectory(this.inspector, action.path);
        return {
          kind: "direct_result",
          route: "inspect",
          message: summary.summary,
          data: summary,
        };
      }
      case "grounded_summary": {
        const summary = await inspectGroundedFiles(this.inspector, action.paths);
        return {
          kind: "direct_result",
          route: "inspect",
          message: summary.summary,
          data: summary,
        };
      }
      case "extension_audit": {
        const audit = await inspectExtensionWiring(this.inspector);
        return {
          kind: "direct_result",
          route: "inspect",
          message: audit.summary,
          data: audit,
        };
      }
    }
  }
}

function normalizePaths(paths: string[] | undefined): string[] {
  return (paths ?? []).filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean);
}

function text(en: string, zh: string): string {
  return getCurrentLocale() === "en" ? en : zh;
}

function taskStateLikeLabel(state: ConnectionState): string {
  if (state === "connected") {
    return text("Connected", "\u5df2\u8fde\u63a5");
  }
  if (state === "connecting") {
    return text("Connecting", "\u8fde\u63a5\u4e2d");
  }
  return text("Disconnected", "\u672a\u8fde\u63a5");
}
