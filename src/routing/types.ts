import type { TaskContinuationCandidate, TaskResultPayload, TaskSnapshot, TaskState } from "../tasks/types";

export interface AgentRouteRequest {
  prompt: string;
  paths?: string[];
}

export type AgentRouteKind = "direct_result" | "task" | "task_result" | "blocked" | "clarify";

export type AgentRouteTarget = "inspect" | "analyze" | "plan" | "apply" | "continue" | "diagnose" | "claude_vscode" | "blocked";

export interface AgentRouteTaskChoice {
  taskId: string;
  title: string;
  state: TaskState;
  updatedAt: string;
  summary: string;
}

export type AgentRouteResponse =
  | {
      kind: "direct_result";
      route: "inspect" | "continue" | "diagnose" | "claude_vscode";
      message: string;
      data?: unknown;
    }
  | {
      kind: "task";
      route: "analyze" | "plan" | "apply" | "continue";
      message: string;
      data: TaskSnapshot;
    }
  | {
      kind: "task_result";
      route: "continue";
      message: string;
      data: TaskResultPayload;
    }
  | {
      kind: "blocked";
      route: "blocked";
      message: string;
      data: {
        suggestedMode: "plan";
      };
    }
  | {
      kind: "clarify";
      route: "continue";
      message: string;
      data: AgentRouteTaskChoice[];
    };

export function continuationCandidateToChoice(candidate: TaskContinuationCandidate): AgentRouteTaskChoice {
  return {
    taskId: candidate.taskId,
    title: candidate.title,
    state: candidate.state,
    updatedAt: candidate.updatedAt,
    summary: candidate.summary,
  };
}
