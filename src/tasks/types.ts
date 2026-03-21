export type TaskState =
  | "queued"
  | "running"
  | "waiting_decision"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type TaskMode = "analyze" | "plan";

export type TaskEventType =
  | "queued"
  | "started"
  | "resumed"
  | "progress"
  | "output"
  | "waiting_decision"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface TaskDecisionOption {
  id: string;
  title: string;
  summary: string;
  recommended: boolean;
}

export interface TaskDecisionRequest {
  summary: string;
  options: TaskDecisionOption[];
  recommendedOptionId: string | null;
}

export interface TaskSnapshot {
  taskId: string;
  title: string;
  mode: TaskMode;
  state: TaskState;
  prompt: string;
  paths: string[];
  createdAt: string;
  updatedAt: string;
  summary: string;
  lastOutput: string | null;
  decision: TaskDecisionRequest | null;
  error: string | null;
  errorCode: string | null;
  providerKind: string;
  providerSessionId: string | null;
  resultSummary: string | null;
}

export interface TaskEventRecord {
  id: string;
  taskId: string;
  at: string;
  type: TaskEventType;
  state: TaskState;
  summary: string;
  detail?: string;
}

export interface TaskResultPayload {
  snapshot: TaskSnapshot;
  events: TaskEventRecord[];
}

export interface TaskContinuationCandidate {
  taskId: string;
  title: string;
  state: Extract<TaskState, "waiting_decision" | "interrupted" | "running" | "queued">;
  updatedAt: string;
  summary: string;
}

export interface TaskStartParams {
  prompt: string;
  mode: TaskMode;
  paths?: string[];
}

export interface TaskRespondParams {
  taskId: string;
  optionId?: string;
  message?: string;
}

export interface TaskCancelParams {
  taskId: string;
}

export interface TaskLookupParams {
  taskId: string;
}

export interface TaskListParams {
  limit?: number;
}

export interface TaskResponseInput {
  optionId?: string;
  message?: string;
}

export interface ProviderStatusInfo {
  ready: boolean;
  state: "disabled" | "ready" | "missing" | "error";
  label: string;
  message: string;
  detail: string;
}

export interface TaskRunResult {
  sessionId?: string | null;
  summary: string;
  output?: string | null;
  decision?: TaskDecisionRequest | null;
}
