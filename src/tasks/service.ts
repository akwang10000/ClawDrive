import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { getConfig } from "../config";
import { commandFailure } from "../guards/errors";
import { resolveContainedPath } from "../guards/workspace-access";
import { log } from "../logger";
import { StructuredApplyExecutor } from "./apply-executor";
import { CodexCliProvider } from "./codex-provider";
import type { ProviderProbeResult, TaskProvider } from "./provider";
import { TaskStorage } from "./storage";
import {
  taskApprovalSummary,
  providerStatusDisabled,
  providerStatusError,
  providerStatusMissing,
  providerStatusReady,
  taskCancelledSummary,
  taskFailedSummary,
  taskInterruptedSummary,
  taskQueuedSummary,
  taskRejectedSummary,
  taskResumePrompt,
  taskStartedSummary,
  taskWaitingApprovalSummary,
  taskWaitingSummary,
  taskWriteBlockedMessage,
} from "./text";
import type {
  ProviderStatusInfo,
  TaskContinuationCandidate,
  TaskEventRecord,
  TaskListParams,
  TaskMode,
  TaskRespondParams,
  TaskResponseInput,
  TaskResultPayload,
  TaskRunResult,
  TaskApprovalRequest,
  TaskSnapshot,
  TaskState,
  TaskStartParams,
} from "./types";

type RunTrigger =
  | { kind: "start" }
  | { kind: "resume"; response: TaskResponseInput; fromState: TaskState }
  | { kind: "apply_approval" };

interface TaskServiceOptions {
  getConfig?: typeof getConfig;
  createProvider?: (config: ReturnType<typeof getConfig>) => TaskProvider;
  createApplyExecutor?: () => StructuredApplyExecutor;
  createStorage?: (rootPath: string, historyLimit: number) => TaskStorage;
  getWorkspacePath?: () => string | null;
  now?: () => string;
}

interface ActiveRun {
  taskId: string;
  controller: AbortController;
  timeout: NodeJS.Timeout | null;
  reason: "cancelled" | "timeout" | "dispose" | null;
}

export class TaskService implements vscode.Disposable {
  private storage: TaskStorage;
  private provider: TaskProvider;
  private readonly applyExecutor: StructuredApplyExecutor;
  private readonly options: Required<TaskServiceOptions>;
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly lifecycleEmitter = new vscode.EventEmitter<TaskEventRecord>();
  private readonly tasks = new Map<string, TaskSnapshot>();
  private readonly pendingRuns = new Map<string, RunTrigger>();
  private activeRun: ActiveRun | null = null;
  private providerStatus: ProviderStatusInfo = this.mapProbeToStatus({
    ready: false,
    state: "disabled",
    detail: "Provider disabled.",
  });

  constructor(
    private readonly context: vscode.ExtensionContext,
    options?: TaskServiceOptions
  ) {
    this.options = {
      getConfig: options?.getConfig ?? getConfig,
      createProvider: options?.createProvider ?? ((config) => new CodexCliProvider(config)),
      createApplyExecutor: options?.createApplyExecutor ?? (() => new StructuredApplyExecutor()),
      createStorage: options?.createStorage ?? ((rootPath, historyLimit) => new TaskStorage(rootPath, historyLimit)),
      getWorkspacePath: options?.getWorkspacePath ?? (() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null),
      now: options?.now ?? (() => new Date().toISOString()),
    };
    const cfg = this.options.getConfig();
    this.applyExecutor = this.options.createApplyExecutor();
    this.storage = this.createStorage(cfg.tasksHistoryLimit);
    this.provider = this.createProvider();
  }

  get onDidChange(): vscode.Event<void> {
    return this.emitter.event;
  }

  get onDidEmitLifecycle(): vscode.Event<TaskEventRecord> {
    return this.lifecycleEmitter.event;
  }

