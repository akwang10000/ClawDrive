import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { getConfig } from "../config";
import { commandFailure } from "../guards/errors";
import { resolveContainedPath } from "../guards/workspace-access";
import { log } from "../logger";
import { StructuredApplyExecutor } from "./apply-executor";
import { classifyClaudeCliFailure } from "./claude-cli";
import { ClaudeCliProvider } from "./claude-provider";
import { classifyCodexCliFailure } from "./codex-cli";
import { CodexCliProvider } from "./codex-provider";
import type { ProviderProbeResult, TaskProvider } from "./provider";
import { buildReadonlyTaskFallback, shouldAttemptReadonlyTaskFallback } from "./readonly-fallback";
import { TaskStorage } from "./storage";
import {
  taskApprovalSummary,
  providerStatusChecking,
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
  TaskBatchActionResult,
  TaskContinuationCandidate,
  TaskExecutionHealth,
  TaskEventRecord,
  TaskListParams,
  TaskMode,
  TaskProviderEvidence,
  TaskRespondParams,
  TaskResponseInput,
  TaskResultPayload,
  TaskRunResult,
  TaskApprovalRequest,
  TaskRuntimeSignal,
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

interface TaskServiceInitializeOptions {
  probeProvider?: boolean;
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
  private providerStatus: ProviderStatusInfo;
  private providerRefreshPromise: Promise<ProviderStatusInfo> | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    options?: TaskServiceOptions
  ) {
    this.options = {
      getConfig: options?.getConfig ?? getConfig,
      createProvider:
        options?.createProvider ??
        ((config) => (config.providerKind === "claude" ? new ClaudeCliProvider(config) : new CodexCliProvider(config))),
      createApplyExecutor: options?.createApplyExecutor ?? (() => new StructuredApplyExecutor()),
      createStorage: options?.createStorage ?? ((rootPath, historyLimit) => new TaskStorage(rootPath, historyLimit)),
      getWorkspacePath: options?.getWorkspacePath ?? (() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null),
      now: options?.now ?? (() => new Date().toISOString()),
    };
    const cfg = this.options.getConfig();
    this.applyExecutor = this.options.createApplyExecutor();
    this.storage = this.createStorage(cfg.tasksHistoryLimit);
    this.provider = this.createProvider();
    this.providerStatus = cfg.providerEnabled
      ? { ready: false, state: "checking", ...providerStatusChecking() }
      : this.mapProbeToStatus({
          ready: false,
          state: "disabled",
          detail: "Provider disabled.",
        });
  }

  get onDidChange(): vscode.Event<void> {
    return this.emitter.event;
  }

  get onDidEmitLifecycle(): vscode.Event<TaskEventRecord> {
    return this.lifecycleEmitter.event;
  }

  async initialize(options?: TaskServiceInitializeOptions): Promise<void> {
    await this.storage.initialize();
    for (const snapshot of await this.storage.listSnapshots()) {
      const normalized = this.normalizeLoadedSnapshot(snapshot);
      if (normalized.state === "running") {
        normalized.state = "interrupted";
        normalized.summary = taskInterruptedSummary();
        normalized.updatedAt = this.options.now();
        normalized.errorCode = null;
        normalized.executionHealth = this.deriveExecutionHealth(normalized.runtimeSignals, "interrupted");
        await this.storage.saveSnapshot(normalized);
        await this.appendEvent(normalized, "interrupted", normalized.summary);
      }
      this.tasks.set(normalized.taskId, normalized);
    }
    if (options?.probeProvider ?? true) {
      await this.refreshProviderStatus();
    }
    this.emitter.fire();
  }

  dispose(): void {
    this.cancelActiveRun("dispose");
    this.emitter.dispose();
    this.lifecycleEmitter.dispose();
  }

  async refreshProviderStatus(): Promise<ProviderStatusInfo> {
    if (this.providerRefreshPromise) {
      return await this.providerRefreshPromise;
    }

    this.providerRefreshPromise = (async () => {
      const config = this.options.getConfig();
      this.storage = this.createStorage(config.tasksHistoryLimit);
      await this.storage.initialize();
      const resolved = await this.resolveActiveProvider(config);
      this.provider = resolved.provider;
      this.providerStatus = this.mapProbeToStatus(resolved.probe);
      this.emitter.fire();
      return this.providerStatus;
    })();

    try {
      return await this.providerRefreshPromise;
    } finally {
      this.providerRefreshPromise = null;
    }
  }

  getProviderStatus(): ProviderStatusInfo {
    return this.providerStatus;
  }

  listTasks(params?: TaskListParams): TaskSnapshot[] {
    const limit = Math.max(1, Math.min(params?.limit ?? 20, 100));
    return this.listAllTasks().slice(0, limit);
  }

  listAllTasks(): TaskSnapshot[] {
    return [...this.tasks.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
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
      executionHealth: snapshot.executionHealth,
      runtimeSignals: snapshot.runtimeSignals,
      approval: snapshot.approval,
      decision: snapshot.decision,
      summary: snapshot.resultSummary,
      output: snapshot.lastOutput,
      providerEvidence: snapshot.providerEvidence,
      events: await this.storage.readEvents(taskId),
    };
  }

  async startTask(params: TaskStartParams): Promise<TaskSnapshot> {
    if (this.providerStatus.state === "checking") {
      await this.refreshProviderStatus();
    }
    this.ensureProviderReady();
    const prompt = params.prompt?.trim();
    if (!prompt) {
      throw commandFailure("INVALID_PARAMS", "prompt must be a non-empty string.");
    }
    if (params.mode !== "analyze" && params.mode !== "plan" && params.mode !== "apply") {
      throw commandFailure("INVALID_PARAMS", "mode must be analyze, plan, or apply.");
    }
    if (params.mode === "analyze" && this.promptLooksLikeWriteRequest(prompt)) {
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
      executionHealth: "clean",
      runtimeSignals: [],
      decision: null,
      approval: null,
      error: null,
      errorCode: null,
      providerKind: this.provider.kind,
      providerSessionId: null,
      resultSummary: null,
      providerEvidence: null,
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
    snapshot.executionHealth = this.deriveExecutionHealth(snapshot.runtimeSignals, "queued");
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
      return await this.waitForTaskSettlement(taskId, ["cancelled", "failed", "interrupted"]);
    }
    if (!this.canCancelTask(snapshot.state)) {
      return snapshot;
    }
    snapshot.state = "cancelled";
    snapshot.summary = taskCancelledSummary();
    snapshot.errorCode = null;
    snapshot.executionHealth = this.deriveExecutionHealth(snapshot.runtimeSignals, "cancelled");
    snapshot.updatedAt = this.options.now();
    this.pendingRuns.delete(taskId);
    await this.storage.saveSnapshot(snapshot);
    await this.appendEvent(snapshot, "cancelled", snapshot.summary);
    this.tasks.set(snapshot.taskId, snapshot);
    this.emitter.fire();
    return snapshot;
  }

  async cancelActiveTasks(): Promise<TaskBatchActionResult> {
    const candidates = this.listAllTasks().filter((task) => this.canCancelTask(task.state));
    let completed = 0;
    let skipped = 0;

    for (const task of candidates) {
      const current = this.tasks.get(task.taskId);
      if (!current || !this.canCancelTask(current.state)) {
        skipped += 1;
        continue;
      }
      await this.cancelTask(current.taskId);
      completed += 1;
    }

    return {
      requested: candidates.length,
      completed,
      skipped,
    };
  }

  async deleteTask(taskId: string): Promise<void> {
    const snapshot = this.getTask(taskId);
    if (!this.canDeleteTask(snapshot.state)) {
      throw commandFailure(
        "TASK_NOT_DELETABLE",
        `Task ${snapshot.taskId} in state ${snapshot.state} cannot be deleted. Only completed, failed, or cancelled tasks can be deleted.`
      );
    }

    this.pendingRuns.delete(taskId);
    await this.storage.deleteTask(taskId);
    this.tasks.delete(taskId);
    this.emitter.fire();
  }

  async deleteTerminalTasks(): Promise<TaskBatchActionResult> {
    const candidates = this.listAllTasks().filter((task) => this.canDeleteTask(task.state));
    let completed = 0;
    let skipped = 0;

    for (const task of candidates) {
      const current = this.tasks.get(task.taskId);
      if (!current || !this.canDeleteTask(current.state)) {
        skipped += 1;
        continue;
      }
      await this.deleteTask(current.taskId);
      completed += 1;
    }

    return {
      requested: candidates.length,
      completed,
      skipped,
    };
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
    snapshot.executionHealth = this.deriveExecutionHealth(snapshot.runtimeSignals, "running");
    snapshot.updatedAt = this.options.now();
    await this.storage.saveSnapshot(snapshot);
    await this.appendEvent(snapshot, trigger.kind === "resume" ? "resumed" : "started", snapshot.summary);
    this.tasks.set(snapshot.taskId, snapshot);
    this.emitter.fire();

    const workspacePath = this.options.getWorkspacePath();
    let transportWatchdog: NodeJS.Timeout | null = null;
    let hardTransportWatchdogDetail: string | null = null;
    const clearTransportWatchdog = () => {
      if (!transportWatchdog) {
        return;
      }
      clearTimeout(transportWatchdog);
      transportWatchdog = null;
    };
    const maybeArmTransportWatchdog = () => {
      if (
        transportWatchdog ||
        !hardTransportWatchdogDetail ||
        !this.shouldAbortForHardTransportWatchdog(snapshot)
      ) {
        return;
      }
      transportWatchdog = setTimeout(() => {
        transportWatchdog = null;
        if (!hardTransportWatchdogDetail || !this.shouldAbortForHardTransportWatchdog(snapshot) || signal.aborted) {
          return;
        }
        const active = this.activeRun;
        if (!active || active.taskId !== snapshot.taskId) {
          return;
        }
        active.controller.abort("provider_transport_watchdog");
      }, this.getHardTransportWatchdogMs());
      transportWatchdog.unref?.();
    };
    try {
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
          clearTransportWatchdog();
          void this.storage.saveSnapshot(snapshot);
          this.tasks.set(snapshot.taskId, snapshot);
          void this.appendEvent(snapshot, "output", "Task output updated.", output);
          this.emitter.fire();
        },
        onRuntimeSignal: (
          signal: Omit<TaskRuntimeSignal, "count" | "lastSeenAt">,
          rawDetail?: string
        ) => {
          const watchdogDetail = this.getHardTransportWatchdogDetail(signal, rawDetail);
          if (watchdogDetail) {
            hardTransportWatchdogDetail = watchdogDetail;
            maybeArmTransportWatchdog();
          }
          void this.persistRuntimeSignal(snapshot, signal, rawDetail);
        },
        onEvidence: (evidence: Partial<TaskProviderEvidence>) => {
          snapshot.providerEvidence = this.mergeProviderEvidence(snapshot.providerEvidence, evidence);
          snapshot.updatedAt = this.options.now();
          if (snapshot.providerEvidence?.sawTurnCompleted || snapshot.lastOutput || snapshot.state !== "running") {
            clearTransportWatchdog();
          } else {
            maybeArmTransportWatchdog();
          }
          void this.storage.saveSnapshot(snapshot);
          this.tasks.set(snapshot.taskId, snapshot);
          this.emitter.fire();
        },
      };

      if (signal.aborted) {
        throw new Error(String(signal.reason ?? "aborted"));
      }

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
        snapshot.executionHealth = this.deriveExecutionHealth(snapshot.runtimeSignals, "cancelled");
        snapshot.updatedAt = this.options.now();
        await this.storage.saveSnapshot(snapshot);
        await this.appendEvent(snapshot, "cancelled", snapshot.summary);
      } else if (reason === "dispose") {
        snapshot.state = "interrupted";
        snapshot.summary = taskInterruptedSummary();
        snapshot.errorCode = null;
        snapshot.executionHealth = this.deriveExecutionHealth(snapshot.runtimeSignals, "interrupted");
        snapshot.updatedAt = this.options.now();
        await this.storage.saveSnapshot(snapshot);
        await this.appendEvent(snapshot, "interrupted", snapshot.summary);
      } else {
        const rawMessage =
          reason === "timeout"
            ? `Task timed out after ${this.options.getConfig().tasksDefaultTimeoutMs}ms.`
            : error instanceof Error
              ? error.message
              : String(error);
        const rawCode =
          reason === "timeout"
            ? "TASK_TIMEOUT"
            : error instanceof Error && "code" in error && typeof error.code === "string"
              ? error.code
              : "TASK_FAILED";
        const failure = this.normalizeFailedTaskOutcome(snapshot, rawCode, rawMessage);
        const isApplyStructuredOutputCompatibilityFailure =
          this.maybeIsClaudeApplyStructuredOutputCompatibilityFailure(snapshot, failure.code, failure.message);
        if (isApplyStructuredOutputCompatibilityFailure) {
          await this.persistRuntimeSignal(
            snapshot,
            {
              code: "PROVIDER_LOCAL_READONLY_FALLBACK",
              severity: "degraded",
              summary: "Provider did not finish cleanly; completed with bounded local workspace analysis.",
              detail: `${failure.code}: ${failure.message}`,
            },
            `${failure.code}: ${failure.message}`
          );
          await this.applyRunResult(snapshot, this.buildMinimalApplyReadonlyFallback(failure.message));
          return;
        }
        const fallback = await this.maybeBuildReadonlyFallback(snapshot, workspacePath, failure.code, failure.message);
        if (fallback) {
          await this.persistRuntimeSignal(
            snapshot,
            {
              code: "PROVIDER_LOCAL_READONLY_FALLBACK",
              severity: "degraded",
              summary: "Provider did not finish cleanly; completed with bounded local workspace analysis.",
              detail: `${failure.code}: ${failure.message}`,
            },
            `${failure.code}: ${failure.message}`
          );
          await this.applyRunResult(snapshot, fallback);
          return;
        }
        snapshot.state = "failed";
        snapshot.errorCode = failure.code;
        snapshot.error = failure.message;
        snapshot.summary = taskFailedSummary(failure.message);
        snapshot.executionHealth = "failed";
        snapshot.updatedAt = this.options.now();
        await this.storage.saveSnapshot(snapshot);
        await this.appendEvent(snapshot, "failed", snapshot.summary, `${failure.code}: ${failure.message}`);
      }
      this.tasks.set(snapshot.taskId, snapshot);
      this.emitter.fire();
    } finally {
      clearTransportWatchdog();
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
    snapshot.providerEvidence = this.mergeProviderEvidence(snapshot.providerEvidence, result.providerEvidence ?? null);
    if (result.executionHealth === "degraded" && result.providerEvidence?.runtimeSignals?.length) {
      for (const runtimeSignal of result.providerEvidence.runtimeSignals) {
        await this.persistRuntimeSignal(snapshot, runtimeSignal, runtimeSignal.detail);
      }
    }
    snapshot.updatedAt = this.options.now();

    if (result.decision) {
      snapshot.state = "waiting_decision";
      snapshot.decision = result.decision;
      snapshot.approval = null;
      snapshot.summary = taskWaitingSummary(result.decision.options.length);
      snapshot.executionHealth = this.deriveResultExecutionHealth(result, "waiting_decision", snapshot.providerEvidence, snapshot.runtimeSignals);
      await this.storage.saveSnapshot(snapshot);
      await this.appendEvent(snapshot, "waiting_decision", snapshot.summary, result.decision.summary);
    } else if (result.approval) {
      snapshot.state = "waiting_approval";
      snapshot.approval = result.approval;
      snapshot.summary = taskWaitingApprovalSummary(result.approval.operations.length);
      snapshot.executionHealth = this.deriveResultExecutionHealth(result, "waiting_approval", snapshot.providerEvidence, snapshot.runtimeSignals);
      await this.storage.saveSnapshot(snapshot);
      await this.appendEvent(snapshot, "waiting_approval", snapshot.summary, taskApprovalSummary(result.approval));
    } else {
      snapshot.state = "completed";
      if (snapshot.mode !== "apply") {
        snapshot.decision = null;
        snapshot.approval = null;
      }
      snapshot.summary = result.summary;
      snapshot.executionHealth = this.deriveResultExecutionHealth(result, "completed", snapshot.providerEvidence, snapshot.runtimeSignals);
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

  private promptLooksLikeWriteRequest(prompt: string): boolean {
    const normalized = prompt.toLowerCase();
    if (
      /\b(read-?only|analysis only|analyze only|analyse only|no changes? yet|keep this as analysis only)\b/.test(normalized) ||
      /\bdo not (?:apply|implement|write|modify|edit|fix|patch|commit|change)\b/.test(normalized) ||
      /\bdon't (?:apply|implement|write|modify|edit|fix|patch|commit|change)\b/.test(normalized) ||
      /\bwithout (?:applying|implementing|writing|modifying|editing|fixing|patching|committing|changing)\b/.test(normalized)
    ) {
      return false;
    }
    return /\b(apply|implement|write|modify|edit|fix|patch|commit)\b/.test(normalized);
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

  private canCancelTask(state: TaskState): boolean {
    return (
      state === "queued" ||
      state === "running" ||
      state === "waiting_decision" ||
      state === "waiting_approval" ||
      state === "interrupted"
    );
  }

  private canDeleteTask(state: TaskState): boolean {
    return state === "completed" || state === "failed" || state === "cancelled";
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

  private async waitForTaskSettlement(taskId: string, states: TaskState[], timeoutMs = 2_000): Promise<TaskSnapshot> {
    const allowed = new Set(states);
    const current = this.tasks.get(taskId);
    if (current && allowed.has(current.state)) {
      return current;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const subscription = this.onDidChange(() => {
        const next = this.tasks.get(taskId);
        if (!next || !allowed.has(next.state)) {
          return;
        }
        settled = true;
        subscription.dispose();
        clearTimeout(timer);
        resolve();
      });
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        subscription.dispose();
        resolve();
      }, timeoutMs);
    });

    return this.getTask(taskId);
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
      const base = providerStatusReady(this.provider.kind === "claude" ? "Claude Code CLI" : "Codex CLI");
      return {
        ready: true,
        state: "ready",
        label: base.label,
        message: base.message,
        detail: probe.detail || base.detail,
      };
    }
    if (probe.state === "missing") {
      return { ready: false, state: "missing", ...providerStatusMissing(probe.detail) };
    }
    return { ready: false, state: "error", ...providerStatusError(probe.detail) };
  }

  private createProvider(): TaskProvider {
    return this.options.createProvider(this.options.getConfig());
  }

  private createProviderForKind(config: ReturnType<typeof getConfig>, providerKind: "codex" | "claude"): TaskProvider {
    return this.options.createProvider({ ...config, providerKind });
  }

  private async resolveActiveProvider(
    config: ReturnType<typeof getConfig>
  ): Promise<{ provider: TaskProvider; probe: ProviderProbeResult }> {
    const selectedProvider = this.createProviderForKind(config, config.providerKind);
    const selectedProbe = await selectedProvider.probe();
    if (!config.providerEnabled || selectedProbe.ready || selectedProbe.state === "disabled" || !config.providerFallbackToAlternate) {
      return { provider: selectedProvider, probe: selectedProbe };
    }

    const alternateKind = config.providerKind === "claude" ? "codex" : "claude";
    const fallbackProvider = this.createProviderForKind(config, alternateKind);
    const fallbackProbe = await fallbackProvider.probe();
    if (!fallbackProbe.ready) {
      return { provider: selectedProvider, probe: selectedProbe };
    }

    return {
      provider: fallbackProvider,
      probe: {
        ...fallbackProbe,
        detail: `Configured ${this.providerKindLabel(config.providerKind)} is unavailable (${selectedProbe.detail}). Falling back to ${this.providerKindLabel(alternateKind)}. ${fallbackProbe.detail}`,
      },
    };
  }

  private createStorage(historyLimit: number): TaskStorage {
    return this.options.createStorage(this.context.globalStorageUri.fsPath, historyLimit);
  }

  private normalizeLoadedSnapshot(snapshot: TaskSnapshot): TaskSnapshot {
    return {
      ...snapshot,
      executionHealth: snapshot.executionHealth ?? this.deriveExecutionHealth(snapshot.runtimeSignals ?? [], snapshot.state),
      runtimeSignals: snapshot.runtimeSignals ?? [],
      approval: snapshot.approval ?? null,
      errorCode: snapshot.errorCode ?? null,
      resultSummary: snapshot.resultSummary ?? null,
      providerSessionId: snapshot.providerSessionId ?? null,
      decision: snapshot.decision ?? null,
      lastOutput: snapshot.lastOutput ?? null,
      error: snapshot.error ?? null,
      providerEvidence: snapshot.providerEvidence ?? null,
    };
  }

  private async respondToApproval(snapshot: TaskSnapshot, response: TaskResponseInput): Promise<TaskSnapshot> {
    if (response.approval === "rejected") {
      snapshot.state = "cancelled";
      snapshot.summary = taskRejectedSummary();
      snapshot.error = null;
      snapshot.errorCode = null;
      snapshot.executionHealth = this.deriveExecutionHealth(snapshot.runtimeSignals, "cancelled");
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
    snapshot.executionHealth = this.deriveExecutionHealth(snapshot.runtimeSignals, "queued");
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

  private async persistRuntimeSignal(
    snapshot: TaskSnapshot,
    signal: Omit<TaskRuntimeSignal, "count" | "lastSeenAt">,
    rawDetail?: string
  ): Promise<void> {
    const now = this.options.now();
    snapshot.runtimeSignals = this.mergeRuntimeSignal(snapshot.runtimeSignals, {
      ...signal,
      count: 1,
      lastSeenAt: now,
    });
    snapshot.executionHealth = this.deriveExecutionHealth(snapshot.runtimeSignals, snapshot.state);
    snapshot.updatedAt = now;
    await this.storage.saveSnapshot(snapshot);
    this.tasks.set(snapshot.taskId, snapshot);
    await this.appendEvent(snapshot, "runtime_signal", signal.summary, rawDetail ?? signal.detail);
    this.emitter.fire();
  }

  private normalizeFailedTaskOutcome(
    snapshot: TaskSnapshot,
    code: string,
    message: string
  ): { code: string; message: string } {
    if (
      ["PROVIDER_AUTH_FAILED", "PROVIDER_MODEL_INVALID", "PROVIDER_MCP_COMPATIBILITY_FAILED"].includes(code)
    ) {
      return { code, message };
    }

    if (["PROVIDER_EXECUTION_FAILED", "TASK_FAILED"].includes(code)) {
      const classified = this.classifyProviderFailure(snapshot.providerKind, new Error(message));
      if (classified.code !== "PROVIDER_EXECUTION_FAILED") {
        return classified;
      }
    }

    const transportSignal = this.findLatestTransportSignal(snapshot.runtimeSignals);
    if (
      !transportSignal ||
      ![
        "PROVIDER_TURN_STALLED",
        "PROVIDER_RESULT_STALLED",
        "PROVIDER_EXECUTION_FAILED",
        "TASK_FAILED",
        "provider_transport_watchdog",
      ].includes(code)
    ) {
      return { code, message };
    }

    const classified = this.classifyProviderFailure(snapshot.providerKind, new Error(transportSignal.detail ?? transportSignal.summary));
    if (classified.code === "PROVIDER_TRANSPORT_FAILED") {
      return classified;
    }
    return {
      code: "PROVIDER_TRANSPORT_FAILED",
      message: transportSignal.summary,
    };
  }

  private maybeIsClaudeApplyStructuredOutputCompatibilityFailure(
    snapshot: TaskSnapshot,
    code: string,
    message: string
  ): boolean {
    if (snapshot.mode !== "apply" || snapshot.providerKind !== "claude" || code !== "PROVIDER_OUTPUT_INVALID") {
      return false;
    }
    const combined = [message, snapshot.providerEvidence?.lastAgentMessagePreview ?? ""].join("\n");
    const normalized = combined.replace(/\\+"/g, '"').replace(/\\+'/g, "'").toLowerCase();
    return (
      /invalid schema for function/i.test(normalized) &&
      (normalized.includes("structuredoutput") || normalized.includes("structured output")) &&
      normalized.includes("json schema") &&
      normalized.includes("type:") &&
      normalized.includes("none")
    );
  }

  private async maybeBuildReadonlyFallback(
    snapshot: TaskSnapshot,
    workspacePath: string | null,
    code: string,
    message: string
  ): Promise<TaskRunResult | null> {
    const isApplyStructuredOutputCompatibilityFailure = this.maybeIsClaudeApplyStructuredOutputCompatibilityFailure(
      snapshot,
      code,
      message
    );

    if (
      (!isApplyStructuredOutputCompatibilityFailure && snapshot.mode === "apply") ||
      ["PROVIDER_AUTH_FAILED", "PROVIDER_MODEL_INVALID", "PROVIDER_MCP_COMPATIBILITY_FAILED"].includes(code) ||
      (!isApplyStructuredOutputCompatibilityFailure &&
        ![
          "PROVIDER_TRANSPORT_FAILED",
          "PROVIDER_TURN_STALLED",
          "PROVIDER_RESULT_STALLED",
          "PROVIDER_FINALIZATION_STALLED",
          "PROVIDER_OUTPUT_EMPTY",
        ].includes(code)) ||
      !shouldAttemptReadonlyTaskFallback({
        mode: snapshot.mode,
        prompt: snapshot.prompt,
        paths: snapshot.paths,
        workspacePath,
      })
    ) {
      return null;
    }

    const fallback = await buildReadonlyTaskFallback({
      mode: snapshot.mode,
      prompt: snapshot.prompt,
      paths: snapshot.paths,
      workspacePath,
    });
    const resolvedFallback = fallback ?? (isApplyStructuredOutputCompatibilityFailure ? this.buildMinimalApplyReadonlyFallback(message) : null);
    if (!resolvedFallback) {
      return null;
    }

    resolvedFallback.providerEvidence = this.mergeProviderEvidence(snapshot.providerEvidence, {
      finalizationPath: snapshot.providerEvidence?.finalizationPath ?? "timeout",
      finalMessageSource: resolvedFallback.providerEvidence?.finalMessageSource ?? snapshot.providerEvidence?.finalMessageSource ?? "none",
      lastAgentMessagePreview:
        resolvedFallback.providerEvidence?.lastAgentMessagePreview ?? snapshot.providerEvidence?.lastAgentMessagePreview ?? null,
      stdoutEventTail: resolvedFallback.providerEvidence?.stdoutEventTail ?? snapshot.providerEvidence?.stdoutEventTail ?? [],
    });

    resolvedFallback.summary =
      snapshot.mode === "plan"
        ? resolvedFallback.summary
        : `${resolvedFallback.summary}${message ? ` (${message})` : ""}`;
    return resolvedFallback;
  }

  private buildMinimalApplyReadonlyFallback(message?: string): TaskRunResult {
    const summary =
      "Provider apply mode was incompatible in this environment, so I prepared a bounded read-only change-review decision first.";
    return {
      summary: `${summary}${message ? ` (${message})` : ""}`,
      output:
        "Fallback Note\nProvider apply mode was incompatible in this environment, so a minimal bounded read-only change-review decision was prepared without repository-specific inspection.",
      decision: {
        summary,
        recommendedOptionId: "option_apply_runtime_review",
        options: [
          {
            id: "option_apply_runtime_review",
            title: "Review Runtime Path First",
            summary:
              "Review the extension entry, routing, task service, and provider files first, then prepare the smallest safe code change proposal before applying anything.",
            recommended: true,
          },
          {
            id: "option_apply_target_review",
            title: "Inspect Target Files First",
            summary:
              "Inspect the likely target files first, then convert the findings into a minimal change proposal.",
            recommended: false,
          },
        ],
      },
    };
  }

  private findLatestTransportSignal(runtimeSignals: TaskRuntimeSignal[]): TaskRuntimeSignal | null {
    const transportSignals = runtimeSignals
      .filter(
        (signal) =>
          signal.code === "PROVIDER_TRANSPORT_FALLBACK" || signal.code === "PROVIDER_TRANSPORT_RUNTIME_WARNING"
      )
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
    return transportSignals[0] ?? null;
  }

  private mergeRuntimeSignal(existing: TaskRuntimeSignal[], incoming: TaskRuntimeSignal): TaskRuntimeSignal[] {
    const index = existing.findIndex(
      (item) =>
        item.code === incoming.code && item.severity === incoming.severity && item.summary === incoming.summary
    );
    if (index < 0) {
      return [...existing, incoming];
    }

    const merged = [...existing];
    const current = merged[index];
    merged[index] = {
      ...current,
      detail: incoming.detail ?? current.detail,
      count: current.count + 1,
      lastSeenAt: incoming.lastSeenAt,
    };
    return merged;
  }

  private mergeProviderEvidence(
    existing: TaskProviderEvidence | null,
    incoming: Partial<TaskProviderEvidence> | null | undefined
  ): TaskProviderEvidence | null {
    if (!incoming) {
      return existing ?? null;
    }
    return {
      sawTurnStarted: incoming.sawTurnStarted ?? existing?.sawTurnStarted ?? false,
      sawTurnCompleted: incoming.sawTurnCompleted ?? existing?.sawTurnCompleted ?? false,
      outputFileStatus: incoming.outputFileStatus ?? existing?.outputFileStatus ?? "not_used",
      finalMessageSource: incoming.finalMessageSource ?? existing?.finalMessageSource ?? "none",
      finalizationPath: incoming.finalizationPath ?? existing?.finalizationPath ?? "none",
      lastAgentMessagePreview:
        incoming.lastAgentMessagePreview ?? existing?.lastAgentMessagePreview ?? null,
      rawStdoutPreview: incoming.rawStdoutPreview ?? existing?.rawStdoutPreview ?? null,
      stdoutEventTail: incoming.stdoutEventTail ?? existing?.stdoutEventTail ?? [],
      runtimeSignals: incoming.runtimeSignals ?? existing?.runtimeSignals,
      fallbackReason: incoming.fallbackReason ?? existing?.fallbackReason ?? null,
    };
  }

  private deriveResultExecutionHealth(
    result: TaskRunResult,
    state: TaskState,
    providerEvidence: TaskProviderEvidence | null,
    runtimeSignals: TaskRuntimeSignal[]
  ): TaskExecutionHealth {
    if (result.executionHealth === "degraded") {
      return "degraded";
    }
    if (state === "completed") {
      return this.deriveCompletedExecutionHealth(runtimeSignals, providerEvidence);
    }
    return this.deriveExecutionHealth(runtimeSignals, state);
  }

  private deriveCompletedExecutionHealth(
    runtimeSignals: TaskRuntimeSignal[],
    providerEvidence: TaskProviderEvidence | null
  ): TaskExecutionHealth {
    if (!this.shouldDiscountTransientStallWarning(runtimeSignals, providerEvidence)) {
      return this.deriveExecutionHealth(runtimeSignals, "completed");
    }
    const filteredSignals = runtimeSignals.filter((signal) => signal.code !== "PROVIDER_RESULT_STALL_WARNING");
    return this.deriveExecutionHealth(filteredSignals, "completed");
  }

  private shouldDiscountTransientStallWarning(
    runtimeSignals: TaskRuntimeSignal[],
    providerEvidence: TaskProviderEvidence | null
  ): boolean {
    if (!providerEvidence?.sawTurnCompleted || providerEvidence.finalMessageSource === "none") {
      return false;
    }
    if (!runtimeSignals.some((signal) => signal.code === "PROVIDER_RESULT_STALL_WARNING")) {
      return false;
    }
    if (runtimeSignals.some((signal) => signal.code === "PROVIDER_LOCAL_READONLY_FALLBACK")) {
      return false;
    }
    return !runtimeSignals.some(
      (signal) =>
        signal.code !== "PROVIDER_RESULT_STALL_WARNING" &&
        (signal.severity === "degraded" || signal.severity === "fatal")
    );
  }

  private deriveExecutionHealth(
    runtimeSignals: TaskRuntimeSignal[],
    state: TaskState
  ): TaskExecutionHealth {
    if (state === "failed") {
      return "failed";
    }
    if (runtimeSignals.some((signal) => signal.severity === "degraded" || signal.severity === "fatal")) {
      return "degraded";
    }
    if (runtimeSignals.some((signal) => signal.severity === "noise")) {
      return "warning";
    }
    return "clean";
  }

  private getHardTransportWatchdogDetail(
    signal: Omit<TaskRuntimeSignal, "count" | "lastSeenAt">,
    rawDetail?: string
  ): string | null {
    if (signal.code !== "PROVIDER_TRANSPORT_RUNTIME_WARNING" && signal.code !== "PROVIDER_TRANSPORT_FALLBACK") {
      return null;
    }
    const detail = rawDetail ?? signal.detail ?? signal.summary;
    const classified = this.classifyProviderFailure(this.provider.kind, new Error(detail));
    return classified.code === "PROVIDER_TRANSPORT_FAILED" ? detail : null;
  }

  private classifyProviderFailure(providerKind: string, error: unknown): { code: string; message: string } {
    if (providerKind === "claude") {
      return classifyClaudeCliFailure(error);
    }
    return classifyCodexCliFailure(error);
  }

  private shouldAbortForHardTransportWatchdog(snapshot: TaskSnapshot): boolean {
    if (snapshot.state !== "running" || snapshot.lastOutput) {
      return false;
    }
    return Boolean(snapshot.providerEvidence?.sawTurnStarted && !snapshot.providerEvidence?.sawTurnCompleted);
  }

  private getHardTransportWatchdogMs(): number {
    const base = Math.floor(this.options.getConfig().tasksDefaultTimeoutMs / 40) || 0;
    return Math.max(4_000, Math.min(8_000, base));
  }

  private providerKindLabel(providerKind: string): string {
    return providerKind === "claude" ? "Claude Code CLI" : "Codex CLI";
  }
}
