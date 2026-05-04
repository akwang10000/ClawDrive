export type TaskState =
  | "queued"
  | "running"
  | "waiting_decision"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type TaskMode = "analyze" | "plan" | "apply";

export type TaskRuntimeSignalSeverity = "noise" | "degraded" | "fatal";

export type TaskExecutionHealth = "clean" | "warning" | "degraded" | "failed";

export type TaskEventType =
  | "queued"
  | "started"
  | "resumed"
  | "progress"
  | "output"
  | "waiting_decision"
  | "waiting_approval"
  | "approved"
  | "rejected"
  | "runtime_signal"
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

export interface WriteFileApplyOperation {
  type: "write_file";
  path: string;
  content: string;
}

export interface ReplaceTextApplyOperation {
  type: "replace_text";
  path: string;
  oldText: string;
  newText: string;
}

export type ApplyOperation = WriteFileApplyOperation | ReplaceTextApplyOperation;

export interface TaskApprovalRequest {
  summary: string;
  operations: ApplyOperation[];
}

export interface TaskRuntimeSignal {
  code: string;
  severity: TaskRuntimeSignalSeverity;
  summary: string;
  detail?: string;
  count: number;
  lastSeenAt: string;
}

export interface TaskProviderEvidenceRuntimeSignal {
  code: string;
  severity: TaskRuntimeSignalSeverity;
  summary: string;
  detail?: string;
}

export interface TaskProviderEvidence {
  sawTurnStarted: boolean;
  sawTurnCompleted: boolean;
  outputFileStatus: "not_used" | "missing" | "empty" | "present";
  finalMessageSource:
    | "none"
    | "output_file"
    | "stream_capture"
    | "stdout_scan"
    | "direct_message"
    | "embedded_json";
  finalizationPath: "none" | "output_file" | "stream_capture" | "stdout_scan" | "embedded_json" | "timeout";
  lastAgentMessagePreview: string | null;
  rawStdoutPreview?: string | null;
  stdoutEventTail: string[];
  runtimeSignals?: TaskProviderEvidenceRuntimeSignal[];
  fallbackReason?: string | null;
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
  executionHealth: TaskExecutionHealth;
  runtimeSignals: TaskRuntimeSignal[];
  decision: TaskDecisionRequest | null;
  approval: TaskApprovalRequest | null;
  error: string | null;
  errorCode: string | null;
  providerKind: string;
  providerSessionId: string | null;
  resultSummary: string | null;
  providerEvidence: TaskProviderEvidence | null;
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
  executionHealth: TaskExecutionHealth;
  runtimeSignals: TaskRuntimeSignal[];
  approval: TaskApprovalRequest | null;
  decision: TaskDecisionRequest | null;
  summary: string | null;
  output: string | null;
  providerEvidence: TaskProviderEvidence | null;
  events: TaskEventRecord[];
}

export interface TaskContinuationCandidate {
  taskId: string;
  title: string;
  state: Extract<TaskState, "waiting_approval" | "waiting_decision" | "interrupted" | "running" | "queued">;
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
  approval?: "approved" | "rejected";
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

export interface TaskBatchActionResult {
  requested: number;
  completed: number;
  skipped: number;
}

export interface TaskResponseInput {
  optionId?: string;
  message?: string;
  approval?: "approved" | "rejected";
}

export interface ProviderStatusInfo {
  ready: boolean;
  state: "disabled" | "checking" | "ready" | "missing" | "error";
  label: string;
  message: string;
  detail: string;
}

export interface TaskRunResult {
  sessionId?: string | null;
  summary: string;
  output?: string | null;
  executionHealth?: TaskExecutionHealth;
  decision?: TaskDecisionRequest | null;
  approval?: TaskApprovalRequest | null;
  providerEvidence?: Partial<TaskProviderEvidence> | null;
}
