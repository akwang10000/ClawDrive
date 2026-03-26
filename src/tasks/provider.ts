import type {
  TaskApprovalRequest,
  TaskDecisionRequest,
  TaskMode,
  TaskProviderEvidence,
  TaskResponseInput,
  TaskRunResult,
  TaskRuntimeSignal,
  TaskState,
} from "./types";

export interface ProviderProbeResult {
  ready: boolean;
  state: "disabled" | "ready" | "missing" | "error";
  detail: string;
}

export interface ProviderRunContext {
  taskId: string;
  mode: TaskMode;
  prompt: string;
  paths: string[];
  workspacePath: string | null;
  sessionId?: string | null;
  resumeFromState?: TaskState | null;
  decision?: TaskDecisionRequest | null;
  approval?: TaskApprovalRequest | null;
}

export interface ProviderRunCallbacks {
  onSessionId: (sessionId: string) => void;
  onProgress: (summary: string) => void;
  onOutput: (output: string) => void;
  onRuntimeSignal: (signal: Omit<TaskRuntimeSignal, "count" | "lastSeenAt">, rawDetail?: string) => void;
  onEvidence: (evidence: Partial<TaskProviderEvidence>) => void;
}

export interface TaskProvider {
  readonly kind: string;
  probe(): Promise<ProviderProbeResult>;
  startTask(context: ProviderRunContext, callbacks: ProviderRunCallbacks, signal: AbortSignal): Promise<TaskRunResult>;
  resumeTask(
    context: ProviderRunContext,
    response: TaskResponseInput,
    callbacks: ProviderRunCallbacks,
    signal: AbortSignal
  ): Promise<TaskRunResult>;
}