  async initialize(): Promise<void> {
    await this.storage.initialize();
    for (const snapshot of await this.storage.listSnapshots()) {
      const normalized = this.normalizeLoadedSnapshot(snapshot);
      if (normalized.state === "running") {
        normalized.state = "interrupted";
        normalized.summary = taskInterruptedSummary();
        normalized.updatedAt = this.options.now();
        normalized.errorCode = null;
        await this.storage.saveSnapshot(normalized);
        await this.appendEvent(normalized, "interrupted", normalized.summary);
      }
      this.tasks.set(normalized.taskId, normalized);
    }
    await this.refreshProviderStatus();
    this.emitter.fire();
  }

  dispose(): void {
    this.cancelActiveRun("dispose");
    this.emitter.dispose();
    this.lifecycleEmitter.dispose();
  }

  async refreshProviderStatus(): Promise<ProviderStatusInfo> {
    this.storage = this.createStorage(this.options.getConfig().tasksHistoryLimit);
    await this.storage.initialize();
    this.provider = this.createProvider();
    this.providerStatus = this.mapProbeToStatus(await this.provider.probe());
    this.emitter.fire();
    return this.providerStatus;
  }

  getProviderStatus(): ProviderStatusInfo {
    return this.providerStatus;
  }

  listTasks(params?: TaskListParams): TaskSnapshot[] {
    const limit = Math.max(1, Math.min(params?.limit ?? 20, 100));
    return [...this.tasks.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  getTask(taskId: string): TaskSnapshot {
    const snapshot = this.tasks.get(taskId);
    if (!snapshot) {
      throw commandFailure("TASK_NOT_FOUND", `Unknown task: ${taskId}`);
    }
    return snapshot;
  }

  async getTaskResult(taskId: string): Promise<TaskResultPayload> {
    const snapshot = this.getTask(taskId);
    return {
      snapshot,
      approval: snapshot.approval,
      events: await this.storage.readEvents(taskId),
    };
  }

  async startTask(params: TaskStartParams): Promise<TaskSnapshot> {
    this.ensureProviderReady();
    const prompt = params.prompt?.trim();
    if (!prompt) {
      throw commandFailure("INVALID_PARAMS", "prompt must be a non-empty string.");
    }
    if (params.mode !== "analyze" && params.mode !== "plan" && params.mode !== "apply") {
      throw commandFailure("INVALID_PARAMS", "mode must be analyze, plan, or apply.");
    }
    if (/\b(apply|implement|write|modify|edit|fix|patch|commit)\b/i.test(prompt) && params.mode === "analyze") {
      throw commandFailure("TASK_MODE_UNSUPPORTED", taskWriteBlockedMessage());
    }

    const now = this.options.now();
    const snapshot: TaskSnapshot = {
      taskId: randomUUID(),
      title: `${params.mode === "plan" ? "Plan" : params.mode === "apply" ? "Apply" : "Analyze"}: ${this.clip(prompt, 72)}`,
      mode: params.mode,
      state: "queued",
      prompt,
      paths: this.normalizePaths(params.paths ?? []),
      createdAt: now,
      updatedAt: now,
      summary: taskQueuedSummary(params.mode),
      lastOutput: null,
      decision: null,
      approval: null,
      error: null,
      errorCode: null,
      providerKind: this.provider.kind,
      providerSessionId: null,
      resultSummary: null,
    };

    this.tasks.set(snapshot.taskId, snapshot);
    this.pendingRuns.set(snapshot.taskId, { kind: "start" });
    await this.storage.saveSnapshot(snapshot);
    await this.appendEvent(snapshot, "queued", snapshot.summary);
    this.emitter.fire();
    void this.pumpQueue();
    return snapshot;
  }

  async respondToTask(params: TaskRespondParams): Promise<TaskSnapshot> {
    const snapshot = this.getTask(params.taskId);
    const response = this.normalizeResponse(params);

    if (snapshot.state !== "waiting_decision" && snapshot.state !== "waiting_approval" && snapshot.state !== "interrupted") {
      throw commandFailure("TASK_NOT_WAITING", `Task ${snapshot.taskId} is not resumable in state ${snapshot.state}.`);
    }

    if (snapshot.state === "waiting_approval") {
      return await this.respondToApproval(snapshot, response);
    }

    if (response.approval) {
      throw commandFailure("INVALID_PARAMS", `${snapshot.state} does not accept approval responses.`);
    }

    if (snapshot.state === "waiting_decision" && response.optionId) {
      const option = snapshot.decision?.options.find((item) => item.id === response.optionId);
      response.message = taskResumePrompt(option, response.message);
    } else if (!response.message) {
      response.message = taskResumePrompt();
    }

    const fromState = snapshot.state;
    snapshot.state = "queued";
    snapshot.summary = taskQueuedSummary(snapshot.mode);
    snapshot.error = null;
    snapshot.errorCode = null;
    snapshot.updatedAt = this.options.now();
    this.pendingRuns.set(snapshot.taskId, { kind: "resume", response, fromState });
    await this.storage.saveSnapshot(snapshot);
    await this.appendEvent(snapshot, "queued", snapshot.summary);
    this.tasks.set(snapshot.taskId, snapshot);
    this.emitter.fire();
    void this.pumpQueue();
    return snapshot;
  }

  async cancelTask(taskId: string): Promise<TaskSnapshot> {
    const snapshot = this.getTask(taskId);
    if (this.activeRun?.taskId === taskId) {
      this.cancelActiveRun("cancelled");
      return snapshot;
    }
    if (snapshot.state === "completed" || snapshot.state === "failed" || snapshot.state === "cancelled") {
      return snapshot;
    }
    snapshot.state = "cancelled";
    snapshot.summary = taskCancelledSummary();
    snapshot.errorCode = null;
    snapshot.updatedAt = this.options.now();
    this.pendingRuns.delete(taskId);
    await this.storage.saveSnapshot(snapshot);
    await this.appendEvent(snapshot, "cancelled", snapshot.summary);
    this.tasks.set(snapshot.taskId, snapshot);
    this.emitter.fire();
    return snapshot;
  }

  async continueLatestRecommended(): Promise<TaskSnapshot> {
    const waiting = [...this.tasks.values()]
      .filter((task) => task.state === "waiting_decision")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!waiting) {
      throw commandFailure("TASK_NOT_FOUND", "No waiting task is available to continue.");
    }
    const optionId = waiting.decision?.recommendedOptionId ?? undefined;
    return await this.respondToTask(
      optionId
        ? { taskId: waiting.taskId, optionId }
        : { taskId: waiting.taskId, message: taskResumePrompt() }
    );
  }

  async resumeLatestInterrupted(): Promise<TaskSnapshot> {
    const interrupted = this.findLatestTask(["interrupted"]);
    if (!interrupted) {
      throw commandFailure("TASK_NOT_FOUND", "No interrupted task is available to continue.");
    }
    return await this.respondToTask({
      taskId: interrupted.taskId,
      message: taskResumePrompt(),
    });
  }

  listContinuationCandidates(): TaskContinuationCandidate[] {
    const priority: Record<TaskContinuationCandidate["state"], number> = {
      waiting_approval: 0,
      waiting_decision: 1,
      interrupted: 2,
      running: 3,
      queued: 4,
    };

    return [...this.tasks.values()]
      .filter(
        (task): task is TaskSnapshot & { state: TaskContinuationCandidate["state"] } =>
          task.state === "waiting_approval" ||
          task.state === "waiting_decision" ||
          task.state === "interrupted" ||
          task.state === "running" ||
          task.state === "queued"
      )
      .sort((left, right) => {
        const priorityDiff = priority[left.state] - priority[right.state];
        if (priorityDiff !== 0) {
          return priorityDiff;
        }
        return right.updatedAt.localeCompare(left.updatedAt);
      })
      .map((task) => ({
        taskId: task.taskId,
        title: task.title,
        state: task.state,
        updatedAt: task.updatedAt,
        summary: task.summary,
      }));
  }

  getLatestTask(states?: TaskState[]): TaskSnapshot | null {
    return this.findLatestTask(states);
  }

  private async pumpQueue(): Promise<void> {
    if (this.activeRun) {
      return;
    }

    const next = [...this.tasks.values()]
      .filter((task) => task.state === "queued" && this.pendingRuns.has(task.taskId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    if (!next) {
      return;
    }

    const trigger = this.pendingRuns.get(next.taskId);
    if (!trigger) {
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      if (this.activeRun?.taskId === next.taskId) {
        this.activeRun.reason = "timeout";
        controller.abort("timeout");
      }
    }, Math.max(5_000, this.options.getConfig().tasksDefaultTimeoutMs));
    timeout.unref?.();

    this.activeRun = { taskId: next.taskId, controller, timeout, reason: null };
    try {
      await this.runTask(next, trigger, controller.signal);
    } finally {
      if (this.activeRun?.timeout) {
        clearTimeout(this.activeRun.timeout);
      }
      this.activeRun = null;
      void this.pumpQueue();
    }
  }

  private async runTask(snapshot: TaskSnapshot, trigger: RunTrigger, signal: AbortSignal): Promise<void> {
    this.pendingRuns.delete(snapshot.taskId);
    snapshot.state = "running";
    snapshot.summary = taskStartedSummary(snapshot.mode);
    snapshot.error = null;
    snapshot.errorCode = null;
    snapshot.updatedAt = this.options.now();
    await this.storage.saveSnapshot(snapshot);
    await this.appendEvent(snapshot, trigger.kind === "resume" ? "resumed" : "started", snapshot.summary);
    this.tasks.set(snapshot.taskId, snapshot);
    this.emitter.fire();

    try {
      const workspacePath = this.options.getWorkspacePath();
      const callbacks = {
        onSessionId: (sessionId: string) => {
          snapshot.providerSessionId = sessionId;
          snapshot.updatedAt = this.options.now();
          void this.storage.saveSnapshot(snapshot);
          this.tasks.set(snapshot.taskId, snapshot);
          this.emitter.fire();
        },
        onProgress: (summary: string) => {
          snapshot.summary = summary;
          snapshot.updatedAt = this.options.now();
          void this.storage.saveSnapshot(snapshot);
          this.tasks.set(snapshot.taskId, snapshot);
          void this.appendEvent(snapshot, "progress", summary);
          this.emitter.fire();
        },
        onOutput: (output: string) => {
          snapshot.lastOutput = output;
          snapshot.updatedAt = this.options.now();
          void this.storage.saveSnapshot(snapshot);
          this.tasks.set(snapshot.taskId, snapshot);
          void this.appendEvent(snapshot, "output", "Task output updated.", output);
          this.emitter.fire();
        },
      };

      const result =
        trigger.kind === "apply_approval"
          ? await this.applyExecutor.apply(this.requireApproval(snapshot))
          : trigger.kind === "resume"
          ? await this.provider.resumeTask(
              {
                taskId: snapshot.taskId,
                mode: snapshot.mode,
                prompt: snapshot.prompt,
                paths: snapshot.paths,
                workspacePath,
                sessionId: snapshot.providerSessionId,
                resumeFromState: trigger.fromState,
                decision: snapshot.decision,
                approval: snapshot.approval,
              },
              trigger.response,
              callbacks,
              signal
            )
          : await this.provider.startTask(
              {
                taskId: snapshot.taskId,
                mode: snapshot.mode,
                prompt: snapshot.prompt,
                paths: snapshot.paths,
                workspacePath,
                sessionId: snapshot.providerSessionId,
                resumeFromState: null,
                decision: snapshot.decision,
                approval: snapshot.approval,
              },
              callbacks,
              signal
            );

      await this.applyRunResult(snapshot, result);
    } catch (error) {
      const reason = this.activeRun?.reason;
      if (reason === "cancelled") {
        snapshot.state = "cancelled";
        snapshot.summary = taskCancelledSummary();
        snapshot.errorCode = null;
        snapshot.updatedAt = this.options.now();
        await this.storage.saveSnapshot(snapshot);
        await this.appendEvent(snapshot, "cancelled", snapshot.summary);
      } else if (reason === "dispose") {
        snapshot.state = "interrupted";
        snapshot.summary = taskInterruptedSummary();
        snapshot.errorCode = null;
        snapshot.updatedAt = this.options.now();
        await this.storage.saveSnapshot(snapshot);
        await this.appendEvent(snapshot, "interrupted", snapshot.summary);
      } else {
        const message =
          reason === "timeout"
            ? `Task timed out after ${this.options.getConfig().tasksDefaultTimeoutMs}ms.`
            : error instanceof Error
              ? error.message
              : String(error);
        const code =
          reason === "timeout"
            ? "TASK_TIMEOUT"
            : error instanceof Error && "code" in error && typeof error.code === "string"
              ? error.code
              : "TASK_FAILED";
        snapshot.state = "failed";
        snapshot.errorCode = code;
        snapshot.error = message;
        snapshot.summary = taskFailedSummary(message);
        snapshot.updatedAt = this.options.now();
        await this.storage.saveSnapshot(snapshot);
        await this.appendEvent(snapshot, "failed", snapshot.summary, `${code}: ${message}`);
      }
      this.tasks.set(snapshot.taskId, snapshot);
      this.emitter.fire();
    }
  }

  private async applyRunResult(snapshot: TaskSnapshot, result: TaskRunResult): Promise<void> {
    if (result.sessionId) {
      snapshot.providerSessionId = result.sessionId;
    }
    snapshot.lastOutput = result.output ?? snapshot.lastOutput;
    snapshot.resultSummary = result.summary;
    snapshot.error = null;
    snapshot.errorCode = null;
    snapshot.updatedAt = this.options.now();

    if (result.decision) {
      snapshot.state = "waiting_decision";
      snapshot.decision = result.decision;
      snapshot.approval = null;
      snapshot.summary = taskWaitingSummary(result.decision.options.length);
      await this.storage.saveSnapshot(snapshot);
      await this.appendEvent(snapshot, "waiting_decision", snapshot.summary, result.decision.summary);
    } else if (result.approval) {
      snapshot.state = "waiting_approval";
      snapshot.approval = result.approval;
      snapshot.summary = taskWaitingApprovalSummary(result.approval.operations.length);
      await this.storage.saveSnapshot(snapshot);
      await this.appendEvent(snapshot, "waiting_approval", snapshot.summary, taskApprovalSummary(result.approval));
    } else {
      snapshot.state = "completed";
      if (snapshot.mode !== "apply") {
        snapshot.decision = null;
        snapshot.approval = null;
      }
      snapshot.summary = result.summary;
      await this.storage.saveSnapshot(snapshot);
      await this.appendEvent(snapshot, "completed", snapshot.summary);
    }

    this.tasks.set(snapshot.taskId, snapshot);
    this.emitter.fire();
  }

  private normalizePaths(paths: string[]): string[] {
    return paths
      .filter((value) => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => resolveContainedPath(value).path);
  }

  private normalizeResponse(params: TaskRespondParams): TaskResponseInput {
    const optionId = params.optionId?.trim();
    const message = params.message?.trim();
    const approval = params.approval;
    if (!optionId && !message && approval !== "approved" && approval !== "rejected") {
      throw commandFailure("INVALID_PARAMS", "Respond requires optionId, message, or approval.");
    }
    return { optionId: optionId || undefined, message: message || undefined, approval };
  }

  private ensureProviderReady(): void {
    if (!this.providerStatus.ready) {
      throw commandFailure("PROVIDER_NOT_READY", this.providerStatus.detail);
    }
  }

  private findLatestTask(states?: TaskState[]): TaskSnapshot | null {
    const allowed = states ? new Set(states) : null;
    return (
      [...this.tasks.values()]
        .filter((task) => (allowed ? allowed.has(task.state) : true))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
    );
  }

  private clip(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
  }

  private cancelActiveRun(reason: ActiveRun["reason"]): void {
    if (!this.activeRun) {
      return;
    }
    this.activeRun.reason = reason;
    this.activeRun.controller.abort(reason ?? "aborted");
  }

  private async appendEvent(snapshot: TaskSnapshot, type: TaskEventRecord["type"], summary: string, detail?: string): Promise<void> {
    const event: TaskEventRecord = {
      id: randomUUID(),
      taskId: snapshot.taskId,
      at: this.options.now(),
      type,
      state: snapshot.state,
      summary,
      detail,
    };
    await this.storage.appendEvent(event);
    this.lifecycleEmitter.fire(event);
    log(`[task] ${snapshot.taskId} ${type}: ${summary}`);
  }

  private mapProbeToStatus(probe: ProviderProbeResult): ProviderStatusInfo {
    if (probe.state === "disabled") {
      return { ready: false, state: "disabled", ...providerStatusDisabled() };
    }
    if (probe.state === "ready") {
      return { ready: true, state: "ready", ...providerStatusReady("Codex CLI") };
    }
    if (probe.state === "missing") {
      return { ready: false, state: "missing", ...providerStatusMissing(probe.detail) };
    }
    return { ready: false, state: "error", ...providerStatusError(probe.detail) };
  }

  private createProvider(): TaskProvider {
    return this.options.createProvider(this.options.getConfig());
  }

  private createStorage(historyLimit: number): TaskStorage {
    return this.options.createStorage(this.context.globalStorageUri.fsPath, historyLimit);
  }

  private normalizeLoadedSnapshot(snapshot: TaskSnapshot): TaskSnapshot {
    return {
      ...snapshot,
      approval: snapshot.approval ?? null,
      errorCode: snapshot.errorCode ?? null,
      resultSummary: snapshot.resultSummary ?? null,
      providerSessionId: snapshot.providerSessionId ?? null,
      decision: snapshot.decision ?? null,
      lastOutput: snapshot.lastOutput ?? null,
      error: snapshot.error ?? null,
    };
  }

  private async respondToApproval(snapshot: TaskSnapshot, response: TaskResponseInput): Promise<TaskSnapshot> {
    if (response.approval === "rejected") {
      snapshot.state = "cancelled";
      snapshot.summary = taskRejectedSummary();
      snapshot.error = null;
      snapshot.errorCode = null;
      snapshot.updatedAt = this.options.now();
      await this.storage.saveSnapshot(snapshot);
      await this.appendEvent(snapshot, "rejected", snapshot.summary, snapshot.approval?.summary);
      this.tasks.set(snapshot.taskId, snapshot);
      this.emitter.fire();
      return snapshot;
    }

    if (response.approval !== "approved") {
      throw commandFailure("INVALID_PARAMS", "waiting_approval requires approval=approved or approval=rejected.");
    }

    snapshot.state = "queued";
    snapshot.summary = taskQueuedSummary(snapshot.mode);
    snapshot.error = null;
    snapshot.errorCode = null;
    snapshot.updatedAt = this.options.now();
    this.pendingRuns.set(snapshot.taskId, { kind: "apply_approval" });
    await this.storage.saveSnapshot(snapshot);
    await this.appendEvent(snapshot, "approved", snapshot.summary, snapshot.approval?.summary);
    this.tasks.set(snapshot.taskId, snapshot);
    this.emitter.fire();
    void this.pumpQueue();
    return snapshot;
  }

  private requireApproval(snapshot: TaskSnapshot): TaskApprovalRequest {
    if (!snapshot.approval) {
      throw commandFailure("APPLY_PRECONDITION_FAILED", `Task ${snapshot.taskId} does not have an approval payload.`);
    }
    return snapshot.approval;
  }
}
